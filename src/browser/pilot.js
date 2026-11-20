// The autopilot's hands and eyes (Phase 16, docs/JEV.md, decision #111). Ported from browser-use/jev-ultrafast
// (MIT, © 2026 Browser Use — snapshot.js / browser.py): one in-page read gives every visible control with its live value
// and checked/selected state, each real DOM node gets a code-owned id (a WeakMap, not a model-made selector), and before
// any input the target is re-checked — same page, same form values, same node and nearby context, visible, enabled and
// not covered — then clicked at its current centre. Password, file and hidden inputs are never offered.
// Adapted to Playwright on Jess's own session page (src/browser/session.js).

// Runs in the page. Returns { url, title, text, actions[], page_key, guards, marker } or null while navigating.
const SNAPSHOT_JS = `(() => {
  if (!document.body) return null;
  const cache = window.__jbPilot ||= { ids: new WeakMap(), nodes: new Map(), next: 1 };
  const identity = e => { if (!cache.ids.has(e)) cache.ids.set(e, cache.next++); const id = cache.ids.get(e); cache.nodes.set(id, e); return id; };
  for (const [id, e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  const safe = e => !['password', 'file', 'hidden'].includes(e.type) && e.autocomplete !== 'cc-number' && !/card|cvc|cvv|iban/i.test(e.name || '');
  const visible = e => !e.closest('[aria-hidden="true"],[inert]') && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const name = (e, seen = new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced = (e.getAttribute('aria-labelledby') || '').split(/\\s+/).map(id => name(document.getElementById(id), seen)).filter(Boolean).join(' ');
    return referenced || e.getAttribute('aria-label') || [...(e.labels || [])].map(l => name(l, seen)).filter(Boolean).join(' ')
      || (['button', 'submit', 'reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt')
      || (e.tagName === 'INPUT' ? '' : [...e.childNodes].map(n => n.nodeType === 3 ? n.textContent
        : n.nodeType === 1 && n.getAttribute('aria-hidden') !== 'true' ? name(n, seen) : '').join(' ').replace(/\\s+/g, ' ').trim())
      || e.getAttribute('title') || e.getAttribute('placeholder') || '';
  };
  const roles = ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemradio', 'option', 'gridcell', 'combobox', 'textbox', 'searchbox', 'spinbutton'];
  const selector = 'a[href],button,input,textarea,select,summary,[contenteditable="true"],' + roles.map(r => '[role="' + r + '"]').join(',');
  const role = e => {
    const explicit = e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName === 'BUTTON' || e.tagName === 'SUMMARY') return 'button';
    if (e.tagName === 'A') return 'link';
    if (e.tagName === 'SELECT') return 'combobox';
    if (e.tagName === 'TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName === 'INPUT') {
      if (['checkbox', 'radio'].includes(e.type)) return e.type;
      if (['button', 'submit', 'reset', 'image'].includes(e.type)) return 'button';
      if (e.type === 'search') return 'searchbox';
      if (e.type === 'number') return 'spinbutton';
      if (['text', 'email', 'url', 'tel', 'date', ''].includes(e.type)) return 'textbox';
    }
    return null;
  };
  cache.pageKey = () => [performance.timeOrigin, location.href, scrollX, scrollY, innerWidth, innerHeight,
    [...document.querySelectorAll('input,textarea,select')].filter(safe).map(e => [identity(e), e.value, e.checked, e.selectedIndex, e.disabled, e.readOnly])];
  cache.guard = e => {
    if (!e?.isConnected || !visible(e)) return null;
    const scope = e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [identity(e), role(e), name(e), e.value ?? null, e.checked ?? null, e.selectedIndex ?? null, e.readOnly ?? null, e.matches(':disabled'),
      e.getAttribute('aria-disabled'), e.getAttribute('aria-expanded'), e.getAttribute('aria-checked'), e.getAttribute('aria-selected'),
      e.getAttribute('href'), scope?.innerText?.slice(0, 6000) || ''];
  };
  const actions = [];
  for (const e of document.querySelectorAll(selector)) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2, rname = role(e);
    if (!rname || r.width <= 0 || r.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
    if (rname === 'gridcell' && e.querySelector('button,[role="button"]')) continue;
    const base = { node: identity(e), role: rname, label: (name(e) || rname).slice(0, 200) };
    for (const key of ['checked', 'selected', 'expanded']) { const v = e.getAttribute('aria-' + key); if (v !== null) base[key] = v; }
    if (['checkbox', 'radio'].includes(e.type)) base.checked = String(e.checked);
    if (e.tagName === 'SELECT') {
      for (const o of e.options) if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
        actions.push({ ...base, kind: 'select', value: o.value, current_value: [...e.selectedOptions].map(o => o.label).join(', '), label: base.label + ' → ' + o.label });
    } else {
      const editable = !e.readOnly && e.getAttribute('aria-readonly') !== 'true'
        && (['textbox', 'searchbox', 'spinbutton'].includes(rname) || (rname === 'combobox' && ['INPUT', 'TEXTAREA'].includes(e.tagName)));
      const value = 'value' in e ? String(e.value) : e.isContentEditable || rname === 'combobox' ? e.innerText.trim() : '';
      actions.push({ ...base, kind: editable ? 'fill' : 'click', value: value.slice(0, 200) });
      if (editable) actions.push({ ...base, kind: 'click', value: value.slice(0, 200), label: 'Open ' + base.label });
    }
  }
  const words = [], walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), range = document.createRange();
  let node, length = 0;
  while ((node = walker.nextNode()) && length < 6000) {
    const value = node.textContent.trim(), parent = node.parentElement;
    if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
    range.selectNodeContents(node);
    const r = range.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) { words.push(value); length += value.length; }
  }
  const text = words.join('\\n').slice(0, 6000), height = document.documentElement.scrollHeight;
  const page_key = cache.pageKey(), guards = {};
  for (const a of actions) if (!(a.node in guards)) guards[a.node] = cache.guard(cache.nodes.get(a.node));
  const marker = JSON.stringify([performance.timeOrigin, location.href, scrollX, scrollY, document.title, text, actions, page_key[6]]);
  actions.splice(250);
  actions.forEach((a, i) => { a.id = 'e' + (i + 1); });
  if (scrollY + innerHeight < height - 2) actions.push({ id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: 560 });
  if (scrollY > 0) actions.push({ id: 'scroll_up', kind: 'scroll', label: 'Scroll up', delta: -560 });
  actions.push({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' });
  return { url: location.href, title: document.title, text, actions, page_key: JSON.stringify(page_key), guards: JSON.parse(JSON.stringify(guards)), marker };
})()`;

