// Admin → Skills (decisions #84, #195): the list (find by words / status / origin / category, the recommended core set approved
// in one go), one skill's review page (approve, approve anyway, turn off, the trigger test), and writing / editing / deleting
// your own. Server contract (routes/web/admin-ops.js): POST /admin/skills/:name/approve|disable { force? } · POST /admin/skills
// { name, description, toolsets[], body, force? } · DELETE /admin/skills/:name → { ok }. A skill the review assistant found
// something serious in answers 409 { code: 'lint_bad', error }: the admin confirms "Approve anyway" (having read the findings)
// and it is sent again with force (#121). Trigger test: POST /admin/skills/:name/trigger-test { queries, runs, suggest, dryRun }
// → an estimate (dry run) or the results; GET …/trigger-test → the last one ({ test: { status: running|done|error, … } }), so a
// page reloaded mid-test picks it up. The page re-renders from the server after a change.
import { $, $$, on, api, withBusy, escapeHtml, icon, loader } from './core.js';
import { toast } from './toast.js';
import { openModal, closeModal, confirmDialog } from './modal.js';

const skillUrl = (name, action = '') => `/admin/skills/${encodeURIComponent(name)}${action ? `/${action}` : ''}`;
const later = msg => { try { sessionStorage.setItem('jb-skill-toast', msg); } catch { /* storage blocked */ } };

// Approving a skill with serious findings: the admin reads them (listed) and ticks that they trust it.
async function confirmAnyway(name, findings) {
  const res = await confirmDialog({ title: `Approve “${name}” anyway?`, body: 'The review found something serious. Approve only if you trust where it came from.',
    confirmLabel: 'Approve anyway', danger: true, checkbox: { label: 'I read what it found and I trust this skill', items: findings } });
  if (res.ok && !res.checked) { toast.error('Tick that you read what it found first.', { title: 'Not approved' }); return false; }
  return res.ok;
}

// Send; when the server says the skill has a serious warning, show it and send again with force only if confirmed.
async function withApproveAnyway(name, send, findings = null) {
  try { return await send(false); } catch (err) {
    if (err.data?.code !== 'lint_bad') throw err;
    if (!(await confirmAnyway(name, findings?.length ? findings : [err.message]))) return null;
    return send(true);
  }
}

function initActions(root) {
  on(root, 'click', '[data-skill-action]', (e, btn) => withBusy(btn, async () => {
    const card = btn.closest('[data-skill]');
    const name = card.dataset.skill;
    const action = btn.dataset.skillAction;
    const findings = (card.dataset.badList || '').split('|').filter(Boolean);
    try {
      let done;
      if (btn.hasAttribute('data-approve-anyway')) { // the review page already knows: ask first, then send with force
        if (!(await confirmAnyway(name, findings))) return;
        done = await api(skillUrl(name, action), { method: 'POST', body: { force: true } });
      } else {
        done = await withApproveAnyway(name, force => api(skillUrl(name, action), { method: 'POST', body: force ? { force: true } : undefined }), findings);
      }
      if (!done) return;
      later(action === 'approve' ? `“${name}” is on.` : `“${name}” is off.`);
      location.reload();
    } catch (err) { toast.error(err.message, { title: 'Not changed' }); }
  }, btn.dataset.skillAction === 'approve' ? 'Approving…' : 'Turning off…'));

  on(root, 'click', '[data-skill-delete]', async (e, btn) => {
    const name = btn.closest('[data-skill]').dataset.skill;
    if (!(await confirmDialog({ title: `Delete “${name}”?`, body: 'Its file is removed. This can’t be undone (backups keep a copy).', confirmLabel: 'Delete', danger: true }))) return;
    await withBusy(btn, async () => {
      try { await api(skillUrl(name), { method: 'DELETE' }); later(`Deleted “${name}”.`); location.reload(); }
      catch (err) { toast.error(err.message, { title: 'Not deleted' }); }
    });
  });
}

