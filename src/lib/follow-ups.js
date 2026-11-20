// Follow-up questions after a consequential answer (Phase 25, decision #196; the prompt rule is Phase 23): a reply may end with
// the exact lead-in "A few things worth a second look:" and a short bulleted list. The chat shows those bullets as chips that
// send the question; the stored text stays as written, so the voice note and the API read the list as it is. Pure.

export const NUDGE_LEAD = 'A few things worth a second look:';
const BULLET = /^\s*(?:[-*•]|\d{1,2}[.)])\s+(.+?)\s*$/;
const MAX_ITEMS = 5, ITEM_MAX = 200;

/**
 * Split a reply into its body and its follow-up questions → { body, items } (items: [] when there are none). Only the exact
 * lead-in, alone on its line, followed by nothing but bullet lines to the end of the reply, counts; anything else (the lead-in
 * mid-reply, other wording, a paragraph after the list) leaves the text whole with no items.
 */
export function splitFollowUps(text) {
  const src = String(text ?? '');
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const at = lines.findLastIndex(l => l.trim() === NUDGE_LEAD);
  if (at < 0) return { body: src, items: [] };
  const rest = lines.slice(at + 1).filter(l => l.trim());
  if (!rest.length || !rest.every(l => BULLET.test(l))) return { body: src, items: [] };
  const items = rest.slice(0, MAX_ITEMS).map(l => BULLET.exec(l)[1].replace(/\*\*|__/g, '').trim().slice(0, ITEM_MAX)).filter(Boolean);
  if (!items.length) return { body: src, items: [] };
  return { body: lines.slice(0, at).join('\n').replace(/\s+$/, ''), items };
}

/** The reply without its follow-up list (unchanged when it has none). */
export const withoutFollowUps = text => splitFollowUps(text).body;
