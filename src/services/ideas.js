// Ideas (decision #55): things Jess thinks she can take off a person's plate, found by reflecting on their
// conversations (src/agent/goals.js → reflect), plus built-in starters for new people. Contract: partials/idea-card.hbs.
import crypto from 'node:crypto';
import { get, all, run } from '../db/index.js';
import { invalid, notFound } from '../lib/errors.js';
import { STARTER_IDEAS } from '../content/starters.js';

export const IDEA_CATEGORIES = ['Everyday', 'Health', 'Money', 'Work', 'Family', 'Home', 'Learning', 'Errands', 'Fun'];
export const IDEA_ICONS = [
  { iconName: 'lightbulb' }, { iconName: 'heart-pulse' }, { iconName: 'wallet' }, { iconName: 'briefcase' }, { iconName: 'users' },
  { iconName: 'house' }, { iconName: 'graduation-cap' }, { iconName: 'shopping-cart' }, { iconName: 'party-popper' }, { iconName: 'calendar-clock' },
  { iconName: 'file-text' }, { iconName: 'map' }, { iconName: 'utensils' }, { iconName: 'dumbbell' }, { iconName: 'baby' },
  { iconName: 'car' }, { iconName: 'plane' }, { iconName: 'gift' }, { iconName: 'search' }, { iconName: 'sparkles' },
].map(i => i.iconName);
const SNOOZE_DAYS = 3;
// What kind of help an idea is (reflection says, decision #199): only research, plan, draft and comparison ideas are prepared
// overnight (services/prep.js); anything else is 'other'.
export const IDEA_KINDS = ['research', 'plan', 'draft', 'comparison', 'other'];

