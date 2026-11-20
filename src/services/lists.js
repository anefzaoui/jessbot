// Family lists (decision #139): shopping, to-dos, wish and packing lists. A list lives in a memory scope (services/memory.js):
// the person's own, or a group they belong to. The scope is ALWAYS derived on the server from who is asking, with the same
// rules as memories: you read your own lists and your groups' lists, you write only where you belong, and nothing crosses
// to anyone else. Items change one row at a time (add, tick, untick, remove), so two parents shopping at once never
// overwrite each other. Wish lists: when someone other than the wisher ticks an item it is "bought" — the wisher still
// sees it as open. Every change is published as `list.updated` ({ listId } only) to the list's members, so an open page
// refetches through the API, which applies those rules.
import { get, all, run, tx } from '../db/index.js';
import { readableScopes, writableScope, userScope, groupScope } from './memory.js';
import { groupsOfUser } from './groups.js';
import { publish } from '../lib/bus.js';
import { invalid, notFound, forbidden } from '../lib/errors.js';
import { stripInvisible } from '../lib/untrusted.js';
import { tzOf, localLabel } from '../lib/when.js';

export const KINDS = ['shopping', 'todo', 'wish', 'packing', 'custom'];
export const DEFAULT_TITLES = { shopping: 'Shopping', todo: 'To-do', wish: 'Wish list', packing: 'Packing', custom: 'List' };
const TITLE_MAX = 60;
const TEXT_MAX = 200;
export const BATCH_MAX = 50;
export const OPEN_MAX = 500; // open items per list

// ---- Words ---------------------------------------------------------------------------------------------------------
const clean = (s, max) => stripInvisible(String(s ?? '')).replace(/\s+/g, ' ').trim().slice(0, max);
// Arabic-Indic and Persian digits → ASCII, so "٢ كيلو أرز" parses like "2 kg rice".
const asciiDigits = s => s.replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x6F0));
// For matching only: case, Latin accents, Arabic short vowels / tatweel and alef/yeh/teh-marbuta forms folded.
export function fold(s) {
  return asciiDigits(String(s || '')).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/œ/g, 'oe').replace(/æ/g, 'ae').replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim();
}
const tokensOf = s => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
// "eggs" and "egg", "tomatoes" and "tomato" are one item; Arabic keeps its words, minus the article.
const stem = w => (/^[a-z]+$/.test(w) && w.length > 3 ? w.replace(/(oes|ies|es|s)$/, m => (m === 'ies' ? 'y' : m === 'oes' ? 'o' : m === 'es' && !/(ch|sh|x|ss)es$/.test(w) ? 'e' : '')) : w.replace(/^ال(?=\p{L}{2})/u, ''));
export const itemKey = s => tokensOf(s).map(stem).join(' ');

// ---- "Milk 1L", "2 kg rice", "eggs x12" → { text, qty } -------------------------------------------------------------
const UNIT_WORDS = {
  kg: ['kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms', 'kilogramme', 'kilogrammes', 'كيلو', 'كغ', 'كلغ', 'كيلوغرام'],
  g: ['g', 'gr', 'grs', 'gram', 'grams', 'gramme', 'grammes', 'غرام', 'غ', 'جرام'],
  mg: ['mg'],
  L: ['l', 'lt', 'ltr', 'litre', 'litres', 'liter', 'liters', 'لتر', 'ل'],
  ml: ['ml'], cl: ['cl'], dl: ['dl'],
  lb: ['lb', 'lbs', 'pound', 'pounds'], oz: ['oz', 'ounce', 'ounces'],
  pack: ['pack', 'packs', 'packet', 'packets', 'paquet', 'paquets', 'باكو', 'باكيت'],
  box: ['box', 'boxes', 'boite', 'boites', 'boîte', 'boîtes', 'علبة', 'علب'],
  bottle: ['bottle', 'bottles', 'bouteille', 'bouteilles', 'قارورة', 'قوارير'],
  can: ['can', 'cans', 'tin', 'tins', 'canette', 'canettes', 'conserve', 'conserves'],
  jar: ['jar', 'jars', 'pot', 'pots', 'bocal', 'bocaux'],
  bag: ['bag', 'bags', 'sachet', 'sachets', 'كيس', 'أكياس'],
  dozen: ['dozen', 'douzaine', 'douzaines', 'دزينة'],
  pc: ['pc', 'pcs', 'piece', 'pieces', 'pièce', 'pièces', 'حبة', 'حبات'],
  loaf: ['loaf', 'loaves'], bunch: ['bunch', 'bunches', 'botte', 'bottes', 'ربطة'],
  roll: ['roll', 'rolls', 'rouleau', 'rouleaux'],
};
const UNIT_OF = new Map(Object.entries(UNIT_WORDS).flatMap(([u, ws]) => ws.map(w => [fold(w), u])));
const COUNTABLE = new Set(['pack', 'box', 'bottle', 'can', 'jar', 'bag', 'dozen', 'loaf', 'bunch', 'roll', 'pc']);
const PLURAL = { box: 'boxes', loaf: 'loaves', bunch: 'bunches', pc: 'pcs', dozen: 'dozen' };
const FRACTIONS = { '½': 0.5, '¼': 0.25, '¾': 0.75 };
const NUM = '(\\d+(?:[.,]\\d+)?|[½¼¾])';
const numOf = s => (FRACTIONS[s] ?? Number(String(s).replace(',', '.')));

function qtyLabel(n, unit) {
  const num = Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
  if (!unit) return num;
  if (COUNTABLE.has(unit)) return `${num} ${n === 1 ? unit : PLURAL[unit] || `${unit}s`}`;
  return `${num} ${unit}`;
}

/** A quantity given on its own ("1L", "2kg", "3 bottle") → the same form parseItem gives ("1 L", "2 kg", "3 bottles");
 *  anything it can't read stays as written. */
