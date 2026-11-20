// Copy buttons on code blocks (every message: replies, your own, library documents). In-house, no clipboard library.
import { on } from './core.js';
import { toast } from './toast.js';

export function initCodeCopy() {
  on(document, 'click', '[data-code-copy]', async (e, btn) => {
    const code = btn.closest('.code-block')?.querySelector('pre code')?.textContent ?? '';
    try {
      await navigator.clipboard.writeText(code);
    } catch { // non-secure context (http on a LAN IP): fall back to a hidden textarea
      const ta = Object.assign(document.createElement('textarea'), { value: code });
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.append(ta); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (!ok) return toast.error('Couldn’t copy. Select the code and copy it by hand.');
    }
    btn.textContent = 'Copied';
    btn.setAttribute('data-copied', '');
    setTimeout(() => { btn.textContent = 'Copy'; btn.removeAttribute('data-copied'); }, 1600);
  });
}
