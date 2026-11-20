// DEV ONLY: the styleguide's simulated Lists API. A small in-memory household (reset whenever a Lists screen is opened),
// so /styleguide/screens/lists* and `npm run ui:flows` drive the real partials and public/js/lists.js without a database.
// The shapes come from services/lists.js itself (parseItem, inferCategory, detailOf, cardOf), so a contract change
// breaks the styleguide visibly instead of drifting.
import { parseItem, inferCategory, detailOf, cardOf, KIND_META, KINDS } from '../services/lists.js';

const VIEWER = 1;
const PEOPLE = new Map([[1, 'Alex'], [2, 'Maya'], [3, 'Keiko']]);
const FAMILY = [1, 2, 3];
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone; // the machine's, like the browser's in ui:flows
const ago = ms => new Date(Date.now() - ms).toISOString();
const soon = ms => new Date(Date.now() + ms).toISOString();
const min = 60e3, hour = 36e5, day = 864e5;

let state = null;
let nextId = 1000;

function seed() {
  const item = (text, extra = {}) => ({ id: nextId++, text, qty: null, category: null, assigneeId: null, dueAt: null, doneAt: null, doneById: null, bought: false, createdBy: 1, ...extra });
  const shop = (text, qty, category, extra) => item(text, { qty, category, ...extra });
  return [
    { id: 1, title: 'Weekly shop', kind: 'shopping', shared: true, ownerId: 1, wisherId: null, archived: false, updatedAt: ago(4 * min), items: [
      shop('Milk', '1 L', 'Dairy & eggs'), shop('Eggs', '12', 'Dairy & eggs', { createdBy: 2 }), shop('Tomatoes', '1 kg', 'Fruit & veg'),
      shop('Bananas', null, 'Fruit & veg', { createdBy: 3 }), shop('Harissa', null, 'Pantry'), shop('Couscous', '1 kg', 'Pantry'),
      shop('Sparkling water', '6 bottles', 'Drinks'), shop('Toilet paper', null, 'Household', { createdBy: 2 }), shop('Birthday candles', null, null),
      shop('Bread', null, 'Bakery', { doneAt: ago(20 * min), doneById: 2 }), shop('Olive oil', '1 L', 'Pantry', { doneAt: ago(26 * min), doneById: 1 }),
    ] },
    { id: 2, title: 'House to-dos', kind: 'todo', shared: true, ownerId: 1, wisherId: null, archived: false, updatedAt: ago(2 * hour), items: [
      item('Call the dentist to confirm Friday', { assigneeId: 1, dueAt: soon(20 * hour) }),
      item('Renew the car insurance', { dueAt: ago(day + 3 * hour) }),
      item('Book swimming lessons for Keiko', { assigneeId: 2, createdBy: 2 }),
      item('Fix the dripping bathroom tap'),
      item('Pay the electricity bill', { doneAt: ago(5 * hour), doneById: 1 }),
    ] },
    { id: 3, title: 'Keiko’s birthday', kind: 'wish', shared: true, ownerId: 3, wisherId: 3, archived: false, updatedAt: ago(day), items: [
      item('Roller skates, size 32', { createdBy: 3 }), item('A watercolour set', { createdBy: 3 }), item('Dinosaur pyjamas', { createdBy: 3 }),
      item('Lego Friends treehouse', { createdBy: 3, doneAt: ago(2 * day), doneById: 2, bought: true }),
    ] },
    { id: 4, title: 'Lyon weekend', kind: 'packing', shared: false, ownerId: 1, wisherId: null, archived: false, updatedAt: ago(3 * day), items: [
      item('Passports'), item('Phone chargers', { qty: '2' }), item('Rain jackets'),
    ] },
    { id: 5, title: 'Christmas 2025', kind: 'wish', shared: true, ownerId: 1, wisherId: 1, archived: true, updatedAt: ago(40 * day), items: [item('Board game'), item('Scarf')] },
  ];
}

export function resetLists({ empty = false } = {}) { state = empty ? [] : seed(); }
const lists = () => { if (!state) resetLists(); return state; };

const nameOf = id => PEOPLE.get(id) ?? null;
const itemView = (i, list) => {
  // As services/lists.js seenDone: the wisher never sees that a wish was bought.
  const done = !!i.doneAt && !(i.bought && VIEWER === list.wisherId);
  return { id: i.id, text: i.text, qty: i.qty, category: i.category, assigneeId: i.assigneeId, assignee: nameOf(i.assigneeId), dueAt: i.dueAt,
    done, doneAt: done ? i.doneAt : null, doneById: done ? i.doneById : null, doneBy: done ? nameOf(i.doneById) : null, bought: done && i.bought,
    createdBy: nameOf(i.createdBy), pos: i.id };
};
const listView = l => {
  const done = l.items.filter(i => itemView(i, l).done).length;
  return { id: l.id, title: l.title, kind: l.kind, scope: l.shared ? 'Family' : 'private', shared: l.shared, ownerId: l.ownerId, owner: nameOf(l.ownerId),
    wisherId: l.wisherId, wisher: nameOf(l.wisherId), canManage: true, open: l.items.length - done, done, archived: l.archived, updatedAt: l.updatedAt };
};
const members = l => (l.shared ? FAMILY : [VIEWER]).map(id => ({ id, name: nameOf(id) }));

