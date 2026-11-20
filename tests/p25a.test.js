// Phase 25 part A (decisions #174–#175): the screens for lists, You (name, busy sharing, signed-in sites, memory dates,
// episodes and import), Library cards and viewer, and off the record. These tests cover the data the screens are built
// from and the server-rendered pages / fragments; the interactions are covered by scripts/ui-flows.js (styleguide) and
// scripts/e2e-setup.js (two people, one live list).
// Run: npm test  (node --test, throwaway data dir, no network).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listen } from './helpers/listen.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-p25a-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env');
process.env.JESSBOT_EMBED_OFF = '1';
process.env.JESSBOT_DECIDE_OFF = '1';

const { openDb, closeDb, run, settings } = await import('../src/db/index.js');
const { ensureDirs } = await import('../src/config/index.js');
ensureDirs();
await openDb();

const { createUser, getUser } = await import('../src/services/users.js');
const { createGroup, addMember } = await import('../src/services/groups.js');
const L = await import('../src/services/lists.js');
const { createApp } = await import('../src/app.js');
const { createSession } = await import('../src/services/sessions.js');

let alice, bob, carol, family, base, server;
const tokens = {};
before(async () => {
  alice = await createUser({ name: 'Alice Owner', email: 'alice@p25a.dev', password: 'correct horse battery', role: 'admin', timezone: 'Europe/Paris' });
  bob = await createUser({ name: 'Bob Member', email: 'bob@p25a.dev', password: 'correct horse battery', timezone: 'Europe/Paris' });
  carol = await createUser({ name: 'Carol Other', email: 'carol@p25a.dev', password: 'correct horse battery' });
  family = createGroup({ name: 'Family' });
  for (const u of [alice, bob]) addMember(family.id, u.id);
  settings.set('setup', { done: ['account', 'model', 'browser', 'identity', 'people'], completedAt: new Date().toISOString() });
  for (const [k, u] of Object.entries({ alice, bob, carol })) tokens[k] = createSession(u.id, { kind: 'app', device: 'test' });
  server = await listen(createApp());
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); closeDb(); fs.rmSync(HOME, { recursive: true, force: true }); });