function initEditor(root) {
  const dlg = $('#skill-editor');
  if (!dlg) return;
  const form = $('[data-skill-form]', dlg);
  on(document, 'click', '[data-skill-new]', () => { form.reset(); form.elements.name.readOnly = false; });
  on(root, 'click', '[data-skill-edit]', (e, btn) => {
    const card = btn.closest('[data-skill]');
    form.reset();
    form.elements.name.value = card.dataset.skill;
    form.elements.name.readOnly = true;
    form.elements.description.value = card.dataset.description;
    form.elements.body.value = card.querySelector('template[data-skill-raw]')?.content.textContent || '';
    const on_ = new Set(card.dataset.toolsets.trim().split(/\s+/));
    for (const cb of $$('input[name="toolsets"]', form)) cb.checked = on_.has(cb.value);
    form.elements.body.dispatchEvent(new Event('md:refresh')); // the markdown editor re-colours what was set
    openModal(dlg, btn);
  });
  form.addEventListener('submit', e => {
    e.preventDefault();
    const body = { name: form.elements.name.value.trim(), description: form.elements.description.value, body: form.elements.body.value,
      toolsets: $$('input[name="toolsets"]:checked', form).map(cb => cb.value) };
    for (const el of $$('[aria-invalid]', form)) el.removeAttribute('aria-invalid');
    withBusy($('[data-skill-save]', form), async () => {
      try {
        const done = await withApproveAnyway(body.name, force => api('/admin/skills', { method: 'POST', body: force ? { ...body, force: true } : body }));
        if (!done) return;
        closeModal(dlg);
        later(`Saved “${body.name}”. It’s on.`);
        location.reload();
      } catch (err) {
        const fields = err.data?.errors;
        if (fields) for (const n of Object.keys(fields)) form.elements[n]?.setAttribute('aria-invalid', 'true');
        toast.error(fields ? Object.values(fields).join(' ') : err.message, { title: 'Not saved' });
      }
    }, 'Saving…');
  });
}

// ---- The list: find by words, status, origin, category (all in the page) -----------------------------------------------
function initFilters(root) {
  const bar = $('[data-skill-filters]', root);
  if (!bar) return;
  const q = $('[data-skill-q]', bar), origin = $('[data-skill-origin]', bar), cat = $('[data-skill-category]', bar);
  const rows = $$('[data-skill-list] > [data-skill]', root);
  const count = $('[data-skill-count]', root), none = $('[data-skill-none]', root);
  let status = 'all';
  const apply = () => {
    const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const r of rows) {
      const text = `${r.dataset.skill} ${r.dataset.description}`.toLowerCase();
      const ok = (status === 'all' || r.dataset.status === status) && (!origin.value || r.dataset.origin === origin.value)
        && (!cat.value || r.dataset.category === cat.value) && words.every(w => text.includes(w));
      r.hidden = !ok;
      if (ok) shown++;
    }
    count.textContent = shown === rows.length ? `${rows.length} skills` : `${shown} of ${rows.length} skills`;
    none.hidden = shown > 0;
  };
  q.addEventListener('input', apply);
  origin.addEventListener('change', apply);
  cat.addEventListener('change', apply);
  on(bar, 'click', '[data-skill-status]', (e, chip) => {
    status = chip.dataset.skillStatus;
    for (const c of $$('[data-skill-status]', bar)) c.setAttribute('aria-pressed', String(c === chip));
    apply();
  });
  on(root, 'click', '[data-skill-clear]', () => {
    q.value = ''; origin.value = ''; cat.value = ''; status = 'all';
    for (const c of $$('[data-skill-status]', bar)) c.setAttribute('aria-pressed', String(c.dataset.skillStatus === 'all'));
    apply();
  });
}

// ---- The recommended core set: the normal approval, one skill after another, each row saying how it went ----------------
function initRecommended(root) {
  const box = $('[data-skill-rec]', root);
  if (!box) return;
  on(box, 'click', '[data-skill-rec-approve]', (e, btn) => withBusy(btn, async () => {
    const items = $$('[data-rec]', box);
    let on_ = 0, left = 0;
    for (const li of items) {
      const state = $('[data-rec-state]', li);
      if (li.dataset.status === 'broken' || Number(li.dataset.bad)) { li.dataset.result = 'skipped'; left++; continue; }
      li.dataset.result = 'working';
      state.innerHTML = '<span class="approval-dots" aria-hidden="true"><i></i><i></i><i></i></span> Approving';
      try {
        await api(skillUrl(li.dataset.rec, 'approve'), { method: 'POST' }); // no force: a serious finding stops here
        li.dataset.result = 'ok';
        state.innerHTML = `${icon('circle-check', 'size-3.5')} On`;
        on_++;
      } catch (err) {
        li.dataset.result = err.data?.code === 'lint_bad' ? 'skipped' : 'failed';
        state.innerHTML = err.data?.code === 'lint_bad' ? `${icon('shield-alert', 'size-3.5')} Read first` : `${icon('circle-x', 'size-3.5')} ${escapeHtml(err.message.slice(0, 60))}`;
        left++;
      }
    }
    later(left ? `${on_} switched on. ${left} ${left === 1 ? 'needs' : 'need'} a look first: open ${left === 1 ? 'it' : 'them'} from the list.` : `${on_} skills switched on.`);
    setTimeout(() => location.reload(), 900);
  }, 'Approving…'));
}

