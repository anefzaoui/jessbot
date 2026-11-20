// Sign-in settings (decision #225): the two-step sign-in card on You re-renders from each answer's `html`; an admin's
// password reset link is shown once, with a copy button (like an invite link).
import { $, h, icon, escapeHtml } from './core.js';

export function initAccount() {
  document.addEventListener('ajax:success', e => {
    const form = e.target;
    if (form.matches('[data-2fa-form]') && e.detail?.html) {
      const card = form.closest('[data-2fa-card]');
      const next = h(e.detail.html);
      if (card && next) {
        card.replaceWith(next);
        (next.querySelector('[data-2fa-setup] input[name="code"]') || next.querySelector('[data-recovery-codes] button'))?.focus();
      }
    }
    if (form.matches('[data-reset-link-form]') && e.detail?.link) {
      const { link, name } = e.detail;
      const box = $('[data-reset-link-box]');
      if (!box) return;
      box.replaceChildren(h(`
        <div class="rounded-xl border border-ok/30 bg-ok-soft px-4 py-3 animate-rise" role="status">
          <p class="text-sm font-semibold">Reset link for ${escapeHtml(name)}</p>
          <p class="text-xs text-ink-2">Give it to them yourself. It works once, for 24 hours; a newer link replaces it. Copy it now: it won't be shown again.</p>
          <div class="mt-2 flex gap-2">
            <input class="input h-9 flex-1 font-mono text-xs" dir="ltr" value="${escapeHtml(link)}" readonly aria-label="Reset link" data-select-on-focus>
            <button type="button" class="btn btn-secondary btn-sm h-9" data-copy="${escapeHtml(link)}">${icon('copy')} Copy</button>
          </div>
        </div>`));
    }
  });
}