const call = async (who, method, url, body) => {
  const res = await fetch(base + url, { method, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
};
const page = async (who, url) => {
  const res = await fetch(base + url, { headers: { Authorization: `Bearer ${tokens[who]}`, Accept: 'text/html' } });
  return { status: res.status, html: await res.text() };
};

// ---- Lists ------------------------------------------------------------------------------------------------------------
test('lists page data: own and group lists as cards with a preview, archived ones, and where a new list can go', () => {
  const shop = L.createList(alice, { title: 'Weekly shop', kind: 'shopping', scope: 'Family' }).list;
  L.addItems(alice, shop.id, ['Milk 1L', '2 kg rice', 'Bananas', 'Toilet paper', 'Harissa', 'Bread']);
  L.checkItems(bob, shop.id, ['Bread']);
  const mine = L.createList(alice, { title: 'Lyon weekend', kind: 'packing' }).list;
  const old = L.createList(alice, { title: 'Christmas 2025', kind: 'wish', scope: 'Family' }).list;
  L.archiveList(alice, old.id);
  L.createList(carol, { title: 'Carol’s things', kind: 'todo' });

  const p = L.listsPage(getUser(alice.id));
  assert.deepEqual(p.lists.map(l => l.title).sort(), ['Lyon weekend', 'Weekly shop']);
  const card = p.lists.find(l => l.id === shop.id);
  assert.equal(card.kindLabel, 'Shopping list');
  assert.equal(card.iconName, 'shopping-cart');
  assert.equal(card.open, 5);
  assert.equal(card.done, 1);
  assert.equal(card.pct, 17);
  assert.equal(card.preview.length, 4, 'four open items preview the list');
  assert.ok(!card.preview.some(i => i.text === 'Bread'), 'a ticked item is not in the preview');
  assert.equal(card.more, 1);
  assert.deepEqual(card.preview[0], { text: 'Milk', qty: '1 L' });
  assert.deepEqual(p.archived.map(l => l.title), ['Christmas 2025']);
  assert.equal(p.places[0].value, 'private');
  assert.equal(p.places[1].label, 'Family');
  assert.deepEqual(p.places[1].members.map(m => m.name).sort(), ['Alice', 'Bob']);
  assert.ok(p.kinds.every(k => k.label && k.iconName && k.openWord && k.doneWord));
  // Bob sees the family lists, never Alice's private one; Carol sees only hers.
  assert.deepEqual(L.listsPage(getUser(bob.id)).lists.map(l => l.title), ['Weekly shop']);
  assert.deepEqual(L.listsPage(getUser(carol.id)).lists.map(l => l.title), ['Carol’s things']);
  assert.equal(L.listsPage(getUser(carol.id)).places.length, 1, 'no groups: only "Just me"');
  assert.equal(mine.kind, 'packing');
});

test('list detail: a shopping list in store-aisle order with "Other" last, done items apart, people for the pickers', () => {
  const shop = L.listsOf(alice).find(l => l.title === 'Weekly shop');
  L.addItems(alice, shop.id, ['Birthday candles']);
  const d = L.listDetail(getUser(alice.id), shop.id);
  assert.deepEqual(d.groups.map(g => g.name), ['Fruit & veg', 'Dairy & eggs', 'Pantry', 'Household', 'Other']);
  assert.deepEqual(d.groups.find(g => g.name === 'Pantry').items.map(i => i.text).sort(), ['Harissa', 'rice']);
  assert.deepEqual(d.doneItems.map(i => [i.text, i.doneBy]), [['Bread', 'Bob']]);
  assert.deepEqual(d.members.map(m => m.name), ['Alice', 'Bob']);
  assert.deepEqual(d.summary, { open: 6, done: 1, total: 7, pct: 14 });
  assert.equal(d.meta.openWord, 'to get');
  assert.equal(d.doneTitle, 'In the basket');
  assert.deepEqual(L.showList(alice, shop.id).members, d.members, 'the API carries the people too');
});

test('list detail: to-dos get a due label in the viewer’s time zone and an overdue flag; one group', () => {
  const todo = L.createList(alice, { title: 'House to-dos', kind: 'todo', scope: 'Family' }).list;
  const now = new Date('2026-09-26T10:00:00Z');
  L.addItems(alice, todo.id, [{ text: 'Call the dentist', due: '2026-09-27T08:00:00Z', assignee: 'Bob' }, { text: 'Renew insurance', due: '2026-09-25T07:00:00Z' }, 'Fix the tap']);
  const d = L.listDetail(getUser(alice.id), todo.id, now);
  assert.equal(d.groups.length, 1);
  assert.equal(d.groups[0].name, null);
  const dentist = d.items.find(i => i.text === 'Call the dentist');
  assert.equal(dentist.dueLabel, 'Tomorrow, 10:00', 'Paris is UTC+2 in September');
  assert.equal(dentist.overdue, false);
  assert.equal(dentist.assignee, 'Bob');
  assert.equal(d.items.find(i => i.text === 'Renew insurance').overdue, true);
  assert.equal(d.items.find(i => i.text === 'Fix the tap').dueLabel, undefined);
  assert.equal(d.doneTitle, 'Done');
});

test('list detail: on a wish list the wisher never sees "bought"; the others do', () => {
  const wish = L.createList(bob, { title: 'Bob’s birthday', kind: 'wish', scope: 'Family' }).list;
  L.addItems(bob, wish.id, ['Headphones', 'A good book']);
  L.checkItems(alice, wish.id, ['Headphones']);
  const forBob = L.listDetail(getUser(bob.id), wish.id);
  assert.equal(forBob.isWisher, true);
  assert.equal(forBob.doneItems.length, 0, 'the wisher sees the bought wish as still open');
  assert.equal(forBob.meta.doneWord, 'done');
  const forAlice = L.listDetail(getUser(alice.id), wish.id);
  assert.equal(forAlice.isWisher, false);
  assert.deepEqual(forAlice.doneItems.map(i => [i.text, i.bought, i.doneBy]), [['Headphones', true, 'Alice']]);
  assert.equal(forAlice.doneTitle, 'Bought');
});

test('lists API: ?fragment=1 renders the page’s own partials; ?archived=1 lists archived ones; others get 404', async () => {
  const shop = L.listsOf(alice).find(l => l.title === 'Weekly shop');
  const idx = await call('alice', 'GET', '/api/v1/lists?fragment=1');
  assert.equal(idx.status, 200);
  assert.match(idx.body.html, /data-lists-body/);
  assert.match(idx.body.html, new RegExp(`href="/lists/${shop.id}"`));
  assert.match(idx.body.html, /Christmas 2025/, 'the archived section is part of the fragment');
  const plain = await call('alice', 'GET', '/api/v1/lists');
  assert.equal(plain.body.html, undefined, 'no HTML unless asked');
  const arch = await call('alice', 'GET', '/api/v1/lists?archived=1');
  assert.deepEqual(arch.body.lists.map(l => l.title), ['Christmas 2025']);
  const one = await call('bob', 'GET', `/api/v1/lists/${shop.id}?fragment=1`);
  assert.equal(one.status, 200);
  assert.match(one.body.html, /data-list-items/);
  assert.equal((one.body.html.match(/data-item-id="/g) || []).length, one.body.items.length);
  assert.deepEqual(one.body.members.map(m => m.name), ['Alice', 'Bob']);
  assert.equal((await call('carol', 'GET', `/api/v1/lists/${shop.id}?fragment=1`)).status, 404);
});

test('lists pages: /lists and /lists/:id render for the people who share them, escape what was typed, 404 otherwise', async () => {
  const shop = L.listsOf(alice).find(l => l.title === 'Weekly shop');
  L.addItems(bob, shop.id, ['<img src=x onerror=alert(1)>']);
  const idx = await page('bob', '/lists');
  assert.equal(idx.status, 200);
  assert.match(idx.html, /href="\/lists" class="rail-link" aria-current="page"/, 'Lists is the current place in the rail');
  assert.match(idx.html, /Weekly shop/);
  const one = await page('bob', `/lists/${shop.id}`);
  assert.equal(one.status, 200);
  assert.match(one.html, /data-list-page="\d+"/);
  assert.match(one.html, /Shared with Family: Alice, Bob/);
  assert.ok(!one.html.includes('<img src=x onerror'), 'item text is escaped');
  assert.match(one.html, /&lt;img src(=|&#x3D;)x onerror(=|&#x3D;)alert\(1\)&gt;/, 'shown as the words they typed');
  assert.match(one.html, /<template data-list-editor>[\s\S]*name="category"[\s\S]*Fruit &amp; veg/, 'the aisle picker comes from the server');
  assert.equal((await page('carol', `/lists/${shop.id}`)).status, 404);
  assert.equal((await page('bob', '/lists/abc')).status, 404);
  const empty = await page('carol', '/lists');
  assert.match(empty.html, /Carol’s things/);
});

test('lists page: an empty household sees the invitation to start one', async () => {
  const dan = await createUser({ name: 'Dan New', email: 'dan@p25a.dev', password: 'correct horse battery' });
  tokens.dan = createSession(dan.id, { kind: 'app', device: 'test' });
  const res = await page('dan', '/lists');
  assert.match(res.html, /No lists yet/);
  assert.match(res.html, /data-list-start="shopping"/);
  run('DELETE FROM sessions WHERE user_id = ?', dan.id);
});

// ---- You --------------------------------------------------------------------------------------------------------------
test('You → Profile and Connections: how to say my name, busy sharing (off without a group), signed-in sites', async () => {
  const { updateProfile } = await import('../src/services/users.js');
  const { saveProfile, profileFile } = await import('../src/browser/profiles.js');
  updateProfile(alice.id, { nameSay: 'A-leess', shareBusy: true });
  const prof = await page('alice', '/me/profile');
  assert.match(prof.html, /name="nameSay"[^>]*value="A-leess"/);
  const soon = Math.round(Date.now() / 1000) + 90 * 86400;
  saveProfile(profileFile(alice.id), { cookies: [
    { name: 'session-id', value: 'x', domain: '.amazon.fr', path: '/', expires: soon },
    { name: '_ga', value: 'x', domain: '.example.org', path: '/', expires: soon },
  ], origins: [] });
  const conn = await page('alice', '/me/connections');
  assert.match(conn.html, /Share when I’m busy with Family/);
  assert.match(conn.html, /id="share-busy"[^>]*data-share-busy-switch checked/);
  assert.match(conn.html, /data-site="amazon.fr"/);
  assert.match(conn.html, /src="\/favicons\/amazon.fr"/);
  assert.match(conn.html, /Stays signed in until \d{1,2} \w+ \d{4}/);
  assert.ok(!conn.html.includes('data-site="example.org"'), 'an analytics cookie is not a sign-in');
  // Carol has no group: the switch is off and says why; no sites yet.
  const lone = await page('carol', '/me/connections');
  assert.match(lone.html, /data-share-busy-switch\s+disabled/);
  assert.match(lone.html, /You’re not in a group yet/);
  assert.match(lone.html, /data-sites-empty\s*>/);
});

test('You → Memory: dates, importance and use on each row; conversations; the list fragment re-renders it', async () => {
  const memory = await import('../src/services/memory.js');
  const { run: dbRun } = await import('../src/db/index.js');
  const bday = memory.addFact({ user: alice, text: 'Maya’s birthday', date: '03-14', recurs: 'yearly', importance: 3, createdBy: 'user' });
  const plain = memory.addFact({ user: alice, text: 'Likes grilled octopus', importance: 2, createdBy: 'user' });
  dbRun(`UPDATE memories SET use_count = 3, last_used_at = datetime('now', '-2 days') WHERE id = ?`, plain.id);
  dbRun(`INSERT INTO episodes (scope_id, text, ref_date, observed_at) VALUES (?, ?, ?, datetime('now'))`, memory.userScope(alice).id,
    'Planned the Lyon weekend with Maya', '2026-09-22');
  const res = await page('alice', '/me/memory');
  assert.match(res.html, /data-memory-id="\d+"[^>]*data-importance="3"\s+data-dated/);
  assert.match(res.html, /14 Mar, every year/);
  assert.match(res.html, /Essential/);
  assert.match(res.html, /Matters to you/);
  assert.match(res.html, /Used 3 times, most recently/);
  assert.match(res.html, /Not used in a reply yet/);
  assert.match(res.html, /Conversations I remember[\s\S]*Tue 22 Sept?[\s\S]*Planned the Lyon weekend with Maya/);
  assert.match(res.html, /Off the record/);
  const frag = await call('alice', 'GET', '/api/v1/me/memories?fragment=1');
  assert.match(frag.body.html, /data-memory-list/);
  assert.equal((frag.body.html.match(/data-memory-id="/g) || []).length, frag.body.memories.length);
  assert.ok(frag.body.memories.some(m => m.id === bday.id && m.dateLabel === '14 Mar, every year'));
  assert.equal((await call('alice', 'GET', '/api/v1/me/memories')).body.html, undefined, 'no HTML unless asked');
});

test('memory import preview: candidates carry their date in words; the fragment ticks the good ones only', async () => {
  const text = 'I am allergic to penicillin\nMy password is hunter2hunter2\nLikes grilled octopus\nKeiko’s birthday is on 3 June';
  const r = await call('alice', 'POST', '/api/v1/me/memories/import/preview?fragment=1', { text });
  assert.equal(r.status, 200);
  const c = Object.fromEntries(r.body.candidates.map(x => [x.text, x]));
  assert.ok(c['My password is hunter2hunter2'].problem, 'a password is refused');
  assert.ok(c['Likes grilled octopus'].duplicateOf, 'an existing memory is a duplicate');
  const bday = r.body.candidates.find(x => /Keiko/.test(x.text));
  assert.equal(bday.dateLabel, '3 Jun, every year');
  const html = r.body.html;
  assert.equal((html.match(/data-import-pick/g) || []).length, 4);
  assert.match(html, /class="mem-import-row is-problem"[\s\S]*?data-import-pick[^>]*disabled/);
  assert.match(html, /class="mem-import-row is-duplicate"[\s\S]*?data-import-pick(?![^>]*checked)[^>]*>/);
  assert.match(html, /3 Jun, every year/);
  assert.match(html, /I already remember this/);
  const saved = await call('alice', 'POST', '/api/v1/me/memories/import', { items: [{ text: 'I am allergic to penicillin' }, { text: bday.text, date: bday.date, recurs: bday.recurs }] });
  assert.equal(saved.body.saved.length, 2);
});

// ---- Library ----------------------------------------------------------------------------------------------------------
test('library: a PDF that asks the viewer to draw its answers is recognised from the file itself, per version', async () => {
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  const pdfs = await import('../src/services/pdf.js');
  const lib = await import('../src/services/library.js');
  const { viewerDrawsAnswers } = await import('../src/services/pdf-viewer.js');
  const doc = await PDFDocument.create();
  const pg = doc.addPage([400, 300]);
  doc.getForm().createTextField('name').addToPage(pg, { x: 40, y: 200, width: 200, height: 24 });
  const blank = Buffer.from(await doc.save());
  const arabic = await pdfs.fillPdfForm(blank, { name: 'مريم الحسن' });
  const latin = await pdfs.fillPdfForm(blank, { name: 'Zoë' });
  const make = (title, buffer) => lib.createFileItem({ user: alice, title, type: 'pdf', ext: 'pdf', mime: 'application/pdf', buffer, sourceLabel: 'Made by Jess' });
  const a = make('Form (Arabic)', arabic.buffer);
  const b = make('Form (Latin)', latin.buffer);
  assert.equal(await viewerDrawsAnswers(a), true);
  assert.equal(await viewerDrawsAnswers(b), false);
  assert.equal(await viewerDrawsAnswers({ ...a, type: 'doc' }), false, 'only PDFs');
  const page1 = await page('alice', `/library/${a.public_id}`);
  assert.match(page1.html, /class="lib-notice" role="note"/);
  assert.match(page1.html, /Ask for a flattened copy/);
  assert.ok(!(await page('alice', `/library/${b.public_id}`)).html.includes('class="lib-notice"'));
});

test('library: cards and the viewer say where a file came from, what it was made from, and offer Add to calendar', async () => {
  const lib = await import('../src/services/library.js');
  const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x1\r\nDTSTART:20261003T080000Z\r\nDTEND:20261003T084500Z\r\nSUMMARY:Swimming\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const cal = lib.createFileItem({ user: alice, title: 'Swimming lessons', type: 'md', ext: 'ics', mime: 'text/calendar', buffer: Buffer.from(ics), sourceLabel: 'Made by Jess' });
  const got = lib.createFileItem({ user: alice, title: 'Order 402', type: 'pdf', ext: 'pdf', mime: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF'), sourceLabel: 'Downloaded from amazon.fr' });
  const src = lib.createFileItem({ user: alice, title: 'Chess dashboard', type: 'md', ext: 'md', mime: 'text/markdown', buffer: Buffer.from('# Chess'), sourceLabel: 'Made by Jess' });
  const pdf = lib.createFileItem({ user: alice, title: 'Chess dashboard (PDF)', type: 'md', ext: 'md', mime: 'text/markdown', buffer: Buffer.from('# Copy'), sourceLabel: 'Made by Jess', sourceItemId: src.id });
  const grid = await page('alice', '/library');
  assert.match(grid.html, new RegExp(`<article class="library-card[^"]*"[^>]*data-library-id="${cal.public_id}"`), 'a card is an article with a stretched link');
  assert.match(grid.html, new RegExp(`href="/library/${cal.public_id}" class="library-card-link"`));
  assert.match(grid.html, new RegExp(`href="/library/${cal.public_id}/download" class="btn btn-secondary btn-sm library-card-action`), 'Add to calendar on the card');
  assert.match(grid.html, /Downloaded from amazon.fr/);
  assert.match(grid.html, /Made from “Chess dashboard”/);
  const view = await page('alice', `/library/${cal.public_id}`);
  assert.match(view.html, /Add these to your phone or calendar app in one tap/);
  assert.match(view.html, new RegExp(`href="/library/${cal.public_id}/download" class="btn btn-primary btn-sm shrink-0">Add to calendar`));
  const dl = await page('alice', `/library/${got.public_id}`);
  assert.match(dl.html, /data-library-about\s*>/, 'the about strip shows for a downloaded file');
  assert.match(dl.html, /Downloaded from amazon.fr/);
  const made = await page('alice', `/library/${pdf.public_id}`);
  const link = made.html.indexOf(`href="/library/${src.public_id}"`);
  assert.ok(link > 0 && /Made from “Chess dashboard”/.test(made.html.slice(link, link + 400)), 'the viewer links to the page it was made from');
  // Title and description through the API, shown in the viewer's strip.
  const r = await call('alice', 'PATCH', `/api/v1/library/${src.public_id}`, { title: 'Chess dashboard, September', description: 'Where my games go wrong after move 25' });
  assert.equal(r.status, 200);
  const again = await page('alice', `/library/${src.public_id}`);
  assert.match(again.html, /data-library-description\s*>Where my games go wrong after move 25</);
  assert.match(again.html, /<template data-library-details-template>/);
  assert.equal((await page('bob', `/library/${src.public_id}`)).status, 404, 'someone else’s file stays theirs');
});

test('library: an audio item gets the listening card around the voice player', async () => {
  const lib = await import('../src/services/library.js');
  const wav = Buffer.alloc(44 + 48000);
  const item = lib.createFileItem({ user: alice, title: 'The plan, read aloud', type: 'audio', ext: 'wav', mime: 'audio/wav', buffer: wav,
    meta: { durationMs: 61000, peaks: [0.2, 0.5, 0.9, 0.4], voice: 'Aoede' }, sourceLabel: 'Made by Jess' });
  const res = await page('alice', `/library/${item.public_id}`);
  assert.match(res.html, /class="lib-audio" aria-label="Listen"/);
  assert.match(res.html, /voice Aoede, 1:01/);
  assert.match(res.html, /data-voice-player="lib-[^"]+"/);
  const grid = await page('alice', '/library');
  assert.match(grid.html, /library-audio-thumb/);
  assert.match(grid.html, /data-library-filter="audio"/, 'an Audio filter once there is something to listen to');
});

// ---- Off the record ---------------------------------------------------------------------------------------------------
test('off the record: a side chat has the switch (header and menu) and the chip follows the thread; the main chat has neither', async () => {
  const T = await import('../src/services/threads.js');
  const side = T.createSideThread(alice.id);
  let res = await page('alice', `/chat/${side.id}`);
  assert.match(res.html, /class="btn btn-ghost btn-icon offrecord-toggle[^"]*" data-offrecord-toggle aria-label="Off the record" aria-pressed="false"/);
  assert.match(res.html, /role="menuitemcheckbox" aria-checked="false" data-offrecord-toggle/);
  assert.match(res.html, /class="offrecord-chip[^"]*" data-offrecord-chip\s+hidden/);
  const r = await call('alice', 'POST', `/api/v1/threads/${side.id}/off-record`, { on: true });
  assert.equal(r.body.offRecord, true);
  res = await page('alice', `/chat/${side.id}`);
  assert.match(res.html, /aria-pressed="true"/);
  assert.match(res.html, /data-sidechat-badge\s+hidden/, 'the chip takes the badge’s place');
  assert.ok(!/data-offrecord-chip\s+hidden/.test(res.html), 'the chip shows');
  const listed = (await call('alice', 'GET', '/api/v1/threads')).body.threads.find(t => t.id === side.id);
  assert.equal(listed.offRecord, true);
  const main = await page('alice', '/chat');
  assert.ok(!main.html.includes('data-offrecord-toggle'), 'the main chat always remembers');
});
