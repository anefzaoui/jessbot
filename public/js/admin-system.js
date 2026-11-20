// Admin → System (Phase 9): re-run the health check, make a backup (pending → done), tail the server log live.
// Server contract (routes/web/admin-ops.js): GET /admin/system/health → { status, html } · POST /admin/system/backups →
// { backup, html } · GET /admin/system/logs?level&q&after → { lines: [{ seq, at, level, text }] }
import { $, $$, on, api, escapeHtml, withBusy } from './core.js';
import { toast } from './toast.js';

const lineHtml = l => `<div class="log-line" data-seq="${l.seq}" data-level="${escapeHtml(l.level)}"><time datetime="${escapeHtml(l.at)}">`
  + `${new Date(l.at).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</time><span>${escapeHtml(l.text)}</span></div>`;

function initLogs(root) {
  const box = $('[data-logs]', root);
  if (!box) return;
  const view = $('[data-log-view]', box);
  const filter = $('[data-log-filter]', box);
  let level = box.dataset.level || 'warn';
  let last = Math.max(0, ...$$('.log-line', view).map(l => Number(l.dataset.seq)));
  let timer = null, busy = false;
  view.scrollTop = view.scrollHeight;

  const load = async (replace = false) => {
    if (busy) return;
    busy = true;
    try {
      const qs = new URLSearchParams({ level, q: filter.value.trim(), after: replace ? 0 : last });
      const { lines } = await api(`/admin/system/logs?${qs}`);
      const stick = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
      if (replace) view.innerHTML = lines.length ? '' : '<p class="px-1.5 py-2 opacity-60" data-log-empty>Nothing matches.</p>';
      if (lines.length) {
        $('[data-log-empty]', view)?.remove();
        view.insertAdjacentHTML('beforeend', lines.map(lineHtml).join(''));
        last = lines.at(-1).seq;
        while (view.children.length > 600) view.firstElementChild.remove();
        if (stick || replace) view.scrollTop = view.scrollHeight;
      }
    } catch { /* next poll tries again */ } finally { busy = false; }
  };
  const poll = () => { clearTimeout(timer); timer = setTimeout(async () => { if (document.visibilityState === 'visible') await load(); poll(); }, 3000); };
  poll();

  on(box, 'click', '[data-log-level]', (e, b) => {
    level = b.dataset.logLevel;
    $$('[data-log-level]', box).forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    load(true);
  });
  let debounce;
  filter.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(() => load(true), 300); });
}

export function initAdminSystem() {
  const root = $('[data-admin-system]');
  if (!root) return;

  on(root, 'click', '[data-health-run]', (e, btn) => withBusy(btn, async () => {
    try {
      const r = await api('/admin/system/health');
      $('[data-health]', root).innerHTML = r.html;
      (r.status === 'ok' ? toast.success : toast)(r.status === 'ok' ? 'All checks passed.' : 'Checked. See what needs a look.');
    } catch (err) { toast.error(err.message, { title: 'Couldn’t run the checks' }); }
  }, 'Checking…'));

  on(root, 'click', '[data-backup-now]', async (e, btn) => {
    if (btn.getAttribute('aria-busy') === 'true') return;
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
    const t = toast.pending('Making a backup of everything…');
    try {
      const r = await api('/admin/system/backups', { method: 'POST' });
      $('[data-backups]', root).innerHTML = r.html;
      t.done(`Backup ready: ${r.backup.sizeLabel}. Download it to keep a copy off this computer.`);
    } catch (err) { t.fail(`Backup failed: ${err.message}`); }
    finally { btn.removeAttribute('aria-busy'); btn.disabled = false; }
  });

  // "Running for": seconds → "3 d 4 h" / "12 min", ticking.
  const up = $('[data-uptime]', root);
  if (up) {
    const start = Date.now() - Number(up.dataset.uptime) * 1000;
    const fmt = () => { const s = Math.round((Date.now() - start) / 1000); const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
      up.textContent = d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`; };
    fmt();
    setInterval(fmt, 30000);
  }
  initLogs(root);
}
