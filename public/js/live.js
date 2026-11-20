// Global realtime updates (not tied to one chat): approvals, activity feed, badge counts.
import { $$, h, escapeHtml, icon } from './core.js';
import { setCount, announce } from './shell.js';
import { toast } from './toast.js';

const bubble = runId => document.querySelector(`[data-run-owner="${runId}"]`);

function addCard(cardHtml, id) {
  for (const list of $$('[data-live-approvals]')) {
    if (list.querySelector(`[data-approval-id="${id}"]`)) continue;
    list.querySelector('.flex.flex-col.items-center')?.remove(); // empty state
    const card = h(cardHtml);
    card.classList.add('animate-rise');
    list.prepend(card);
  }
}

function onApprovalCreated({ data, runId }) {
  if (data.html && runId && bubble(runId)) bubble(runId).replaceWith(h(data.html));
  if (data.cardHtml) addCard(data.cardHtml, data.approvalId);
  setCount('approvals', data.pendingCount ?? 0);
  if (!bubble(runId)) toast('Jess needs your OK for something.', { type: 'warn', action: { label: 'Review', onClick: () => location.assign('/approvals') } });
  announce('Approval needed.');
}

const LABEL = { approved: ['circle-check', 'text-ok', 'Approved'], denied: ['circle-x', 'text-bad', 'Denied'], expired: ['clock', 'text-ink-3', 'Expired, not done'] };
function onApprovalUpdated({ data }) {
  const [ic, tone, fallback] = LABEL[data.status] || [];
  const text = data.label || fallback; // the server's line ("Expired: you moved on, so it was not done")
  for (const card of $$(`[data-approval-id="${data.approvalId}"]`)) {
    if (card.dataset.status === data.status) continue;
    card.dataset.status = data.status; // the stamp, tint and dimmed body follow in CSS (#194)
    const actions = card.querySelector('.approval-actions');
    const result = card.querySelector('.approval-result');
    if (actions) actions.hidden = data.status !== 'pending';
    if (result && ic) { result.hidden = false; result.innerHTML = `<span class="${tone}">${icon(ic)}</span> ${escapeHtml(text)}`; }
  }
  setCount('approvals', data.pendingCount ?? 0);
}

function onActivity({ data }) {
  const it = data.item;
  const tone = it.status === 'run' ? 'text-run' : it.status === 'warn' ? 'text-warn-text' : it.status === 'bad' ? 'text-bad' : it.status === 'ok' ? 'text-ok' : 'text-ink-3';
  const time = new Date(it.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  for (const panel of $$('[data-live-activity]')) {
    let today = panel.querySelector('ol');
    if (!today || panel.querySelector('h3')?.textContent.trim() !== 'Today') {
      panel.querySelector('.flex.flex-col.items-center')?.remove();
      // Mirrors partials/shell/panel.hbs (day heading + list) and partials/activity-item.hbs (the item) — keep in step.
      panel.prepend(h('<ol class="relative ml-2.5 border-l border-line" role="list"></ol>'));
      panel.prepend(h('<h3 class="sticky top-0 z-10 bg-chrome/95 px-1 pt-3 pb-2 text-xs font-medium text-ink-3 backdrop-blur-sm">Today</h3>'));
      today = panel.querySelector('ol');
    }
    const inner = `<div class="flex items-baseline gap-2"><p class="min-w-0 flex-1 text-[13px] leading-snug font-medium text-ink">${escapeHtml(it.title)}</p>
      <time class="tabular shrink-0 text-[11px] text-ink-3" datetime="${escapeHtml(it.at)}">${escapeHtml(time)}</time></div>
      ${it.detail ? `<p class="mt-0.5 line-clamp-2 text-xs leading-snug text-ink-3">${escapeHtml(it.detail)}</p>` : ''}`;
    const li = h(`<li class="relative pb-3.5 pl-6 animate-rise" data-activity-id="${it.id}" data-kind="${escapeHtml(it.kind)}">
      <span class="absolute top-0.5 -left-[11.5px] grid size-[22px] place-items-center rounded-full border border-line bg-surface ${tone}">${icon(it.iconName || 'circle', 'size-[13px]')}</span>
      ${it.href ? `<a href="${escapeHtml(it.href)}" class="group -mx-1.5 block rounded-lg px-1.5 py-0.5 hover:bg-surface-2">${inner}</a>` : `<div class="-mx-1.5 px-1.5 py-0.5">${inner}</div>`}</li>`);
    today.prepend(li);
  }
}

export function initLive() {
  document.addEventListener('jb:ws:approval.created', e => onApprovalCreated(e.detail));
  document.addEventListener('jb:ws:approval.updated', e => onApprovalUpdated(e.detail));
  document.addEventListener('jb:ws:activity.new', e => onActivity(e.detail));
}
