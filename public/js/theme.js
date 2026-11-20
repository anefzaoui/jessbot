// Theme: 'light' | 'dark' | 'system' (default). Stored in localStorage 'jb-theme'.
// The layout's inline script applies it before first paint; this module handles changes.
// Markup: <button data-theme-set="dark">  ·  [data-theme-current] shows the active choice.
import { on, $$ } from './core.js';

const KEY = 'jb-theme';
const media = matchMedia('(prefers-color-scheme: dark)');

export function getTheme() {
  try { return localStorage.getItem(KEY) || 'system'; } catch { return 'system'; }
}

function apply(choice) {
  const dark = choice === 'dark' || (choice === 'system' && media.matches);
  document.documentElement.classList.toggle('dark', dark);
  for (const el of $$('[data-theme-set]')) el.setAttribute('aria-checked', String(el.dataset.themeSet === choice));
  for (const el of $$('[data-theme-current]')) el.textContent = choice[0].toUpperCase() + choice.slice(1);
}

export function setTheme(choice) {
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch { /* private mode: still apply for this page */ }
  // Suppress transitions for one frame so the whole UI flips at once.
  document.documentElement.classList.add('no-transitions');
  apply(choice);
  requestAnimationFrame(() => requestAnimationFrame(() =>
    document.documentElement.classList.remove('no-transitions')));
}

export function initTheme() {
  apply(getTheme());
  media.addEventListener('change', () => { if (getTheme() === 'system') apply('system'); });
  on(document, 'click', '[data-theme-set]', (e, el) => setTheme(el.dataset.themeSet));
  on(document, 'click', '[data-theme-toggle]', () =>
    setTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark'));
}