export function addIdea(user, { title, why, category, icon, prompt, kind = null, sourceThreadId = null, sourceMessageId = null }) {
  const t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const p = String(prompt || '').trim().slice(0, 1500);
  if (t.length < 3 || !p) return null;
  // Never suggest the same thing twice (including ones they dismissed).
  if (get('SELECT 1 FROM ideas WHERE user_id = ? AND lower(title) = lower(?)', user.id, t)) return null;
  const publicId = crypto.randomBytes(6).toString('base64url');
  run(`INSERT INTO ideas (public_id, user_id, title, why, category, icon, prompt, kind, source_thread_id, source_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    publicId, user.id, t, String(why || '').trim().slice(0, 300) || t, IDEA_CATEGORIES.includes(category) ? category : 'Everyday',
    IDEA_ICONS.includes(icon) ? icon : 'lightbulb', p, IDEA_KINDS.includes(kind) ? kind : null, sourceThreadId, sourceMessageId);
  return get('SELECT * FROM ideas WHERE public_id = ?', publicId);
}

export function ideaForUser(user, publicId) {
  const i = get('SELECT * FROM ideas WHERE public_id = ? AND user_id = ?', String(publicId), user.id);
  if (!i) throw notFound('That idea is gone.');
  return i;
}

export const starterFor = id => STARTER_IDEAS.find(s => s.id === id) || null;

/** Starters aren't stored until someone acts on one; then they get a row like any idea (so dismiss/Undo/start work). */
export function storedStarter(user, starter) {
  return get('SELECT * FROM ideas WHERE user_id = ? AND title = ?', user.id, starter.title)
    || addIdea(user, { title: starter.title, why: starter.why, category: 'Everyday', icon: starter.iconName, prompt: starter.prompt });
}

/** An idea by its public id, or a built-in starter by its id. */
export const resolveIdea = (user, id) => { const s = starterFor(id); return s ? storedStarter(user, s) : ideaForUser(user, id); };

// Why an idea was turned down (decision #185). "Not now" is a snooze, never a rejection (a deferral says nothing about
// the idea); the other two are durable and keep anything like it from being suggested again.
export const DISMISS_REASONS = [
  { value: 'not_for_me', label: 'Not for me' }, { value: 'already_doing', label: 'Already doing it' }, { value: 'not_now', label: 'Not now' },
];
const REASON_LABEL = Object.fromEntries(DISMISS_REASONS.map(r => [r.value, r.label]));

/** state: new | seen | snoozed | dismissed | started. A dismissal may say why ({ reason, note }); reason 'not_now' snoozes. */
export function setIdeaState(idea, state, { reason = null, note = null } = {}) {
  if (reason != null && !REASON_LABEL[reason]) throw invalid({ reason: 'Pick one of the reasons, or none.' });
  if (state === 'dismissed' && reason === 'not_now') state = 'snoozed';
  const why = state === 'dismissed' ? [reason || null, String(note || '').replace(/\s+/g, ' ').trim().slice(0, 300) || null] : [null, null];
  run('UPDATE ideas SET state = ?, snooze_until = ?, dismiss_reason = ?, dismiss_note = ? WHERE id = ?', state,
    state === 'snoozed' ? new Date(Date.now() + SNOOZE_DAYS * 864e5).toISOString() : null, ...why, idea.id);
  return state;
}

/** Ideas turned down with a durable reason or their own words, newest first, as "Title (already doing it: I have a trainer)". */
export const turnedDown = (user, limit = 10) => all(`SELECT title, dismiss_reason, dismiss_note FROM ideas WHERE user_id = ?
  AND state = 'dismissed' AND (dismiss_reason IS NOT NULL OR dismiss_note IS NOT NULL) ORDER BY id DESC LIMIT ?`, user.id, limit)
  .map(i => `${i.title} (${[i.dismiss_reason && REASON_LABEL[i.dismiss_reason].toLowerCase(), i.dismiss_note].filter(Boolean).join(': ')})`);

/** What the person has already seen or turned down, so reflection doesn't repeat itself. */
export const ideaTitles = user => all('SELECT title, state FROM ideas WHERE user_id = ? ORDER BY id DESC LIMIT 80', user.id);

export function ideaView(i) {
  const source = i.source_thread_id && get('SELECT id, kind, title FROM threads WHERE id = ? AND deleted_at IS NULL', i.source_thread_id);
  // Prepared overnight (#199): the Library draft, for the "Ready for you" card (the screen is Phase 25).
  const item = i.prepared_item_id && get('SELECT public_id, title, type FROM library_items WHERE id = ? AND deleted_at IS NULL', i.prepared_item_id);
  const prepThread = item && i.prep_run_id ? get('SELECT thread_id FROM runs WHERE id = ?', i.prep_run_id)?.thread_id : null;
  return {
    id: i.public_id, title: i.title, why: i.why, category: i.category, iconName: i.icon || 'lightbulb', kind: i.kind || null,
    sourceLabel: source ? (source.kind === 'main' ? 'our chat' : `“${source.title || 'a side chat'}”`) : null,
    sourceHref: source ? `/chat/${source.id}` : null,
    isNew: i.state === 'new',
    prepared: item ? { itemId: item.public_id, title: item.title, type: item.type, href: `/library/${item.public_id}`,
      readyAt: i.ready_at || null, chatHref: prepThread ? `/chat/${prepThread}` : null } : null,
  };
}

export function ideasData(user) {
  const now = new Date().toISOString();
  const rows = all(`SELECT * FROM ideas WHERE user_id = ? AND (state IN ('new', 'seen') OR (state = 'snoozed' AND snooze_until <= ?))
    ORDER BY id DESC LIMIT 60`, user.id, now);
  const stored = new Set(all('SELECT title FROM ideas WHERE user_id = ?', user.id).map(r => r.title)); // acted-on starters live as ideas
  const items = rows.map(ideaView);
  return {
    items, categories: [...new Set(items.map(i => i.category))], dismissReasons: DISMISS_REASONS, // the "why?" chips (Phase 25)
    // Overnight prep (#199): ideas with a draft ready (after quiet hours), and this person's setting (off | ideas).
    ready: items.filter(i => i.prepared?.readyAt), prep: get('SELECT prep FROM users WHERE id = ?', user.id)?.prep || 'off',
    // Starters stay until the person has a handful of their own (blank-canvas help, transcript T1).
    starters: items.length >= 6 ? [] : STARTER_IDEAS.filter(s => !stored.has(s.title)),
  };
}

/** Seen once the Ideas page has shown them: the nav badge clears; the cards keep "New" for that visit (view built first). */
export const markSeen = user => run(`UPDATE ideas SET state = 'seen' WHERE user_id = ? AND state = 'new'`, user.id);
