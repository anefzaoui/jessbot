// Composer: per-thread draft persistence, Enter to send, optimistic bubble, failure → Retry, Stop.
// Server contract (POST data-send-url, body { text, clientId, attachments?: [libraryId] }):
//   → { messageHtml, runHtml?, runId? }  messageHtml replaces the optimistic bubble; runHtml is appended
//     (the assistant "working" block) and run.js attaches to it.
import { $, h, escapeHtml, api, storage } from './core.js';
import { toast } from './toast.js';
import { announce } from './shell.js';
import { initAttachments, attachmentsHtml } from './attach.js';

function optimisticBubble(text, clientId, files) {
  return h(`
    <article class="msg msg-user group flex flex-col items-end animate-rise" data-client-id="${clientId}" data-delivery="sending">
      ${attachmentsHtml(files)}
      ${text ? `<div class="max-w-[85%] msg-user-bubble rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-accent-ink shadow-sm sm:max-w-[75%]">${escapeHtml(text)}</div>` : ''}
      <div class="mt-1 flex h-5 items-center gap-2 px-1 text-[11px] text-ink-3">
        <span data-delivery-label><span class="spinner size-2.5"></span> Sending…</span>
      </div>
    </article>`);
}

export function initComposer() {
  const form = $('[data-composer]');
  if (!form) return;
  const input = $('[data-composer-input]', form);
  const sendBtn = $('[data-composer-send]', form);
  const stopBtn = $('[data-composer-stop]', form);
  const list = $('[data-message-list]');
  const draftKey = `jb-draft:${form.dataset.threadId}`;

  let files = null; // attach.js: the tray
  const sync = () => {
    sendBtn.disabled = !input.value.trim() && !files?.views().length;
    storage.set(draftKey, input.value);
  };
  files = initAttachments(form, { onChange: sync });

  // Restore draft (or ?draft= from the command palette).
  const urlDraft = new URLSearchParams(location.search).get('draft');
  input.value = urlDraft ?? storage.get(draftKey, '');
  if (urlDraft) history.replaceState(null, '', location.pathname);
  sync();
  if (input.value) input.focus();

  setRunning(form.hasAttribute('data-running'));

  input.addEventListener('input', sync);
  document.addEventListener('click', e => {
    const s = e.target.closest?.('[data-suggest]');
    if (!s) return;
    input.value = s.dataset.suggest;
    sync();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener('submit', e => {
    e.preventDefault();
    const text = input.value.trim();
    const attached = files?.views() || [];
    if (!text && !attached.length) return;
    if (files?.busy()) { toast('Still uploading. It’ll be ready in a moment.', { title: 'Hold on' }); return; }
    input.value = '';
    files?.clear();
    sync();
    send(text, null, attached);
  });

  // A turn sent from elsewhere on the page (#196): a follow-up chip's question, or "Simpler" ({ simpler: true }: the server adds
  // the plain-words note). Same optimistic bubble, Retry and idempotent resend as a typed message.
  document.addEventListener('composer:send', e => send(e.detail.text, null, [], e.detail.extra || {}));

  async function send(text, existing, attached = [], extra = {}) {
    const clientId = existing?.dataset.clientId || crypto.randomUUID();
    const bubble = existing || optimisticBubble(text, clientId, attached);
    if (!existing) { list?.append(bubble); scrollToEnd(); }
    setDelivery(bubble, 'sending');
    try {
      // Connection blips (server restart, Wi-Fi hiccup) are retried quietly: the send is idempotent per clientId.
      let res;
      for (let attempt = 0; ; attempt++) {
        try { res = await api(form.dataset.sendUrl, { method: 'POST', body: { text, clientId, attachments: attached.map(f => f.id), ...extra } }); break; } catch (err) {
          if (err.status !== 0 || attempt >= 4) throw err;
          await new Promise(r => setTimeout(r, 800 * 2 ** attempt)); // 0.8, 1.6, 3.2, 6.4 s
        }
      }
      if (res?.messageHtml) bubble.replaceWith(h(res.messageHtml)); else setDelivery(bubble, 'sent');
      if (res?.runHtml) { list?.append(h(res.runHtml)); setRunning(true); }
      scrollToEnd();
      document.dispatchEvent(new CustomEvent('chat:sent', { detail: res }));
    } catch (err) {
      setDelivery(bubble, 'failed');
      bubble.querySelector('[data-message-resend]')?.addEventListener('click', () => send(text, bubble, attached, extra), { once: true });
      toast.error(err.message, { title: 'Message not sent' });
      announce('Message not sent.');
    }
  }

  function setDelivery(bubble, state) {
    bubble.dataset.delivery = state;
    const label = bubble.querySelector('[data-delivery-label]');
    if (!label) return;
    label.innerHTML = state === 'sending' ? '<span class="spinner size-2.5"></span> Sending…'
      : state === 'failed' ? '<span class="font-medium text-bad">Not sent</span> · <button type="button" class="font-medium text-accent-text hover:underline" data-message-resend>Retry</button>'
        : 'Sent';
  }

  function setRunning(running) {
    stopBtn.hidden = !running;
    form.toggleAttribute('data-running', running);
  }
  document.addEventListener('run:state', e => setRunning(e.detail.active));
  stopBtn.addEventListener('click', () => document.dispatchEvent(new CustomEvent('run:cancel-request')));
}

export function scrollToEnd(smooth = true) {
  const scroller = $('[data-message-scroller]');
  if (scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
}