/** Read the page (retrying briefly while it navigates). */
export async function observe(page) {
  for (let i = 0; i < 20; i++) {
    const st = await page.evaluate(SNAPSHOT_JS).catch(() => null);
    if (st) return st;
    await page.waitForTimeout(100);
  }
  throw new Error('The page kept changing — it never settled enough to read.');
}

/**
 * Is an action still aimed at what was decided?
 * - click/select: same page state (URL, scroll, form values) and the same node with the same nearby context;
 * - fill: the same field (same node, role and name) on the same address. Typing replaces the field's content, so text
 *   changing elsewhere doesn't matter — comparing the whole page failed forever on sites whose text keeps moving
 *   (an airline's site: dozens of "The page changed" retries, 2026-09-26).
 */
export async function fresh(page, st, action) {
  const now = await page.evaluate(node => { const c = window.__jbPilot; return c ? [JSON.stringify(c.pageKey()), c.guard(c.nodes.get(node)), location.href] : null; }, action.node).catch(() => null);
  if (!now || !now[1]) return false;
  const then = st.guards[action.node];
  if (action.kind === 'fill') return now[2] === st.url && JSON.stringify(now[1].slice(0, 3)) === JSON.stringify(then?.slice(0, 3));
  return now[0] === st.page_key && JSON.stringify(now[1]) === JSON.stringify(then);
}

export class Stale extends Error {}

/** Carry out one observed action. fill: select-all then insert the text (replaces what was there). */
export async function act(page, st, action, { text = null } = {}) {
  if (action.kind === 'wait') { await page.waitForTimeout(150); return; }
  if (action.kind === 'scroll') { await page.mouse.wheel(0, action.delta); return; }
  if (!(await fresh(page, st, action))) throw new Stale('The page changed since this was decided.');
  const target = await page.evaluate(a => {
    const e = window.__jbPilot?.nodes.get(a.node);
    if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]')
      || !e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return null;
    if (a.kind === 'fill' && (e.readOnly || e.getAttribute('aria-readonly') === 'true')) return null;
    const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
    if (!r.width || !r.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
    // What is at its centre? The element itself — or, harmlessly, its own label or a plain part of its wrapper (floating
    // labels and placeholders sit on top of inputs: an airline's airport fields). Anything else that can be clicked on top
    // means covered: a click is refused; typing focuses the field directly instead of clicking through the cover.
    const hit = document.elementFromPoint(x, y);
    const own = hit && (e.contains(hit) || [...(e.labels || [])].some(l => l.contains(hit))
      || (e.parentElement?.contains(hit) && !hit.closest('a,button,input,select,textarea,[role="button"],[role="link"],[role="option"],[role="checkbox"]')));
    if (!own && a.kind !== 'fill') return null; // something is on top of it
    if (!own) return { x, y, focusOnly: true };
    if (a.kind === 'select') {
      if (e.tagName !== 'SELECT' || ![...e.options].some(o => o.value === a.value && !o.disabled)) return null;
      e.value = a.value;
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { x, y };
  }, action);
  if (!target) throw new Stale('That element moved, changed or is covered.');
  if (action.kind === 'select') return;
  if (!target.focusOnly) await page.mouse.click(target.x, target.y);
  if (action.kind === 'fill') {
    // Typing must land in this field, whatever the click hit (a label, a wrapper) or when it was covered.
    const focused = await page.evaluate(node => { const e = window.__jbPilot?.nodes.get(node); if (!e) return false; if (document.activeElement !== e) e.focus(); return document.activeElement === e; }, action.node).catch(() => false);
    if (!focused) throw new Stale('That field wouldn’t take focus.');
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.insertText(String(text ?? ''));
  }
}

/** After input: two animation frames (or 50 ms); an autocomplete field waits up to 200 ms for its options. */
export async function settle(page, action) {
  await page.evaluate(a => new Promise(resolve => {
    const field = window.__jbPilot?.nodes.get(a.node);
    const auto = a.kind === 'fill' && field?.getAttribute('role') === 'combobox';
    let frames = 0, stopped = false;
    const finish = () => { stopped = true; resolve(); };
    setTimeout(finish, auto ? 200 : 50);
    const ready = () => {
      if (stopped) return;
      const ids = (field?.getAttribute('aria-controls') || field?.getAttribute('aria-owns') || '').split(/\s+/).filter(Boolean);
      const roots = ids.length ? ids.map(id => document.getElementById(id)).filter(Boolean) : [document];
      const options = roots.flatMap(root => [...root.querySelectorAll('[role="option"]')]);
      if (++frames >= 2 && (!auto || options.some(o => { const r = o.getBoundingClientRect(); return r.width && r.height && r.bottom > 0 && r.top < innerHeight; }))) finish();
      else requestAnimationFrame(ready);
    };
    requestAnimationFrame(ready);
  }), action).catch(() => {}); // a navigation mid-wait is fine
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
}
