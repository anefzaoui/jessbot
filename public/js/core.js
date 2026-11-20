// Jessbot client core — tiny shared helpers. No third-party dependencies.
import { textDir } from './bidi.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Delegated events: on(document, 'click', '[data-x]', (e, el) => …)
export function on(root, type, selector, handler, opts) {
  const listener = e => {
    const el = e.target.closest?.(selector);
    if (el && root.contains(el)) handler(e, el);
  };
  root.addEventListener(type, listener, opts);
  return () => root.removeEventListener(type, listener, opts);
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);

// Build a DOM node from an HTML string (callers must escape dynamic values).
export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export const icon = (name, cls = 'size-4') =>
  `<svg class="icon ${escapeHtml(cls)}" aria-hidden="true" focusable="false"><use href="/icons.svg?v=${escapeHtml(document.documentElement.dataset.assetV || '')}#${escapeHtml(name)}"/></svg>`;

// Work in progress, shown where the result will land: an activity glyph (motions as in the run card), a label and
// placeholder lines. Mirrors partials/loader.hbs.
export const loader = (label, { motion = 'thinking', iconName = 'sparkles', lines = 3 } = {}) =>
  `<div class="loader" role="status"><span class="run-glyph" data-motion="${motion}">${icon(iconName, 'size-4')}</span>`
  + `<span class="min-w-0 flex-1"><span class="loader-label">${escapeHtml(label)}</span>`
  + `<span class="loader-lines">${'<i></i>'.repeat(lines)}</span></span></div>`;

// Text fields follow what's typed in them (Arabic flips the field right-to-left, decision #68). Emails, URLs, passwords and
// numbers stay LTR. Covers fields added later too (dialogs, docks) via focusin.
const BIDI_FIELDS = 'textarea, input:not([type]), input[type="text"], input[type="search"]';
export function initBidi() {
  // Most words decide (bidi.js), re-checked as they type; a field someone gave a fixed dir keeps it.
  const fit = el => {
    if (!el.matches?.(BIDI_FIELDS) || el.dataset.dirFixed != null) return;
    if (el.hasAttribute('dir') && !el.dataset.dirAuto) { el.dataset.dirFixed = ''; return; }
    el.dataset.dirAuto = '1';
    el.dir = textDir(el.value) || 'auto';
  };
  document.querySelectorAll(BIDI_FIELDS).forEach(fit);
  document.addEventListener('focusin', e => fit(e.target));
  document.addEventListener('input', e => fit(e.target));
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---- Network ---------------------------------------------------------------
export class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data; }
}

// JSON fetch against our own API. Throws ApiError with a human message.
export async function api(path, { method = 'GET', body, signal, headers } = {}) {
  // The dev styleguide points API calls at a simulated backend (<html data-api-base="/styleguide/sim">).
  const base = document.documentElement.dataset.apiBase;
  if (base && /^\/(api|admin|upcoming)\//.test(path)) path = base + path;
  let res;
  try {
    res = await fetch(path, {
      method,
      signal,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'jessbot',
        ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError("Can't reach Jessbot. Check your connection.", 0);
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json().catch(() => null) : null;
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data);
  return data;
}

// ---- Feedback --------------------------------------------------------------
// Put a button into a busy state while a promise runs; restores on settle.
export async function withBusy(button, work, busyLabel) {
  if (!button || button.getAttribute('aria-busy') === 'true') return work();
  const original = button.innerHTML;
  button.setAttribute('aria-busy', 'true');
  button.disabled = true;
  button.innerHTML = `<span class="spinner" aria-hidden="true"></span>${busyLabel ? `<span>${escapeHtml(busyLabel)}</span>` : ''}`
    + `<span class="sr-only">Working…</span>`;
  try {
    return await work();
  } finally {
    button.innerHTML = original;
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

// ---- Time ------------------------------------------------------------------
export function formatElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const UNITS = [['year', 31536e6], ['month', 2592e6], ['week', 6048e5], ['day', 864e5],
  ['hour', 36e5], ['minute', 6e4], ['second', 1e3]];
export function timeAgo(date) {
  const diff = new Date(date).getTime() - Date.now();
  if (Math.abs(diff) < 45e3) return diff > 0 ? 'in a moment' : 'just now';
  for (const [unit, ms] of UNITS) if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit);
  return 'just now';
}

// Keep <time data-relative datetime="…"> and [data-elapsed-since] fresh.
export function startClocks() {
  const tick = () => {
    for (const el of $$('time[data-relative]')) el.textContent = timeAgo(el.dateTime);
    for (const el of $$('[data-elapsed-since]')) el.textContent = formatElapsed(Date.now() - new Date(el.dataset.elapsedSince));
  };
  tick();
  setInterval(tick, 1000);
}

// The assistant's name as the admin set it (#7; <html data-bot-name>). Copy names it; it never assumes "she".
export const botName = () => document.documentElement.dataset.botName || 'Jess';

export const storage = {
  get(key, fallback = null) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};
