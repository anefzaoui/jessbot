// DEV ONLY: the styleguide's simulated You API (memories, import, busy sharing, signed-in sites) and the off-the-record
// switch of a side chat, so /styleguide/screens/me-* and `npm run ui:flows` drive the real partials and client code.
// State resets whenever a You screen is opened. Shapes follow services/memory.js, services/memory-import.js,
// services/users.js and browser/profiles.js.
import * as fx from './fixtures.js';

let memories = [];
let shareBusy = true;
export function resetYou() { memories = fx.me.memories.map(m => ({ ...m })); shareBusy = !!fx.me.profile.shareBusy; }
resetYou();

const DATE = /\b(\d{1,2}) (January|February|March|April|May|June|July|August|September|October|November|December)\b/i;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** A paste → candidates like previewImport(): one per line; "password" lines can't be saved; one we have is a duplicate. */
function preview(text) {
  const lines = String(text).split(/\n+/).map(l => l.replace(/^[-*•\d.)\s]+/, '').trim()).filter(Boolean).slice(0, 200);
  return { format: /^BEGIN:VCARD/i.test(text) ? 'vcard' : 'text', truncated: false, candidates: lines.map((t, i) => {
    const d = DATE.exec(t);
    const mm = d ? String(MONTHS.indexOf(d[2].toLowerCase()) + 1).padStart(2, '0') : null;
    return { key: `c${i + 1}`, text: t, kind: 'fact', date: d ? `${mm}-${d[1].padStart(2, '0')}` : null, recurs: d ? 'yearly' : null,
      dateLabel: d ? `${Number(d[1])} ${d[2][0].toUpperCase()}${d[2].slice(1, 3).toLowerCase()}, every year` : null, source: 'text',
      problem: /password|pin code/i.test(t) ? 'That looks like a password or code, and I never keep those.' : null,
      duplicateOf: memories.find(m => m.text.toLowerCase().replace(/\W/g, '') === t.toLowerCase().replace(/\W/g, ''))?.id ?? null };
  }) };
}

/** The simulated /api/v1 calls for these screens → { status?, body } or null. render(partial, data) → html. */
export async function youApi(method, path, query, body, render) {
  if (path === '/me/memories' && method === 'GET') {
    return { body: { memories, ...(query.fragment === '1' ? { html: await render('me/memory-list', { memories }) } : {}) } };
  }
  if (path === '/me/memories/import/preview' && method === 'POST') {
    if (!String(body.text || '').trim()) return { status: 422, body: { error: 'Validation failed', errors: { text: 'Paste the memories (or choose a .vcf file) first.' } } };
    const p = preview(body.text);
    return { body: { ...p, ...(query.fragment === '1' ? { html: await render('me/import-preview', { preview: p }) } : {}) } };
  }
  if (path === '/me/memories/import' && method === 'POST') {
    const saved = [], skipped = [];
    for (const it of body.items || []) {
      if (memories.some(m => m.text === it.text)) { skipped.push({ text: it.text, reason: 'Already remembered.' }); continue; }
      const m = { id: `mi${Date.now()}${saved.length}`, text: it.text, scope: 'private', createdAt: new Date().toISOString(), importance: 1, useCount: 0,
        pinned: false, date: it.date || null, recurs: it.recurs || null, dateLabel: null };
      memories.unshift(m);
      saved.push({ id: m.id, text: m.text });
    }
    return { body: { ok: true, saved, skipped } };
  }
  const pin = /^\/me\/memories\/([^/]+)\/pin$/.exec(path);
  if (pin) { const m = memories.find(x => x.id === pin[1]); if (m) m.pinned = !!body.pinned; return { body: { ok: true } }; }
  if (path === '/me/profile' && method === 'POST') {
    if (body.shareBusy !== undefined) shareBusy = !!body.shareBusy;
    return { body: { ok: true, user: { ...fx.user, ...fx.me.profile, shareBusy } } };
  }
  const site = /^\/me\/browser\/sites\/([^/]+)$/.exec(path);
  if (site && method === 'DELETE') return { body: { ok: true, removed: 4 } };
  const off = /^\/threads\/([^/]+)\/off-record$/.exec(path);
  if (off && method === 'POST') {
    if (typeof body.on !== 'boolean') return { status: 422, body: { error: 'Validation failed', errors: { on: 'Say on: true or on: false.' } } };
    return { body: { ok: true, offRecord: body.on } };
  }
  return null;
}
