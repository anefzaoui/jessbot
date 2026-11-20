// Lightbox (owner request): tap any picture — chat screenshots, images in messages, reader articles, question
// screenshots, Library documents — to see it full screen. Fit ↔ actual size on tap (then pan by scrolling/dragging),
// previous/next through the pictures of the same message (arrows, ← →, swipe), close with Esc, the ✕, a tap outside or
// a swipe down. In-house, no libraries (decision: all browser JS/CSS is ours).
import { icon } from './core.js';

const SELECTOR = '[data-lightbox], .prose-jb img, .reader-article img';
const GROUP = '[data-run-owner], [data-question-card], .ask-dock, .reader-article, [data-message-id], .prose-jb, main';
let dlg, img, counter, openLink, list = [], index = 0;

function build() {
  dlg = document.createElement('dialog');
  dlg.className = 'lightbox';
  dlg.setAttribute('aria-label', 'Picture');
  dlg.innerHTML = `
    <div class="lightbox-bar">
      <span class="lightbox-count tabular" data-lb-count></span>
      <a class="btn btn-ghost btn-icon btn-sm lightbox-btn" target="_blank" rel="noopener" data-lb-open aria-label="Open the original">${icon('external-link', 'size-4')}</a>
      <button type="button" class="btn btn-ghost btn-icon btn-sm lightbox-btn" data-lb-close aria-label="Close">${icon('x', 'size-5')}</button>
    </div>
    <button type="button" class="lightbox-nav is-prev" data-lb-prev aria-label="Previous picture">${icon('chevron-left', 'size-6')}</button>
    <div class="lightbox-stage" data-lb-stage><img alt="" draggable="false" data-lb-img></div>
    <button type="button" class="lightbox-nav is-next" data-lb-next aria-label="Next picture">${icon('chevron-right', 'size-6')}</button>`;
  document.body.append(dlg);
  img = dlg.querySelector('[data-lb-img]');
  counter = dlg.querySelector('[data-lb-count]');
  openLink = dlg.querySelector('[data-lb-open]');
  const stage = dlg.querySelector('[data-lb-stage]');

  dlg.querySelector('[data-lb-close]').addEventListener('click', () => dlg.close());
  dlg.querySelector('[data-lb-prev]').addEventListener('click', () => show(index - 1));
  dlg.querySelector('[data-lb-next]').addEventListener('click', () => show(index + 1));
  stage.addEventListener('click', e => { if (e.target === stage) dlg.close(); }); // tap outside the picture
  img.addEventListener('click', () => { if (!moved) toggleZoom(); });
  dlg.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); show(index - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); show(index + 1); }
  });
  dlg.addEventListener('close', () => { dlg.classList.remove('is-zoomed'); img.removeAttribute('src'); document.documentElement.classList.remove('lightbox-open'); });

  // Drag to pan when zoomed; swipe to change picture or close when fitted.
  let start = null, moved = false;
  stage.addEventListener('pointerdown', e => { start = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop }; moved = false; });
  stage.addEventListener('pointermove', e => {
    if (!start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
    if (dlg.classList.contains('is-zoomed')) { stage.scrollLeft = start.left - dx; stage.scrollTop = start.top - dy; }
    else img.style.transform = `translate(${dx}px, ${Math.max(0, dy)}px)`;
  });
  const end = e => {
    if (!start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    start = null;
    img.style.transform = '';
    if (dlg.classList.contains('is-zoomed')) return;
    if (dy > 90 && Math.abs(dy) > Math.abs(dx)) dlg.close();
    else if (dx < -60) show(index + 1);
    else if (dx > 60) show(index - 1);
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', () => { start = null; img.style.transform = ''; });
}

function toggleZoom() {
  const zoom = !dlg.classList.contains('is-zoomed') && (img.naturalWidth > img.clientWidth || img.naturalHeight > img.clientHeight);
  dlg.classList.toggle('is-zoomed', zoom);
}

function show(i) {
  if (!list.length) return;
  index = (i + list.length) % list.length;
  const { src, alt } = list[index];
  dlg.classList.remove('is-zoomed');
  img.src = src;
  img.alt = alt || '';
  openLink.href = src;
  counter.textContent = list.length > 1 ? `${index + 1} / ${list.length}` : '';
  dlg.classList.toggle('is-single', list.length < 2);
}

const srcOf = el => el.dataset.lightbox || el.currentSrc || el.src || el.querySelector('img')?.src;

export function openLightbox(el) {
  if (!dlg) build();
  const group = el.closest(GROUP) || document.body;
  const items = [...group.querySelectorAll(SELECTOR)].filter(x => !x.closest('.lightbox'));
  const seen = new Set();
  list = items.map(x => ({ el: x, src: srcOf(x), alt: x.alt || x.querySelector?.('img')?.alt })).filter(x => x.src && !seen.has(x.src) && seen.add(x.src));
  const at = list.findIndex(x => x.src === srcOf(el));
  document.documentElement.classList.add('lightbox-open');
  if (!dlg.open) dlg.showModal();
  show(Math.max(0, at));
}

export function initLightbox() {
  document.addEventListener('click', e => {
    const el = e.target.closest(SELECTOR);
    if (!el || el.closest('.lightbox') || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (el.matches('img') && el.closest('a[href]:not([data-lightbox])')) return; // a picture that is a link keeps being a link
    e.preventDefault();
    openLightbox(el);
  });
}