export function normalizeQty(q) {
  if (!q) return q;
  const p = parseItem(`item ${q}`);
  return p.text === 'item' && p.qty ? p.qty : q;
}

/** "Milk 1L" → { text: 'Milk', qty: '1 L' }; "2 kg rice" → { text: 'rice', qty: '2 kg' }; "3 apples" → { text: 'apples', qty: '3' }.
 *  A number at the end only counts with a unit or an "x" ("iPhone 15" stays whole). */
export function parseItem(raw) {
  const s = asciiDigits(clean(raw, TEXT_MAX));
  const unitOf = w => (w ? UNIT_OF.get(fold(w)) : null);
  // Leading: "2 kg rice", "2kg of rice", "1.5 l de lait", "3 apples", "2x milk", "٢ كيلو أرز"
  let m = new RegExp(`^${NUM}\\s*([\\p{L}.]+)?\\s+(.+)$`, 'u').exec(s) || new RegExp(`^${NUM}([\\p{L}]+)$`, 'u').exec(s);
  if (m) {
    const n = numOf(m[1]);
    const u = unitOf(m[2]?.replace(/\.$/, ''));
    if (m[3] && u && Number.isFinite(n)) {
      const text = m[3].replace(/^(?:of|de|d'|du|des|x)\s*/i, '').trim();
      if (text) return { text, qty: qtyLabel(n, u) };
    }
    if (m[3] && !m[2] && Number.isFinite(n) && n > 0) return { text: m[3].replace(/^(?:x|×)\s*/i, '').trim(), qty: qtyLabel(n, null) };
    if (m[3] && /^[x×]$/i.test(m[2] || '') && Number.isFinite(n)) return { text: m[3].trim(), qty: qtyLabel(n, null) };
  }
  // Trailing: "Milk 1L", "rice 2 kg", "eggs x12", "eggs ×12", "milk (2 L)"
  m = new RegExp(`^(.+?)\\s*\\(\\s*${NUM}\\s*([\\p{L}.]+)?\\s*\\)$`, 'u').exec(s) || new RegExp(`^(.+?)\\s+${NUM}\\s*([\\p{L}.]+)$`, 'u').exec(s);
  if (m) {
    const n = numOf(m[2]);
    const u = unitOf(m[3]?.replace(/\.$/, ''));
    if (Number.isFinite(n) && (u || (!m[3] && s.endsWith(')')))) return { text: m[1].trim(), qty: qtyLabel(n, u || null) };
  }
  m = /^(.+?)\s*[x×]\s*(\d+)$/i.exec(s);
  if (m && !/\d$/.test(m[1])) return { text: m[1].trim(), qty: String(Number(m[2])) };
  return { text: s, qty: null };
}

// ---- Aisles for shopping lists (English, French, Arabic; editable afterwards) ----------------------------------------
// words: single words (matched after folding and plural stripping); phrases: multi-word names, checked first, longest first.
const AISLES = {
  'Fruit & veg': {
    words: 'apple banana orange lemon lime tomato potato onion garlic carrot lettuce salad cucumber spinach broccoli avocado grape '
      + 'strawberry berry pear peach melon watermelon zucchini courgette aubergine eggplant mushroom parsley coriander cilantro mint herb '
      + 'date fig cabbage cauliflower celery leek pumpkin kiwi mango pineapple cherry plum apricot fruit vegetable veg pomme banane citron '
      + 'tomate oignon ail carotte laitue concombre poivron epinard brocoli avocat raisin fraise poire peche pasteque champignon persil '
      + 'menthe datte figue chou poireau potiron clementine mandarine legume تفاح موز برتقال ليمون طماطم بطاطا بطاطس بصل ثوم جزر خس خيار '
      + 'فلفل سبانخ بروكلي افوكادو عنب فراوله اجاص خوخ بطيخ دلاع كوسه فطر بقدونس معدنوس نعناع تمر كرنب قرنبيط كرفس مشمش',
    phrases: ['bell pepper', 'pomme de terre', 'pommes de terre'],
  },
  'Dairy & eggs': {
    words: 'milk egg cheese butter yogurt yoghurt cream feta mozzarella parmesan cheddar lait oeuf fromage beurre yaourt creme '
      + 'حليب بيض جبن جبنه زبده زبادي ياغورت لبن قشطه رايب',
    phrases: [],
  },
  Bakery: { words: 'bread baguette croissant bun pita tortilla wrap bagel pain brioche خبز خبزه كرواسون باقات', phrases: [] },
  'Meat & fish': {
    words: 'chicken beef lamb mince steak sausage ham bacon turkey fish salmon shrimp prawn poulet boeuf agneau viande saucisse jambon '
      + 'dinde poisson saumon crevette merguez escalope دجاج لحم لحمه كفته سجق مرقاز سمك سلمون قمبري جمبري',
    phrases: ['ديك رومي'],
  },
  Pantry: {
    words: 'rice pasta spaghetti noodle flour sugar salt oil vinegar tuna bean lentil chickpea couscous cereal oat honey jam spice cumin '
      + 'paprika harissa sauce ketchup mayonnaise mayo mustard nut almond yeast semolina riz pates farine sucre sel huile vinaigre thon '
      + 'haricot lentille confiture epice moutarde semoule levure ارز رز مقرونه معكرونه دقيق فارينه سكر ملح زيت خل تن تونه فاصوليا عدس '
      + 'حمص كسكسي كسكس شوفان عسل مربي بهارات كمون هريسه سميد خميره',
    phrases: ['olive oil', 'tomato paste', 'peanut butter', 'coconut milk', 'pois chiche', 'pois chiches', 'concentre de tomate',
      "huile d'olive", 'زيت زيتون', 'معجون طماطم', 'طماطم مصبره'],
  },
  Frozen: { words: 'frozen surgele surgeles glace مجمد مجمده مثلجات', phrases: ['ice cream', 'آيس كريم'] },
  Drinks: {
    words: 'water juice soda cola lemonade coffee tea beer wine eau jus cafe the biere vin ماء مياه عصير مشروبات قهوه شاي',
    phrases: ['sparkling water', 'eau gazeuse'],
  },
  'Snacks & sweets': { words: 'chocolate biscuit cookie crisp chip sweet candy popcorn chocolat gateau bonbon شوكولاته بسكويت حلويات شيبس', phrases: [] },
  Household: {
    words: 'detergent sponge bleach battery foil lessive eponge javel pile ampoule منظف اسفنج جافيل بطاريات',
    phrases: ['toilet paper', 'paper towel', 'washing powder', 'washing up liquid', 'washing-up liquid', 'dish soap', 'bin bag', 'bin bags',
      'trash bag', 'trash bags', 'light bulb', 'cling film', 'papier toilette', 'essuie-tout', 'liquide vaisselle', 'sac poubelle',
      'sacs poubelle', 'ورق صحي', 'اكياس القمامه', 'صابون غسيل'],
  },
  'Personal care': {
    words: 'shampoo soap toothpaste toothbrush deodorant razor conditioner shampooing savon dentifrice rasoir شامبو صابون',
    phrases: ['brosse a dents', 'معجون اسنان', 'فرشاه اسنان', 'مزيل العرق'],
  },
  Baby: { words: 'nappy nappies diaper wipes formula couche lingette حفاضات حفاظات', phrases: ['baby food', 'baby wipes', 'حليب اطفال', 'مناديل مبلله'] },
  Pets: { words: 'litter croquette litiere', phrases: ['dog food', 'cat food', 'pet food', 'طعام القطط', 'اكل القطط', 'اكل الكلاب'] },
};
const AISLE_WORDS = new Map();
const AISLE_PHRASES = [];
for (const [aisle, { words, phrases }] of Object.entries(AISLES)) {
  for (const w of fold(words).split(' ')) if (w) AISLE_WORDS.set(stem(w), aisle);
  for (const p of phrases) AISLE_PHRASES.push([fold(p), aisle]);
}
AISLE_PHRASES.sort((a, b) => b[0].length - a[0].length);
export const AISLE_NAMES = Object.keys(AISLES);

/** The supermarket aisle an item probably sits in, or null. English puts the head noun last ("orange juice"); French and
 *  Arabic put it first ("jus d'orange", "عصير برتقال"). "Frozen …" is always Frozen. */
export function inferCategory(text) {
  const f = ` ${fold(text).replace(/[^\p{L}\p{N}' -]+/gu, ' ').replace(/\s+/g, ' ')} `;
  if (/ (frozen|surgele|surgeles|مجمد|مجمده) /.test(f)) return 'Frozen';
  for (const [p, aisle] of AISLE_PHRASES) if (f.includes(` ${p} `)) return aisle;
  const words = tokensOf(text).map(stem);
  const headFirst = /\p{Script=Arabic}/u.test(text) || /\b(de|d|du|des|a|au|aux)\b/.test(fold(text).replace(/'/g, ' '));
  const order = headFirst ? words : [...words].reverse();
  for (const w of order) if (AISLE_WORDS.has(w)) return AISLE_WORDS.get(w);
  return null;
}

// ---- Scopes and access ------------------------------------------------------------------------------------------------
const scopeRow = id => get('SELECT * FROM scopes WHERE id = ?', id);
/** People who see a list: the person for a private list, every member of the group for a group list. */
export function membersOf(list) {
  const sc = scopeRow(list.scope_id);
  if (!sc) return [];
  if (sc.kind === 'user') return [sc.ref_id];
  if (sc.kind === 'group') return all('SELECT user_id FROM group_members WHERE group_id = ?', sc.ref_id).map(r => r.user_id);
  return [];
}
const readableIds = user => readableScopes(user).map(s => s.id);
const canManage = (user, list) => list.owner_id === user.id || user.role === 'admin';
const wisherOf = list => (list.kind === 'wish' ? list.wisher_id ?? list.owner_id : null);

export const getList = id => get('SELECT * FROM lists WHERE id = ?', Number(id)) || null;

/** A list this person may see (and, with manage, rename or archive). Anyone else's private list is "not found". */
export function listForUser(user, id, { manage = false, includeArchived = false } = {}) {
  const l = getList(id);
  if (!l || (l.archived_at && !includeArchived) || !readableIds(user).includes(l.scope_id)) throw notFound('That list isn’t there.');
  if (manage && !canManage(user, l)) throw forbidden('Only the person who made this list (or the admin) can change or archive it.');
  return l;
}

/** Every list this person can see, newest activity first. */
export function listsOf(user, { kind = null } = {}) {
  const ids = readableIds(user);
  return all(`SELECT * FROM lists WHERE archived_at IS NULL AND scope_id IN (${ids.map(() => '?').join(',')})${kind ? ' AND kind = ?' : ''}
    ORDER BY updated_at DESC, id DESC`, ...ids, ...(kind ? [kind] : []));
}

function memberByName(list, name, user) {
  const n = fold(name).replace(/^@/, '');
  if (!n) return null;
  if (['me', 'myself', 'moi', 'انا'].includes(n)) return user.id;
  const ids = membersOf(list);
  if (!ids.length) return null;
  const people = all(`SELECT id, name, call_me FROM users WHERE status = 'active' AND id IN (${ids.map(() => '?').join(',')})`, ...ids);
  const hit = people.filter(p => [p.name, p.name.split(/\s+/)[0], p.call_me].filter(Boolean).some(x => fold(x) === n));
  if (hit.length === 1) return hit[0].id;
  throw invalid({ assignee: hit.length ? `More than one person here is called “${name}” — use their full name.`
    : `Nobody who shares this list is called “${name}”.` });
}

function assertMember(list, userId, field = 'assignee') {
  if (userId == null) return null;
  if (!membersOf(list).includes(Number(userId))) throw invalid({ [field]: 'That person doesn’t share this list.' });
  return Number(userId);
}

function cleanDue(v) {
  if (v == null || v === '') return null;
  const t = Date.parse(String(v).length === 10 ? `${v}T09:00:00` : String(v));
  if (!Number.isFinite(t)) throw invalid({ due: `“${v}” isn’t a date I can read — use YYYY-MM-DD or an ISO date and time.` });
  return new Date(t).toISOString();
}

// ---- Live updates -----------------------------------------------------------------------------------------------------
function touch(list) { run(`UPDATE lists SET updated_at = datetime('now') WHERE id = ?`, list.id); }
/** list.updated → every member (except `skip`, e.g. the wisher for a hidden "bought"). Only the id travels. */
export function announce(list, { skip = [] } = {}) {
  for (const uid of membersOf(list)) if (!skip.includes(uid)) publish(uid, 'list.updated', { listId: list.id });
}

// ---- Lists ------------------------------------------------------------------------------------------------------------
/** A new list, or the one already called that in the same place (never two "Shopping" lists for the family). */
export function createList(user, { title, kind = 'todo', scope = 'private', wisherId = null, wisher = null } = {}) {
  const k = KINDS.includes(kind) ? kind : 'custom';
  const t = clean(title, TITLE_MAX) || DEFAULT_TITLES[k];
  const sc = writableScope(user, scope);
  const same = get('SELECT * FROM lists WHERE scope_id = ? AND lower(title) = lower(?) AND archived_at IS NULL', sc.id, t);
  if (same) return { list: same, existed: true };
  const { lastInsertRowid } = run('INSERT INTO lists (owner_id, scope_id, kind, title, wisher_id) VALUES (?, ?, ?, ?, ?)',
    user.id, sc.id, k, t, k === 'wish' ? user.id : null);
  let list = getList(Number(lastInsertRowid));
  if (k === 'wish' && (wisherId != null || wisher)) {
    const w = wisherId != null ? assertMember(list, wisherId, 'wisher') : memberByName(list, wisher, user);
    run('UPDATE lists SET wisher_id = ? WHERE id = ?', w, list.id);
    list = getList(list.id);
  }
  announce(list);
  return { list, existed: false };
}

export function updateList(user, id, { title, kind } = {}) {
  const l = listForUser(user, id, { manage: true });
  const t = title === undefined ? l.title : clean(title, TITLE_MAX);
  if (!t) throw invalid({ title: 'Give the list a name.' });
  const k = kind === undefined ? l.kind : kind;
  if (!KINDS.includes(k)) throw invalid({ kind: `Kind is one of ${KINDS.join(', ')}.` });
  if (get('SELECT 1 FROM lists WHERE scope_id = ? AND lower(title) = lower(?) AND archived_at IS NULL AND id != ?', l.scope_id, t, l.id)) {
    throw invalid({ title: 'There is already a list with that name here.' });
  }
  run(`UPDATE lists SET title = ?, kind = ?, wisher_id = CASE WHEN ? = 'wish' THEN COALESCE(wisher_id, owner_id) ELSE NULL END,
       updated_at = datetime('now') WHERE id = ?`, t, k, k, l.id);
  announce(l);
  return getList(l.id);
}

export function archiveList(user, id) {
  const l = listForUser(user, id, { manage: true });
  run(`UPDATE lists SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`, l.id);
  announce(l);
  return getList(l.id);
}

export function restoreList(user, id) {
  const l = listForUser(user, id, { manage: true, includeArchived: true });
  if (get('SELECT 1 FROM lists WHERE scope_id = ? AND lower(title) = lower(?) AND archived_at IS NULL AND id != ?', l.scope_id, l.title, l.id)) {
    throw invalid({ title: 'Another list with that name exists now — rename one first.' });
  }
  run(`UPDATE lists SET archived_at = NULL, updated_at = datetime('now') WHERE id = ?`, l.id);
  announce(l);
  return getList(l.id);
}

// ---- Items ------------------------------------------------------------------------------------------------------------
const itemsOf = listId => all('SELECT * FROM list_items WHERE list_id = ? ORDER BY (done_at IS NOT NULL), pos, id', listId);
// What this viewer sees: a wisher never sees that someone bought one of their wishes.
const seenDone = (item, viewer, list) => !!item.done_at && !(item.hidden_from_owner && viewer.id === wisherOf(list));

const nameCache = () => { const m = new Map(); return id => { if (id == null) return null; if (!m.has(id)) m.set(id, get('SELECT name, call_me FROM users WHERE id = ?', id)); const u = m.get(id); return u ? (u.call_me || u.name.split(/\s+/)[0]) : null; }; };

/** Contract for the API and a future Lists page: { id, text, qty, category, assigneeId, assignee, dueAt, done, doneAt, doneBy,
 *  doneById, bought, createdBy, pos }. bought: a wish someone else ticked (never set for the wisher). */
export function itemView(item, viewer, list, nameOf = nameCache()) {
  const done = seenDone(item, viewer, list);
  return {
    id: item.id, text: item.text, qty: item.qty, category: item.category, assigneeId: item.assignee_id, assignee: nameOf(item.assignee_id),
    dueAt: item.due_at, done, doneAt: done ? item.done_at : null, doneById: done ? item.done_by : null, doneBy: done ? nameOf(item.done_by) : null,
    bought: done && !!item.hidden_from_owner, createdBy: nameOf(item.created_by), pos: item.pos,
  };
}

/** Contract: { id, title, kind, scope: 'private' | group name, shared, ownerId, owner, wisherId, wisher, canManage, open, done,
 *  archived, updatedAt }. Counts are as this viewer sees them. */
export function listView(list, viewer, nameOf = nameCache()) {
  const sc = scopeRow(list.scope_id);
  const items = itemsOf(list.id);
  const done = items.filter(i => seenDone(i, viewer, list)).length;
  return {
    id: list.id, title: list.title, kind: list.kind, scope: sc?.kind === 'group' ? sc.name : 'private', shared: sc?.kind === 'group',
    ownerId: list.owner_id, owner: nameOf(list.owner_id), wisherId: wisherOf(list), wisher: nameOf(wisherOf(list)), canManage: canManage(viewer, list),
    open: items.length - done, done, archived: !!list.archived_at, updatedAt: list.updated_at,
  };
}

/** People who share a list, for the assignee and wisher pickers: [{ id, name }] (the name they go by), by name. */
export function memberViews(list) {
  const ids = membersOf(list);
  if (!ids.length) return [];
  return all(`SELECT id, name, call_me FROM users WHERE status = 'active' AND id IN (${ids.map(() => '?').join(',')})`, ...ids)
    .map(u => ({ id: u.id, name: u.call_me || u.name.split(/\s+/)[0] })).sort((a, b) => a.name.localeCompare(b.name));
}

/** One list with its items (open first, in order; then done) and the people who share it. */
export function showList(user, id) {
  const list = listForUser(user, id);
  const nameOf = nameCache();
  const items = itemsOf(list.id).map(i => itemView(i, user, list, nameOf));
  items.sort((a, b) => Number(a.done) - Number(b.done) || a.pos - b.pos || a.id - b.id);
  return { list: listView(list, user, nameOf), items, members: memberViews(list) };
}

/** Archived lists this person can see, most recently archived first (the Lists page offers Restore on them). */
export function archivedListsOf(user) {
  const ids = readableIds(user);
  return all(`SELECT * FROM lists WHERE archived_at IS NOT NULL AND scope_id IN (${ids.map(() => '?').join(',')})
    ORDER BY archived_at DESC, id DESC LIMIT 50`, ...ids);
}

// ---- The Lists page (/lists, /lists/:id) --------------------------------------------------------------------------------
const PREVIEW_ITEMS = 4;
/** Words and icons per kind for the screens (the icon scanner reads the iconName literals). */
export const KIND_META = {
  shopping: { label: 'Shopping list', iconName: 'shopping-cart', openWord: 'to get', doneWord: 'in the basket', add: 'Add an item, like “Milk 1L” or “2 kg rice”', examples: ['Milk 1L', '2 kg rice', 'Eggs x12'] },
  todo: { label: 'To-do list', iconName: 'list-todo', openWord: 'to do', doneWord: 'done', add: 'Add a to-do', examples: ['Call the dentist', 'Renew the car insurance', 'Book swimming lessons'] },
  wish: { label: 'Wish list', iconName: 'gift', openWord: 'wishes', doneWord: 'bought', add: 'Add a wish', examples: ['Roller skates, size 32', 'A watercolour set', 'Headphones'] },
  packing: { label: 'Packing list', iconName: 'luggage', openWord: 'to pack', doneWord: 'packed', add: 'Add something to pack', examples: ['Passports', 'Phone chargers', 'Sun cream'] },
  custom: { label: 'List', iconName: 'list', openWord: 'open', doneWord: 'done', add: 'Add an item', examples: [] },
};
const kindMeta = kind => KIND_META[kind] || KIND_META.custom;

/** Where a new list can live: just them, or one of their groups (with its people, for a wish list's "whose wishes"). */
export function listPlaces(user) {
  return [{ value: 'private', label: 'Just me', members: [{ id: user.id, name: user.callMe || user.name.split(/\s+/)[0] }] },
    ...groupsOfUser(user.id).map(g => ({ value: g.name, label: g.name, members: memberViews({ scope_id: groupScope(g).id }) }))];
}

/** A list card for the index: listView + { kindLabel, iconName, preview: first open items, more }. */
export function cardOf(view, openItems) {
  const m = kindMeta(view.kind);
  return { ...view, kindLabel: m.label, iconName: m.iconName, openWord: m.openWord, total: view.open + view.done,
    pct: view.open + view.done ? Math.round((view.done / (view.open + view.done)) * 100) : 0,
    preview: openItems.slice(0, PREVIEW_ITEMS).map(i => ({ text: i.text, qty: i.qty })), more: Math.max(0, openItems.length - PREVIEW_ITEMS) };
}

/** The index: every list (with its first open items as a preview), the archived ones, and where a new one can go. */
export function listsPage(user) {
  const nameOf = nameCache();
  const lists = listsOf(user).map(l => cardOf(listView(l, user, nameOf), itemsOf(l.id).filter(i => !seenDone(i, user, l))));
  return { lists, archived: archivedListsOf(user).map(l => cardOf(listView(l, user, nameOf), [])), places: listPlaces(user),
    kinds: KINDS.map(k => ({ value: k, ...KIND_META[k] })) };
}

/**
 * One list as the page shows it (pure: the styleguide's simulated API builds the same shape). Open items in groups (a
 * shopping list by aisle, in store order, "Other" last; any other list as one group), then the done ones; each item gains
 * dueLabel / overdue in the viewer's time zone. → the showList shape plus { groups: [{ name, items }], doneItems, aisles,
 * isWisher, meta (kind words), summary: { open, done, total, pct } }.
 */
export function detailOf({ list, items, members }, { viewerId, tz, now = new Date() }) {
  const dated = items.map(i => (i.dueAt ? { ...i, dueLabel: localLabel(i.dueAt, tz, now), overdue: !i.done && i.dueAt < now.toISOString() } : i));
  const open = dated.filter(i => !i.done);
  let groups;
  if (list.kind === 'shopping') {
    const by = new Map();
    for (const i of open) { const k = i.category || 'Other'; if (!by.has(k)) by.set(k, []); by.get(k).push(i); }
    const rank = k => { const r = AISLE_NAMES.indexOf(k); return r === -1 ? (k === 'Other' ? 1e9 : 1e6) : r; };
    groups = [...by.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0])).map(([name, its]) => ({ name, items: its }));
  } else groups = open.length ? [{ name: null, items: open }] : [];
  const done = dated.length - open.length;
  const isWisher = list.wisherId === viewerId;
  // A wisher's own ticks are just "done" (they never see "bought").
  const meta = list.kind === 'wish' && isWisher ? { ...kindMeta(list.kind), doneWord: 'done' } : kindMeta(list.kind);
  return { list: { ...list, kindLabel: meta.label, iconName: meta.iconName }, items: dated, members, groups,
    doneItems: dated.filter(i => i.done), aisles: AISLE_NAMES, isWisher, meta, doneTitle: meta.doneWord[0].toUpperCase() + meta.doneWord.slice(1),
    summary: { open: open.length, done, total: dated.length, pct: dated.length ? Math.round((done / dated.length) * 100) : 0 } };
}

/** listDetail for this person: showList, shaped by detailOf in their time zone. */
export const listDetail = (user, id, now = new Date()) => detailOf(showList(user, id), { viewerId: user.id, tz: tzOf(user), now });

/**
 * Add items one row each. input: strings or { text, qty?, category?, assigneeId?, assignee? (name), due? }. An item already
 * open on the list isn't added twice (a new quantity replaces the old one); a ticked one comes back as open.
 * → { added: [view], updated: [view], already: [view], list }
 */
export function addItems(user, id, input, { sourceMsgId = null } = {}) {
  const list = listForUser(user, id);
  const rows = (Array.isArray(input) ? input : [input]).filter(x => x != null && x !== '');
  if (!rows.length) throw invalid({ items: 'Nothing to add.' });
  if (rows.length > BATCH_MAX) throw invalid({ items: `Add at most ${BATCH_MAX} items at a time.` });
  const parse = ['shopping', 'packing', 'custom'].includes(list.kind);
  const out = { added: [], updated: [], already: [] };
  tx(() => {
    for (const r of rows) {
      const o = typeof r === 'string' ? { text: r } : r;
      const raw = clean(o.text, TEXT_MAX);
      if (!raw) continue;
      const qty = normalizeQty(clean(o.qty, 30)) || null; // "" from a model or a form means "no quantity given"
      const parsed = !qty && parse ? parseItem(raw) : { text: raw, qty };
      if (!parsed.text) continue;
      const assignee = o.assigneeId != null ? assertMember(list, o.assigneeId) : o.assignee ? memberByName(list, o.assignee, user) : null;
      const due = cleanDue(o.due ?? o.dueAt);
      const category = o.category ? clean(o.category, 40) : list.kind === 'shopping' ? inferCategory(parsed.text) : null;
      const same = all('SELECT * FROM list_items WHERE list_id = ?', list.id).filter(i => itemKey(i.text) === itemKey(parsed.text));
      const open = same.find(i => !i.done_at);
      if (open) {
        if ((parsed.qty && parsed.qty !== open.qty) || (assignee && assignee !== open.assignee_id) || (due && due !== open.due_at)) {
          run(`UPDATE list_items SET qty = COALESCE(?, qty), assignee_id = COALESCE(?, assignee_id), due_at = COALESCE(?, due_at), updated_at = datetime('now') WHERE id = ?`,
            parsed.qty, assignee, due, open.id);
          out.updated.push(open.id);
        } else out.already.push(open.id);
        continue;
      }
      const ticked = same.find(i => i.done_at);
      // A wish someone already bought stays bought (and the wisher still just sees it on the list).
      if (ticked?.hidden_from_owner) { out.already.push(ticked.id); continue; }
      if (ticked) {
        // A ticked item asked for again comes back to the list (milk, every week) instead of a second row.
        run(`UPDATE list_items SET done_at = NULL, done_by = NULL, hidden_from_owner = 0, qty = COALESCE(?, qty), assignee_id = ?, due_at = ?,
             created_by = ?, source_msg_id = COALESCE(?, source_msg_id), pos = (SELECT COALESCE(MAX(pos), 0) + 1 FROM list_items WHERE list_id = ?),
             updated_at = datetime('now') WHERE id = ?`, parsed.qty, assignee, due, user.id, sourceMsgId, list.id, ticked.id);
        out.added.push(ticked.id);
        continue;
      }
      const openCount = get('SELECT COUNT(*) AS n FROM list_items WHERE list_id = ? AND done_at IS NULL', list.id).n;
      if (openCount >= OPEN_MAX) throw invalid({ items: `“${list.title}” already has ${OPEN_MAX} open items — tick or remove some first.` });
      const { lastInsertRowid } = run(`INSERT INTO list_items (list_id, text, qty, category, assignee_id, due_at, created_by, source_msg_id, pos)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(pos), 0) + 1 FROM list_items WHERE list_id = ?))`,
      list.id, parsed.text, parsed.qty, category, assignee, due, user.id, sourceMsgId, list.id);
      out.added.push(Number(lastInsertRowid));
    }
  });
  const nameOf = nameCache();
  const view = iid => itemView(get('SELECT * FROM list_items WHERE id = ?', iid), user, list, nameOf);
  const res = { added: out.added.map(view), updated: out.updated.map(view), already: out.already.map(view), list: listView(list, user, nameOf) };
  if (out.added.length || out.updated.length) { touch(list); announce(list); }
  return res;
}

/** Items a reference points at: "#12" / 12 (the id), the exact item, or every item whose words contain the reference's. */
export function matchItems(user, list, ref, { done = null } = {}) {
  const pool = itemsOf(list.id).filter(i => done == null || seenDone(i, user, list) === done);
  const idRef = /^#?(\d+)$/.exec(String(ref ?? '').trim());
  if (idRef) return pool.filter(i => i.id === Number(idRef[1]));
  const key = itemKey(ref);
  if (!key) return [];
  const exact = pool.filter(i => itemKey(i.text) === key);
  if (exact.length) return exact;
  const want = key.split(' ');
  return pool.filter(i => { const have = ` ${itemKey(i.text)} `; return want.every(w => have.includes(` ${w} `) || have.includes(` ${w}`)); });
}

// Result of a batch of references: which changed, which matched nothing, which matched several (ask which one).
const refResult = () => ({ changed: [], missing: [], ambiguous: [] });

/**
 * The one item a tick / untick means. The exact item (or #id) wins in any state — "tick milk" when Milk is already ticked
 * says so instead of asking about almond milk. Otherwise the items whose words contain the reference: one that still
 * needs the change is it; several are a question. → { item, already? } | { ambiguous: [items] } | { missing: true }
 */
function findTarget(user, list, ref, done) {
  const items = itemsOf(list.id);
  const needs = i => seenDone(i, user, list) !== done;
  const idRef = /^#?(\d+)$/.exec(String(ref ?? '').trim());
  const exact = idRef ? items.filter(i => i.id === Number(idRef[1])) : items.filter(i => itemKey(i.text) === itemKey(ref) && itemKey(ref));
  if (exact.length) {
    const todo = exact.filter(needs);
    return todo.length ? { item: todo[0] } : { item: exact[0], already: true };
  }
  if (idRef) return { missing: true };
  const partial = matchItems(user, list, ref);
  const todo = partial.filter(needs);
  if (todo.length === 1) return { item: todo[0] };
  if (todo.length > 1) return { ambiguous: todo };
  if (partial.length === 1) return { item: partial[0], already: true };
  return partial.length ? { ambiguous: partial } : { missing: true };
}

/** Tick (done = true) or untick items. A wish ticked by someone other than the wisher is "bought", hidden from them. */
export function checkItems(user, id, refs, { done = true } = {}) {
  const list = listForUser(user, id);
  const out = refResult();
  const hide = list.kind === 'wish' && user.id !== wisherOf(list) ? 1 : 0;
  const nameOf = nameCache();
  const changedIds = [];
  for (const ref of (Array.isArray(refs) ? refs : [refs]).slice(0, BATCH_MAX)) {
    const hit = findTarget(user, list, ref, done);
    if (hit.missing) { out.missing.push(String(ref)); continue; }
    if (hit.ambiguous) { out.ambiguous.push({ ref: String(ref), candidates: hit.ambiguous.slice(0, 8).map(i => itemView(i, user, list, nameOf)) }); continue; }
    if (hit.already) { out.changed.push({ ...itemView(hit.item, user, list, nameOf), unchanged: true }); continue; }
    const it = hit.item;
    // The WHERE clause is the lock: a row someone else just ticked isn't ticked again (their name stays on it).
    const res = done
      ? run(`UPDATE list_items SET done_at = ?, done_by = ?, hidden_from_owner = ?, updated_at = datetime('now')
             WHERE id = ? AND (done_at IS NULL OR (hidden_from_owner = 1 AND ? = 0 AND ? = ?))`,
      new Date().toISOString(), user.id, hide, it.id, hide, user.id, wisherOf(list) ?? -1)
      : run(`UPDATE list_items SET done_at = NULL, done_by = NULL, hidden_from_owner = 0, updated_at = datetime('now')
             WHERE id = ? AND done_at IS NOT NULL`, it.id);
    const fresh = get('SELECT * FROM list_items WHERE id = ?', it.id);
    out.changed.push({ ...itemView(fresh, user, list, nameOf), unchanged: !res.changes });
    if (res.changes) changedIds.push(it.id);
  }
  if (changedIds.length) { touch(list); announce(list, { skip: hide ? [wisherOf(list)] : [] }); }
  return { ...out, list: listView(list, user, nameOf) };
}

/** Remove items (by reference) — or, with clearDone, every item this person sees as done. */
export function removeItems(user, id, refs = [], { clearDone = false } = {}) {
  const list = listForUser(user, id);
  const out = refResult();
  const nameOf = nameCache();
  const gone = [];
  if (clearDone) for (const i of itemsOf(list.id)) if (seenDone(i, user, list)) gone.push(i);
  for (const ref of (Array.isArray(refs) ? refs : [refs]).filter(r => r != null && r !== '').slice(0, BATCH_MAX)) {
    const hits = matchItems(user, list, ref);
    if (!hits.length) out.missing.push(String(ref));
    else if (hits.length > 1) out.ambiguous.push({ ref: String(ref), candidates: hits.slice(0, 8).map(i => itemView(i, user, list, nameOf)) });
    else gone.push(hits[0]);
  }
  const unique = [...new Map(gone.map(i => [i.id, i])).values()];
  tx(() => { for (const i of unique) run('DELETE FROM list_items WHERE id = ?', i.id); });
  out.changed = unique.map(i => itemView(i, user, list, nameOf));
  if (unique.length) { touch(list); announce(list); }
  return { ...out, list: listView(list, user, nameOf) };
}

/** One item's fields (API): text, qty, category, assigneeId, due, done, pos. */
export function updateItem(user, listId, itemId, patch = {}) {
  const list = listForUser(user, listId);
  const it = get('SELECT * FROM list_items WHERE id = ? AND list_id = ?', Number(itemId), list.id);
  if (!it) throw notFound('That item isn’t on this list.');
  const text = patch.text === undefined ? it.text : clean(patch.text, TEXT_MAX);
  if (!text) throw invalid({ text: 'An item needs some words.' });
  const qty = patch.qty === undefined ? it.qty : (clean(patch.qty, 30) || null);
  const category = patch.category === undefined ? it.category : (clean(patch.category, 40) || null);
  const assignee = patch.assigneeId === undefined ? it.assignee_id : assertMember(list, patch.assigneeId);
  const due = patch.due === undefined && patch.dueAt === undefined ? it.due_at : cleanDue(patch.due ?? patch.dueAt);
  const pos = patch.pos === undefined ? it.pos : Math.max(0, Math.round(Number(patch.pos) || 0));
  run(`UPDATE list_items SET text = ?, qty = ?, category = ?, assignee_id = ?, due_at = ?, pos = ?, updated_at = datetime('now') WHERE id = ?`,
    text, qty, category, assignee, due, pos, it.id);
  if (patch.done !== undefined) {
    const r = checkItems(user, list.id, [`#${it.id}`], { done: !!patch.done });
    if (r.changed[0]) return r.changed[0];
  }
  touch(list); announce(list);
  return itemView(get('SELECT * FROM list_items WHERE id = ?', it.id), user, list);
}

export function deleteItem(user, listId, itemId) {
  const list = listForUser(user, listId);
  const it = get('SELECT * FROM list_items WHERE id = ? AND list_id = ?', Number(itemId), list.id);
  if (!it) throw notFound('That item isn’t on this list.');
  run('DELETE FROM list_items WHERE id = ?', it.id);
  touch(list); announce(list);
  return { ok: true };
}

// ---- Choosing a list from what someone said ---------------------------------------------------------------------------
/**
 * The list a tool call means: `ref` (an id or a name), else the one list of `kind` they can see. Never guesses between
 * several. With none of that kind and no groups, a private one is made (nobody else it could be for).
 * → { list, created } or throws with the choices (invalid, field "list").
 */
export function resolveList(user, { ref = null, kind = null } = {}) {
  const lists = listsOf(user);
  const names = ls => ls.map(l => `“${l.title}”${l.kind !== 'custom' ? ` (${l.kind})` : ''}${scopeLabel(l)}`).join(', ');
  if (ref != null && String(ref).trim()) {
    const r = String(ref).trim();
    const byId = /^#?(\d+)$/.exec(r);
    if (byId) { const l = lists.find(x => x.id === Number(byId[1])); if (l) return { list: l, created: false }; }
    const f = fold(r).replace(/\b(list|liste)\b/g, '').replace(/^(the|my|our|la|ma|notre|le|mon)\s+/, '').trim();
    const exact = lists.filter(l => fold(l.title) === fold(r) || fold(l.title) === f);
    if (exact.length === 1) return { list: exact[0], created: false };
    const near = exact.length ? exact : lists.filter(l => f && (fold(l.title).includes(f) || f.includes(fold(l.title)) || l.kind === f));
    if (near.length === 1) return { list: near[0], created: false };
    throw invalid({ list: near.length ? `Several lists match “${r}”: ${names(near)}. Ask which one.`
      : `There’s no list called “${r}”.${lists.length ? ` Lists they have: ${names(lists)}.` : ' They have no lists yet.'} Create it with list_create if they want one.` });
  }
  const k = KINDS.includes(kind) ? kind : 'shopping';
  const same = lists.filter(l => l.kind === k);
  if (same.length === 1) return { list: same[0], created: false };
  if (same.length > 1) throw invalid({ list: `They have several ${k} lists: ${names(same)}. Ask which one (or name it).` });
  const groups = groupsOfUser(user.id);
  if (!groups.length) return { list: createList(user, { title: DEFAULT_TITLES[k], kind: k }).list, created: true };
  throw invalid({ list: `No ${k} list yet. Ask whether it’s just for them or shared with ${groups.map(g => g.name).join(' / ')}, then create it with list_create.` });
}

const scopeLabel = l => { const sc = scopeRow(l.scope_id); return sc?.kind === 'group' ? ` · shared with ${sc.name}` : ' · private'; };

// ---- "Coming up" (the prompt's next-24h block) ------------------------------------------------------------------------
/**
 * Open list items due within `within` ms (and anything overdue) for this person: on lists they can see, unassigned or
 * assigned to them. → [{ t: dueAt ISO, line: '- To-do item [#12] “Call the dentist” on “To-do” (shared with Family) — due Today, 17:00' }],
 * soonest first — the same { t, line } shape upcomingBlock() sorts its alarms and schedules by, so it can be merged in.
 */
export function dueListItems(user, within = 864e5, now = new Date()) {
  const ids = readableIds(user);
  const horizon = new Date(now.getTime() + within).toISOString();
  const rows = all(`SELECT i.*, l.title AS list_title, l.kind AS list_kind, l.scope_id FROM list_items i JOIN lists l ON l.id = i.list_id
    WHERE l.archived_at IS NULL AND l.scope_id IN (${ids.map(() => '?').join(',')}) AND i.done_at IS NULL AND i.due_at IS NOT NULL
      AND i.due_at <= ? AND (i.assignee_id IS NULL OR i.assignee_id = ?) ORDER BY i.due_at LIMIT 20`, ...ids, horizon, user.id);
  const tz = tzOf(user);
  return rows.map(r => {
    const overdue = r.due_at < now.toISOString();
    const where = scopeRow(r.scope_id)?.kind === 'group' ? ` (shared with ${scopeRow(r.scope_id).name})` : '';
    return { t: r.due_at, line: `- List item [#${r.id}] “${r.text}”${r.assignee_id === user.id ? ' (theirs)' : ''} on “${r.list_title}”${where} — `
      + `${overdue ? 'overdue since' : 'due'} ${localLabel(r.due_at, tz, now)}` };
  });
}