export const listsPage = () => ({
  lists: lists().filter(l => !l.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(l => cardOf(listView(l), l.items.filter(i => !itemView(i, l).done))),
  archived: lists().filter(l => l.archived).map(l => cardOf(listView(l), [])),
  places: [{ value: 'private', label: 'Just me', members: [{ id: VIEWER, name: nameOf(VIEWER) }] }, { value: 'Family', label: 'Family', members: members({ shared: true }) }],
  kinds: KINDS.map(k => ({ value: k, ...KIND_META[k] })),
});

const find = id => lists().find(l => String(l.id) === String(id) && !l.archived);
export const listDetail = id => {
  const l = find(id);
  if (!l) return null;
  const items = l.items.map(i => itemView(i, l)).sort((a, b) => Number(a.done) - Number(b.done) || a.id - b.id);
  return detailOf({ list: listView(l), items, members: members(l) }, { viewerId: VIEWER, tz: TZ });
};

/** The simulated /api/v1/lists* → { status?, body } or null when the path isn't a lists call. render(partial, data) → html. */
export async function listsApi(method, path, query, body, render) {
  const m = /^\/lists(?:\/(\d+))?(?:\/(items|restore|clear-done))?(?:\/(\d+))?$/.exec(path);
  if (!m) return null;
  const [, id, sub, itemId] = m;
  const touch = l => { l.updatedAt = new Date().toISOString(); };
  const notFound = { status: 404, body: { error: 'That list isn’t there.' } };
  if (!id) {
    if (method === 'POST') {
      const kind = KINDS.includes(body.kind) ? body.kind : 'custom';
      const title = String(body.title || '').trim() || { shopping: 'Shopping', todo: 'To-do', wish: 'Wish list', packing: 'Packing', custom: 'List' }[kind];
      const shared = body.scope === 'Family';
      const same = lists().find(l => !l.archived && l.shared === shared && l.title.toLowerCase() === title.toLowerCase());
      if (same) return { body: { list: listView(same), existed: true } };
      const l = { id: nextId++, title, kind, shared, ownerId: VIEWER, wisherId: kind === 'wish' ? Number(body.wisherId) || VIEWER : null, archived: false, updatedAt: new Date().toISOString(), items: [] };
      lists().push(l);
      return { status: 201, body: { list: listView(l), existed: false } };
    }
    if (query.archived === '1') return { body: { lists: lists().filter(l => l.archived).map(listView) } };
    const page = listsPage();
    return { body: { lists: page.lists, ...(query.fragment === '1' ? { html: await render('lists/index-body', { page }) } : {}) } };
  }
  if (sub === 'restore') {
    const l = lists().find(x => String(x.id) === id);
    if (!l) return notFound;
    l.archived = false; touch(l);
    return { body: { list: listView(l) } };
  }
  const l = find(id);
  if (!l) return notFound;
  if (!sub) {
    if (method === 'PATCH') {
      const t = String(body.title || '').trim();
      if (!t) return { status: 422, body: { error: 'Validation failed', errors: { title: 'Give the list a name.' } } };
      l.title = t.slice(0, 60); touch(l);
      return { body: { list: listView(l) } };
    }
    if (method === 'DELETE') { l.archived = true; touch(l); return { body: { ok: true } }; }
    const detail = listDetail(id);
    return { body: { list: detail.list, items: detail.items, members: detail.members, ...(query.fragment === '1' ? { html: await render('lists/items', { detail }) } : {}) } };
  }
  if (sub === 'clear-done') {
    const before = l.items.length;
    l.items = l.items.filter(i => !itemView(i, l).done); touch(l);
    return { body: { removed: before - l.items.length } };
  }
  // Items
  if (!itemId && method === 'POST') {
    const out = { added: [], updated: [], already: [] };
    for (const raw of Array.isArray(body.items) ? body.items : [body]) {
      const text = String(typeof raw === 'string' ? raw : raw.text || '').trim();
      if (!text) continue;
      const parsed = !raw.qty && l.kind === 'shopping' ? parseItem(text) : { text, qty: raw.qty || null };
      const open = l.items.find(i => !i.doneAt && i.text.toLowerCase() === parsed.text.toLowerCase());
      if (open) {
        if (parsed.qty && parsed.qty !== open.qty) { open.qty = parsed.qty; out.updated.push(itemView(open, l)); } else out.already.push(itemView(open, l));
        continue;
      }
      const it = { id: nextId++, text: parsed.text, qty: parsed.qty, category: raw.category || (l.kind === 'shopping' ? inferCategory(parsed.text) : null),
        assigneeId: raw.assigneeId ?? null, dueAt: raw.due || null, doneAt: null, doneById: null, bought: false, createdBy: VIEWER };
      l.items.push(it);
      out.added.push(itemView(it, l));
    }
    touch(l);
    return { status: out.added.length ? 201 : 200, body: { ...out, list: listView(l) } };
  }
  const it = l.items.find(i => String(i.id) === itemId);
  if (!it) return { status: 404, body: { error: 'That item isn’t on this list.' } };
  if (method === 'DELETE') { l.items = l.items.filter(i => i !== it); touch(l); return { body: { ok: true } }; }
  if (method === 'PATCH') {
    for (const k of ['text', 'qty', 'category']) if (body[k] !== undefined) it[k] = String(body[k] || '').trim() || (k === 'text' ? it.text : null);
    if (body.assigneeId !== undefined) it.assigneeId = body.assigneeId == null ? null : Number(body.assigneeId);
    if (body.due !== undefined) it.dueAt = body.due || null;
    if (body.done !== undefined) {
      it.doneAt = body.done ? new Date().toISOString() : null;
      it.doneById = body.done ? VIEWER : null;
      it.bought = !!body.done && l.kind === 'wish' && VIEWER !== l.wisherId;
    }
    touch(l);
    return { body: { item: itemView(it, l) } };
  }
  return null;
}
