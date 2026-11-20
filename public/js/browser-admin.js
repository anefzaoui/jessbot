// Admin → Browser: live install progress + status (server-rendered partials, polled), and a test drive
// that runs the same search / screenshot code Jess uses.
import { $, on, api, escapeHtml, icon, withBusy, botName } from './core.js';
import { toast } from './toast.js';

const root = $('[data-browser-admin]');
if (root) {
  const statusBox = $('[data-browser-status]', root);
  const recentBox = $('[data-browser-recent]', root);
  const result = $('[data-browser-result]', root);
  let timer = null;

  const state = () => statusBox.firstElementChild?.dataset.browserState;
  const swap = (el, html) => { if (html && el.innerHTML.trim() !== html.trim()) el.innerHTML = html; };

  async function refresh() {
    clearTimeout(timer);
    try {
      const res = await api(root.dataset.statusUrl || '/admin/browser/status');
      const wasInstalling = state() === 'installing';
      swap(statusBox, res.statusHtml);
      if (recentBox) swap(recentBox, res.recentHtml);
      if (wasInstalling && res.status.installed && !res.status.installing) toast.success('The browser is installed and ready.');
      if (wasInstalling && res.status.installError) toast.error(res.status.installError, { title: 'Install failed' });
    } catch { /* offline: try again later */ }
    // Fast while installing, slow otherwise, paused in background tabs.
    timer = setTimeout(tick, state() === 'installing' ? 1500 : 10000);
  }
  const tick = () => (document.visibilityState === 'visible' ? refresh() : (timer = setTimeout(tick, 5000)));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  root.addEventListener('ajax:success', e => { if (e.target.closest('[data-browser-refresh]')) refresh(); });
  timer = setTimeout(tick, state() === 'installing' ? 1500 : 10000);

  // The second half (#195): forget a learned search page, turn ad blocking back on for a site, office previews. Each row says
  // it's working, then the section comes back from the server; a failure puts the row back with the reason.
  const extras = $('[data-browser-extras]', root);
  const rowAction = (row, req, done) => async () => {
    row.setAttribute('aria-busy', 'true');
    try {
      const res = await req();
      if (res.html) extras.innerHTML = res.html;
      toast.success(done);
    } catch (err) {
      row.removeAttribute('aria-busy');
      toast.error(err.message, { title: 'Not changed' });
    }
  };
  on(root, 'click', '[data-recipe-delete]', (e, btn) => {
    const row = btn.closest('[data-recipe]');
    return withBusy(btn, rowAction(row, () => api(`/admin/browser/recipes/${encodeURIComponent(row.dataset.recipe)}`, { method: 'DELETE' }),
      `Forgot the search page on ${btn.dataset.host}. ${botName()} uses the site’s own form next time.`), 'Forgetting…');
  });
  on(root, 'click', '[data-adblock-on]', (e, btn) => {
    const row = btn.closest('[data-off-host]');
    return withBusy(btn, rowAction(row, () => api(`/admin/browser/adblock-off/${encodeURIComponent(row.dataset.offHost)}`, { method: 'DELETE' }),
      `Ad blocking is back on for ${row.dataset.offHost}.`), 'Turning on…');
  });
  root.addEventListener('ajax:success', e => {
    if (!e.target.matches('[data-office-form]')) return;
    if (e.detail?.html) extras.innerHTML = e.detail.html;
    toast.success(e.detail?.office?.available ? `Saved. ${e.detail.office.detail}.` : `Saved. ${e.detail?.office?.detail || ''}`.trim());
  });

  const seconds = ms => `${(ms / 1000).toFixed(1)} s`;
  const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

  on(root, 'submit', '[data-browser-search]', async (e, form) => {
    e.preventDefault();
    await withBusy(e.submitter, async () => {
      try {
        const res = await api('/admin/browser/search', { method: 'POST', body: { query: form.query.value } });
        result.innerHTML = res.results.length
          ? `<p class="mb-2 text-xs text-ink-3">${escapeHtml(res.engine)} · ${res.results.length} results · ${seconds(res.ms)}</p>
             <ol class="space-y-2.5" role="list">${res.results.map(r => `<li class="text-[13px]">
               <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer" class="font-medium text-accent-text hover:underline">${escapeHtml(r.title)}</a>
               <span class="block truncate text-xs text-ok">${escapeHtml(host(r.url))}</span>
               ${r.snippet ? `<span class="line-clamp-2 block text-xs text-ink-2">${escapeHtml(r.snippet)}</span>` : ''}</li>`).join('')}</ol>`
          : `<p class="text-[13px] text-bad">No results. ${escapeHtml(res.tried.join(' · '))}</p>`;
      } catch (err) { toast.error(err.message, { title: 'Search failed' }); }
      refresh();
    }, 'Searching…');
  });

  on(root, 'submit', '[data-browser-shot]', async (e, form) => {
    e.preventDefault();
    await withBusy(e.submitter, async () => {
      try {
        const res = await api('/admin/browser/test', { method: 'POST', body: { url: form.url.value } });
        result.innerHTML = `<p class="mb-2 flex items-center gap-1.5 text-xs text-ink-3">${icon('circle-check', 'size-3.5 text-ok')}
            ${escapeHtml(res.title)} · ${seconds(res.ms)}</p>
          <a href="${escapeHtml(res.href)}" target="_blank" rel="noopener" class="step-shot max-w-xl">
            <img src="${escapeHtml(res.href)}" alt="Screenshot of ${escapeHtml(res.title)}" width="640" height="400"></a>`;
      } catch (err) { toast.error(err.message, { title: 'Couldn’t open that page' }); }
      refresh();
    }, 'Opening…');
  });
}
