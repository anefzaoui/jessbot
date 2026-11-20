// Admin oversight (decision #36, revisited in #219): whether the admin may open other people's chats, projects, Library
// items, voice notes and screenshots (read-only, every chat view audited). A setting, OFF for a new install: a household
// assistant hears private things, and that is the members' business unless the household agrees otherwise. When it is on,
// everyone sees it: a line under the composer in their chat and on their You page. Installs from before the setting
// existed keep what they had (migration 053 turns it on there, since their members were already told).
import { settings } from '../db/index.js';
import { audit } from './audit.js';

const KEY = 'oversight';

/** Whether admins may read other people's chats and files. */
export const oversightOn = () => !!settings.get(KEY, {})?.readChats;

/** Whether this viewer may look at something that belongs to someone else (never change it). */
export const adminMayView = viewer => viewer?.role === 'admin' && oversightOn();

/** Turn it on or off (admins only; the route checks). */
export function setOversight(on, actorId) {
  const next = { readChats: !!on, changedAt: new Date().toISOString(), changedBy: actorId ?? null };
  settings.set(KEY, next);
  audit('admin.oversight', { actorId, detail: { readChats: next.readChats } });
  return next;
}

export const oversightState = () => ({ readChats: false, ...(settings.get(KEY, {}) || {}) });
