// Reader mode (owner request): Readability's article HTML → safe, self-contained HTML for our own pages.
// sanitize-html keeps only reading markup (no scripts, styles, forms, embeds, event handlers); links and images are made
// absolute; images are then swapped for local copies by the caller (the page CSP only allows our own images).
import sanitizeHtml from 'sanitize-html';
import { dirAttr } from '../../public/js/bidi.js';

const abs = (u, base) => { try { const x = new URL(u, base); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };

/** Clean article HTML + the absolute image URLs in document order. */
export function cleanArticle(html, baseUrl) {
  const images = [];
  const out = sanitizeHtml(String(html || ''), {
    allowedTags: ['p', 'br', 'hr', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'strong', 'b', 'em', 'i',
      'u', 's', 'sub', 'sup', 'mark', 'small', 'span', 'a', 'img', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'caption', 'dl', 'dt', 'dd'],
    allowedAttributes: { a: ['href'], img: ['src', 'alt'], th: ['colspan', 'rowspan'], td: ['colspan', 'rowspan'] },
    allowedSchemes: ['http', 'https'],
    exclusiveFilter: frame => (frame.tag === 'a' && !frame.text.trim() && !frame.mediaChildren?.length) || (frame.tag === 'img' && !frame.attribs.src)
      || (['p', 'figure', 'li'].includes(frame.tag) && !frame.text.trim() && !frame.mediaChildren?.length),
    transformTags: {
      h1: 'h2', // the reader shows the title itself
      a: (tag, attribs) => {
        const href = abs(attribs.href, baseUrl);
        return href ? { tagName: 'a', attribs: { href, target: '_blank', rel: 'noopener noreferrer nofollow' } } : { tagName: 'span', attribs: {} };
      },
      img: (tag, attribs) => {
        // Lazy-loaded images often keep the real URL in data-src / srcset.
        const candidate = attribs['data-src'] || attribs['data-original'] || (attribs.srcset || attribs['data-srcset'] || '').split(',').pop()?.trim().split(/\s+/)[0] || attribs.src;
        const src = abs(candidate, baseUrl);
        if (src && !src.startsWith('data:')) images.push(src);
        return { tagName: 'img', attribs: src ? { src, alt: attribs.alt || '' } : {} };
      },
    },
    allowedSchemesAppliedToAttributes: ['href', 'src'],
  });
  // sanitize-html's allowedAttributes drop target/rel we added; add them back safely.
  const html2 = out.replace(/<a href="([^"]+)">/g, '<a href="$1" target="_blank" rel="noopener noreferrer nofollow">');
  return { html: html2, images: [...new Set(images)] };
}

/** Swap image URLs for local ones (map: remote → local path); images that couldn't be saved are removed. */
export function localizeImages(html, map) {
  return html.replace(/<img src="([^"]+)"( alt="[^"]*")?\s*\/?>/g, (m, src, alt) => (map.has(src.replace(/&amp;/g, '&'))
    ? `<img src="${map.get(src.replace(/&amp;/g, '&'))}"${alt || ' alt=""'} loading="lazy">` : ''));
}

/** Each top-level reading block gets the direction most of its words have (bidi.js; RTL articles, decision #68); what's
 *  nested inherits. Applied when an article is shown, so ones saved earlier carry it too. */
export const withDir = html => String(html || '').replace(/<(p|h[2-6]|ul|ol|blockquote|figcaption|table|dl)>([\s\S]*?)<\/\1>/g,
  (m, tag, inner) => `<${tag}${dirAttr(inner)}>${inner}</${tag}>`);

export const textOf = html => String(html || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

// Bot walls, consent walls and teaser pages that Readability happily "extracts".
const WALL = /\b(are you a robot|unusual (?:traffic|activity)|verify you are (?:a )?human|enable javascript|captcha|access denied|subscribe to (?:continue|read)|to continue reading|already a subscriber|sign in to read)\b/i;
const words = s => new Set(String(s || '').toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []);

/**
 * Is this cleaned HTML really the article? Enough prose in real paragraphs, not mostly links (footers, menus),
 * no bot/pay wall, and — when we know the headline — sharing some of its words.
 */
export function looksLikeArticle(html, headline = '') {
  const text = textOf(html);
  if (text.length < 600) return false;
  const linkText = [...String(html).matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)].map(m => textOf(m[1])).join(' ');
  if (linkText.length / text.length > 0.35) return false;
  const paras = [...String(html).matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].filter(m => textOf(m[1]).length > 80).length;
  if (paras < 3) return false;
  if (WALL.test(text.slice(0, 1500)) && text.length < 3000) return false;
  const want = words(headline);
  if (want.size >= 3) {
    const have = words(text.slice(0, 6000));
    if (![...want].some(w => have.has(w))) return false;
  }
  return true;
}