// ---- The trigger test (review page) ------------------------------------------------------------------------------------
function initTriggerTest(root) {
  const box = $('[data-trigger-test]', root);
  if (!box) return;
  const name = root.dataset.skillReview;
  const list = $('[data-tt-queries]', box), results = $('[data-tt-results]', box), estimateEl = $('[data-tt-estimate]', box);
  const dry = $('[data-tt-dry]', box), runBtn = $('[data-tt-run]', box);
  const draftKey = `jb-tt:${name}`;

  const queries = () => $$('[data-tt-row]', list).map(r => ({ text: $('[data-tt-text]', r).value.trim(),
    expect: $('[data-tt-expect][aria-checked="true"]', r)?.dataset.ttExpect || 'use' })).filter(x => x.text);
  const opts = () => ({ queries: queries(), runs: Number($('[data-tt-runs]', box).value), suggest: $('[data-tt-suggest]', box).checked });
  // Anything changed after the estimate: the cost must be checked again before it runs.
  const stale = () => { runBtn.hidden = true; dry.hidden = false; estimateEl.textContent = 'Changed: check the cost again before it runs.'; saveDraft(); };
  const saveDraft = () => { try { sessionStorage.setItem(draftKey, JSON.stringify(queries())); } catch { /* storage blocked */ } };
  const addRow = (q = { text: '', expect: 'use' }) => {
    const row = $('[data-tt-row-template]', box).content.firstElementChild.cloneNode(true);
    $('[data-tt-text]', row).value = q.text;
    for (const b of $$('[data-tt-expect]', row)) b.setAttribute('aria-checked', String(b.dataset.ttExpect === q.expect));
    list.append(row);
    return row;
  };
  try { // a half-edited set of requests survives a refresh
    const draft = JSON.parse(sessionStorage.getItem(draftKey) || 'null');
    if (Array.isArray(draft) && draft.length) { list.replaceChildren(); draft.forEach(addRow); }
  } catch { /* none */ }

  on(box, 'click', '[data-tt-add]', () => { $('[data-tt-text]', addRow()).focus(); stale(); });
  on(box, 'click', '[data-tt-remove]', (e, b) => { b.closest('[data-tt-row]').remove(); stale(); });
  on(box, 'click', '[data-tt-expect]', (e, b) => {
    for (const x of $$('[data-tt-expect]', b.parentElement)) x.setAttribute('aria-checked', String(x === b));
    stale();
  });
  box.addEventListener('input', e => { if (e.target.matches('[data-tt-text]')) stale(); });
  box.addEventListener('change', e => { if (e.target.matches('[data-tt-runs], [data-tt-suggest]')) stale(); });

  dry.addEventListener('click', () => withBusy(dry, async () => {
    const o = opts();
    if (!o.queries.length) { estimateEl.textContent = 'Add at least one request first.'; return; }
    try {
      const res = await api(skillUrl(name, 'trigger-test'), { method: 'POST', body: { ...o, dryRun: true } });
      const e = res.estimate;
      estimateEl.innerHTML = `<span class="font-medium text-ink">${e.calls} calls</span> to ${escapeHtml(e.model)} · about <span class="font-medium text-ink">${escapeHtml(e.costLabel)}</span>`
        + ` · ${res.competing} skills compete`;
      runBtn.innerHTML = `${icon('play', 'size-4')} Run the test (${escapeHtml(e.costLabel)})`;
      runBtn.hidden = false;
      dry.hidden = true;
    } catch (err) { estimateEl.textContent = ''; toast.error(err.data?.errors ? Object.values(err.data.errors).join(' ') : err.message, { title: 'Can’t test that' }); }
  }, 'Checking…'));

  runBtn.addEventListener('click', async () => {
    const o = opts();
    running(o.queries, o.queries.length * o.runs + (o.suggest ? 1 : 0));
    runBtn.hidden = true;
    try { show(await api(skillUrl(name, 'trigger-test'), { method: 'POST', body: o })); }
    catch (err) {
      if (err.status === 409) return poll(); // one is already running (another tab): follow it
      failed(err.message);
    }
    dry.hidden = false;
  });

  // While it runs: the requests as rows whose bars shimmer, and the time it has taken.
  let clock = null;
  function running(qs, calls, since = Date.now()) {
    results.hidden = false;
    results.innerHTML = `<div class="skt-running">${loader(`Asking the model ${calls} time${calls === 1 ? '' : 's'}`, { motion: 'thinking', iconName: 'book-marked', lines: 0 })}
      <span class="tabular text-xs text-ink-3" data-tt-clock>0:00</span></div>
      <ul class="skt-rows" role="list">${qs.map(q => `<li class="skt-row is-running"><p class="skt-row-text">“${escapeHtml(q.text)}”</p>
        <span class="skt-bar"><i></i></span><span class="skt-row-meta">${q.expect === 'use' ? 'should open it' : 'should skip it'}</span></li>`).join('')}</ul>`;
    clearInterval(clock);
    const tick = () => { const s = Math.round((Date.now() - since) / 1000); const c = $('[data-tt-clock]', results); if (c) c.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
    tick();
    clock = setInterval(tick, 1000);
  }
  function failed(message) {
    clearInterval(clock);
    results.hidden = false;
    results.innerHTML = `<div class="skt-failed" role="alert">${icon('triangle-alert', 'size-4 text-bad')}<p class="min-w-0 flex-1 text-sm">${escapeHtml(message)}</p>
      <button type="button" class="btn btn-secondary btn-sm" data-tt-again>${icon('rotate-ccw', 'size-3.5')} Check the cost again</button></div>`;
  }
  on(box, 'click', '[data-tt-again]', () => { results.hidden = true; stale(); dry.click(); });

  function show(out) {
    clearInterval(clock);
    results.hidden = false;
    const rows = out.results.map(r => {
      const n = r.answers.filter(a => a !== 'error').length;
      const others = [...new Set(r.answers.filter(a => a !== out.skill && a !== 'error'))];
      return `<li class="skt-row" data-ok="${r.ok}"><p class="skt-row-text">${icon(r.ok ? 'circle-check' : 'circle-x', `size-4 shrink-0 ${r.ok ? 'text-ok' : 'text-bad'}`)} “${escapeHtml(r.text)}”</p>
        <span class="skt-bar" role="img" aria-label="Opened it ${r.hits} of ${n} times"><i style="width:${Math.round(r.rate * 100)}%"></i></span>
        <span class="skt-row-meta">${r.expect === 'use' ? 'should open it' : 'should skip it'} · opened ${r.hits} of ${n}${others.length ? ` · chose ${others.map(escapeHtml).join(', ')}` : ''}</span></li>`;
    }).join('');
    const s = out.suggestion;
    results.innerHTML = `<p class="skt-summary"><span class="font-semibold ${out.summary.failed ? 'text-warn-text' : 'text-ok'}">${out.summary.passed} of ${out.summary.total} passed</span>
        <span class="text-ink-3">· ${out.runs} run${out.runs === 1 ? '' : 's'} each · cost ${escapeHtml(out.costLabel)}${out.summary.errors ? ` · ${out.summary.errors} didn’t answer` : ''}</span></p>
      <ul class="skt-rows" role="list">${rows}</ul>
      ${s ? `<div class="skt-suggest" data-tt-suggestion><p class="flex items-center gap-2 text-sm font-semibold">${icon('lightbulb', 'size-4 text-accent-text')} A description that may pick it better</p>
        <p class="mt-2 rounded-lg border border-line bg-surface px-3 py-2 text-[13px] leading-relaxed text-ink" dir="auto">${escapeHtml(s.description)}</p>
        ${s.why ? `<p class="mt-1.5 text-xs text-ink-2">${escapeHtml(s.why)}</p>` : ''}
        <p class="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-3"><span>${s.length} characters${s.fits ? '' : ' (too long for a skill’s description: shorten it)'}</span>
          <span>· A proposal only: nothing was changed.</span>
          <button type="button" class="btn btn-ghost btn-sm ms-auto" data-tt-copy>${icon('copy', 'size-3.5')} Copy</button></p></div>` : ''}`;
    results.dataset.suggestion = s?.description || '';
  }
  on(box, 'click', '[data-tt-copy]', async () => {
    try { await navigator.clipboard.writeText(results.dataset.suggestion); toast.success('Copied. Paste it into the skill when you edit it.'); }
    catch { toast.error('Copying isn’t allowed here: select the text instead.'); }
  });

  // A test running (or finished) before this page loaded: follow it until it's done.
  async function poll() {
    try {
      const { test } = await api(skillUrl(name, 'trigger-test'));
      if (!test) return;
      if (test.status === 'running') { if (!clock) running(queries(), test.calls || 0, Date.parse(test.startedAt)); setTimeout(poll, 2000); return; }
      if (test.status === 'done') show(test.result); else failed(test.error || 'The test failed.');
    } catch { setTimeout(poll, 5000); }
  }
  try {
    const last = JSON.parse(box.dataset.lastTest || 'null');
    if (last?.status === 'running') { running(queries(), last.calls || 0, Date.parse(last.startedAt)); setTimeout(poll, 1500); }
    else if (last?.status === 'done') show(last.result);
  } catch { /* none */ }
}

export function initAdminSkills() {
  const root = $('[data-admin-skills]');
  if (!root) return;
  initActions(root);
  initEditor(root);
  initFilters(root);
  initRecommended(root);
  initTriggerTest(root);
  try { const m = sessionStorage.getItem('jb-skill-toast'); if (m) { sessionStorage.removeItem('jb-skill-toast'); toast.success(m); } } catch { /* storage blocked */ }
}
