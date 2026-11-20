// Jessbot's website: the theme switch, the sky that follows the visitor's clock (like the app's), the live demo card,
// copy buttons and the install tabs. Everything works without it; it only adds behaviour.
(() => {
  const root = document.documentElement;
  const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

  // Theme: the system's unless the visitor picked one here.
  const isDark = () => root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const toggle = document.querySelector('[data-theme-toggle]');
  const label = () => toggle?.setAttribute('aria-label', isDark() ? 'Switch to light theme' : 'Switch to dark theme');
  toggle?.addEventListener('click', () => { root.dataset.theme = isDark() ? 'light' : 'dark'; store.set('jb-site-theme', root.dataset.theme); label(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', label);
  label();

  // Jess's sky follows the visitor's clock, as it does in the app: dawn, day, dusk, night.
  const hero = document.querySelector('.hero[data-sky]');
  if (hero) {
    const h = new Date().getHours();
    hero.dataset.sky = h >= 5 && h < 8 ? 'dawn' : h >= 8 && h < 17 ? 'day' : h >= 17 && h < 20 ? 'dusk' : 'night';
  }

  // The demo approval card: Approve or Deny changes its state, nothing is sent; "Show it again" resets it.
  const card = document.querySelector('[data-demo-card]');
  if (card) {
    const result = card.querySelector('[data-result]');
    const lines = { approved: 'Approved. In the app, this is the moment the email goes out, and not before.', denied: 'Denied. Nothing was sent, and Jess is told you said no.' };
    card.addEventListener('click', e => {
      const decide = e.target.closest('[data-decide]');
      if (decide) {
        card.dataset.status = decide.dataset.decide;
        result.textContent = lines[decide.dataset.decide] + ' ';
        const again = document.createElement('button');
        again.type = 'button'; again.textContent = 'Show the card again'; again.dataset.reset = '';
        result.append(again);
        again.focus();
        return;
      }
      if (e.target.closest('[data-reset]')) {
        card.dataset.status = 'pending'; result.textContent = '';
        card.querySelector('[data-decide="approved"]').focus();
      }
      const expand = e.target.closest('[data-expand]');
      if (expand) {
        const box = expand.closest('.approval-preview');
        const open = expand.getAttribute('aria-expanded') !== 'true';
        expand.setAttribute('aria-expanded', String(open));
        box.toggleAttribute('data-folded', !open);
      }
    });
  }

  // The recorded run plays on its own, unless the visitor asked for less motion: then it waits, with controls.
  const video = document.querySelector('.story-video video');
  if (video && matchMedia('(prefers-reduced-motion: reduce)').matches) { video.pause(); video.removeAttribute('autoplay'); video.controls = true; }

  // Copy buttons: the command in the field or code block they point at.
  document.addEventListener('click', async e => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const src = document.querySelector(btn.dataset.copy);
    const text = src?.value ?? src?.textContent ?? '';
    const lbl = btn.querySelector('[data-copy-label]');
    try { await navigator.clipboard.writeText(text); if (lbl) lbl.textContent = 'Copied'; }
    catch { if (src?.select) src.select(); if (lbl) lbl.textContent = 'Press Ctrl+C'; }
    setTimeout(() => { if (lbl) lbl.textContent = 'Copy'; }, 2000);
  });

  // Install tabs (arrow keys move between them).
  for (const tabs of document.querySelectorAll('[data-tabs]')) {
    const list = [...tabs.querySelectorAll('[role="tab"]')];
    const show = tab => {
      for (const t of list) {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
      }
    };
    tabs.addEventListener('click', e => { const t = e.target.closest('[role="tab"]'); if (t) show(t); });
    tabs.addEventListener('keydown', e => {
      const i = list.indexOf(document.activeElement);
      if (i < 0 || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      const next = list[(i + (e.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length];
      show(next); next.focus();
    });
  }
})();
