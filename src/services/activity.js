// Activity log — everything Jess did for a person, hour by hour (panel, /activity). Live via 'activity.new'.
import { all, get, run } from '../db/index.js';
import { publish } from '../lib/bus.js';
import { toIso } from './chatview.js';
import { dayLabel } from '../lib/when.js';

export function logActivity(userId, { kind = 'task', icon = null, title, detail = null, status = 'ok', href = null, runId = null }) {
  const { lastInsertRowid } = run(
    'INSERT INTO activity_log (user_id, kind, icon, title, detail, status, href, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    userId, kind, icon, String(title).slice(0, 160), detail ? String(detail).slice(0, 240) : null, status, href, runId);
  const item = view(get('SELECT * FROM activity_log WHERE id = ?', Number(lastInsertRowid)));
  publish(userId, 'activity.new', { item }, { runId });
  return item;
}

const view = a => ({ id: a.id, at: toIso(a.at), iconName: a.icon, title: a.title, detail: a.detail, status: a.status, href: a.href, kind: a.kind });

// Grouped by day in the person's timezone.
export function activityDays(user, { days = 14, limit = 300 } = {}) {
  const rows = all(`SELECT * FROM activity_log WHERE user_id = ? AND at >= datetime('now', ?) ORDER BY id DESC LIMIT ?`, user.id, `-${days} days`, limit);
  const out = [];
  for (const r of rows) {
    const v = view(r);
    const label = dayLabel(v.at, user.timezone || undefined);
    if (out.at(-1)?.label !== label) out.push({ label, count: 0, items: [] });
    out.at(-1).items.push(v);
    out.at(-1).count++;
  }
  return out;
}

export function todaySummary(user) {
  const today = activityDays(user, { days: 1 }).find(d => d.label === 'Today');
  if (!today) return null;
  const done = today.items.filter(i => i.status === 'ok');
  return { done: done.length, highlights: done.filter(i => i.kind !== 'message').slice(0, 4).map(i => i.title) };
}
