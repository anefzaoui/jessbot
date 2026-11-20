// Approvals: optimistic decide, every copy of the same request (chat, panel, sheet) stays in sync.
// Server contract: POST {base}/{id}  body { decision: approve|deny, scope: once|task|always }
//   → { status, pendingCount }
import { $$, on, api, withBusy, icon, escapeHtml } from './core.js';
import { toast } from './toast.js';
import { setCount, announce } from './shell.js';

const BASE = '/api/v1/approvals';

function copiesOf(id) { return $$(`[data-approval-id="${id}"]`); }

// Only data-status and the result line change; the stamp, the tint and the dimmed body follow in CSS (decision #194).
function paint(id, status, label) {
  for (const card of copiesOf(id)) {
    card.dataset.status = status;
    card.querySelector('.approval-actions').hidden = status !== 'pending';
    const result = card.querySelector('.approval-result');
    result.hidden = status === 'pending';
    if (label) result.innerHTML = label;
  }
}

const LABELS = {
  deciding: '<span class="approval-dots" aria-hidden="true"><i></i><i></i><i></i></span> Sending your decision…',
  approved: `<span class="text-ok">${icon('circle-check')}</span> Approved, continuing`,
  denied: `<span class="text-bad">${icon('circle-x')}</span> Denied`,
};

export function initApprovals() {
  // A long preview opens and folds in place (the full text is always in the card; nothing is fetched).
  on(document, 'click', '[data-approval-expand]', (e, btn) => {
    const box = btn.closest('[data-approval-preview-box]');
    const open = !box.hasAttribute('data-open');
    box.toggleAttribute('data-open', open);
    btn.setAttribute('aria-expanded', String(open));
  });

  on(document, 'click', '[data-approval-action]', async (e, btn) => {
    const card = btn.closest('[data-approval-id]');
    if (!card || card.dataset.status !== 'pending') return;
    const id = card.dataset.approvalId;
    const decision = btn.dataset.approvalAction;
    const scope = btn.dataset.scope || 'once';
    const url = card.dataset.approvalUrl || `${BASE}/${encodeURIComponent(id)}`;

    const primary = card.querySelector(`.approval-actions [data-approval-action="${decision}"]`) || btn;
    await withBusy(primary, async () => {
      paint(id, 'deciding', LABELS.deciding);
      try {
        const res = await api(url, { method: 'POST', body: { decision, scope } });
        const status = decision === 'approve' ? 'approved' : 'denied';
        paint(id, status, LABELS[status]);
        if (typeof res?.pendingCount === 'number') setCount('approvals', res.pendingCount);
        announce(status === 'approved' ? 'Approved.' : 'Denied.');
        if (scope === 'always') toast.success(`I won't ask again for ${card.dataset.toolLabel || 'this'}.`);
      } catch (err) {
        // Closed with its task (a new message, Stop): nothing can run any more, so the card says so instead of going back to pending.
        if (err.data?.code === 'approval_closed') {
          paint(id, 'expired', `<span class="text-ink-3">${icon('clock')}</span> ${escapeHtml(err.message)}`);
          toast.error(err.message, { title: 'Not done' });
          return;
        }
        paint(id, 'pending');
        toast.error(err.message, { title: 'Decision not saved', action: { label: 'Retry', onClick: () => btn.click() } });
      }
    });
  });
}
