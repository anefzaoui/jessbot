// Admin → Overview's security card (Phase 25, decision #203): what the guards stopped lately, grouped so a pattern shows
// ("4 from newsletter@shop.example through Read email"). Built from the metadata-only audit rows the guards write:
//  - injection_suspected (agent/injection.js): { source: tool, from: host or sender, sha256, via, hidden } — never the text;
//  - secret_blocked (agent/loop.js, services/mail-files.js): { tool, secret: the kinds of secret, file? } — never the value.
// Nothing here reads or returns an excerpt: the audit log doesn't hold one, and this view must not grow one.
import { all } from '../db/index.js';
import { displayNameOf } from '../agent/tools/registry.js';

const parse = s => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };
const toIso = v => (v ? new Date(`${String(v).replace(' ', 'T')}Z`).toISOString() : null);

function group(rows, keyOf, make, add = () => {}) {
  const map = new Map();
  for (const r of rows) {
    const d = parse(r.detail);
    const key = keyOf(d);
    const g = map.get(key) || { ...make(d), count: 0, lastAt: null, people: [] };
    g.count++;
    add(g, d);
    g.lastAt ||= toIso(r.at); // rows come newest first
    if (r.person && !g.people.includes(r.person)) g.people.push(r.person);
    map.set(key, g);
  }
  return [...map.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
}

/**
 * The last `days` of suspected injections and blocked secrets → { days, total, injections: { total, groups, more },
 * secrets: { total, groups, more } }. Injection groups: { tool, toolLabel, from, count, lastAt, people, hidden (how many
 * carried hidden text) }. Secret groups: { tool, toolLabel, kinds, count, lastAt, people }. At most `limit` groups each.
 */
export function securityEvents({ days = 30, limit = 6 } = {}) {
  const rows = all(`SELECT a.action, a.detail, a.at, u.name AS person FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
    WHERE a.action IN ('injection_suspected', 'secret_blocked') AND a.at >= datetime('now', ?) ORDER BY a.id DESC LIMIT 1000`, `-${days} days`);
  const inj = rows.filter(r => r.action === 'injection_suspected');
  const sec = rows.filter(r => r.action === 'secret_blocked');
  const injections = group(inj, d => `${d.source || ''}|${String(d.from || '').toLowerCase()}`,
    d => ({ tool: d.source || null, toolLabel: d.source ? displayNameOf(d.source) : 'Something she read', from: d.from || null, hidden: 0 }),
    (g, d) => { if (d.hidden > 0) g.hidden++; });
  const secrets = group(sec, d => `${d.tool || ''}|${d.secret || ''}`,
    d => ({ tool: d.tool || null, toolLabel: d.tool ? displayNameOf(d.tool) : 'A tool', kinds: d.secret || 'a secret' }));
  const cut = list => ({ total: list.reduce((n, g) => n + g.count, 0), groups: list.slice(0, limit), more: Math.max(0, list.length - limit) });
  return { days, total: rows.length, injections: cut(injections), secrets: cut(secrets) };
}
