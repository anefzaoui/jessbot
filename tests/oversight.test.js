// Admin oversight of other people's chats and files (decision #36, revisited in #219): a setting, off for a new install,
// visible to everyone when on; an install from before keeps what it had. Run: npm test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listen } from './helpers/listen.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-oversight-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env');
process.env.JESSBOT_EMBED_OFF = '1';
process.env.JESSBOT_DECIDE_OFF = '1';

const { openDb, closeDb, get, settings } = await import('../src/db/index.js');
const { ensureDirs } = await import('../src/config/index.js');
ensureDirs();
await openDb();
const { createUser } = await import('../src/services/users.js');
const { createSession } = await import('../src/services/sessions.js');
const { mainThread, threadForViewer } = await import('../src/services/threads.js');
const library = await import('../src/services/library.js');
const { projectFromThread, projectForUser } = await import('../src/services/projects.js');
const { createSideThread } = await import('../src/services/threads.js');
const O = await import('../src/services/oversight.js');
const { up } = await import('../src/db/migrations/053_admin_oversight.js');
const { createApp } = await import('../src/app.js');

let admin, member, server, base, cookies;
before(async () => {
  admin = await createUser({ name: 'Alex Admin', email: 'alex@oversight.test', password: 'correct horse battery', role: 'admin' });
  member = await createUser({ name: 'Maya Member', email: 'maya@oversight.test', password: 'correct horse battery' });
  settings.set('setup', { done: ['account', 'model', 'browser', 'identity', 'people'], completedAt: new Date().toISOString() });
  server = await listen(createApp());
  base = `http://127.0.0.1:${server.address().port}`;
  cookies = { admin: `jb_session=${createSession(admin.id)}`, member: `jb_session=${createSession(member.id)}` };
});
after(() => { server?.close(); closeDb(); fs.rmSync(HOME, { recursive: true, force: true }); });

const page = async (who, url) => {
  const res = await fetch(base + url, { headers: { Cookie: cookies[who] }, redirect: 'manual' });
  return { status: res.status, html: await res.text() };
};

test('a new install starts with oversight off: the admin finds nothing of anyone else’s', async () => {
  assert.equal(O.oversightOn(), false);
  const t = mainThread(member.id);
  assert.throws(() => threadForViewer(t.id, admin), e => e.status === 404, 'their chat does not exist for the admin');
  const item = library.createItem({ user: member, title: 'Diary', type: 'md', content: 'private' });
  assert.throws(() => library.itemForUser(admin, item.public_id), e => e.status === 404);
  const p = projectFromThread(member, createSideThread(member.id, 'Garden'), { name: 'Garden' });
  assert.throws(() => projectForUser(admin, p.public_id), e => e.status === 404);
  assert.equal((await page('admin', `/chat/${t.id}`)).status, 404);
  // The person page says the chats are private; members see no "can read" line.
  assert.match((await page('admin', `/admin/people/${member.id}`)).html, /Private to them/);
  assert.doesNotMatch((await page('member', '/chat')).html, /Admins can read your chats/);
  assert.doesNotMatch((await page('member', '/me')).html, /data-oversight-notice/);
});

test('turned on: read-only views work and are logged, and members are told in chat and on You', async () => {
  const res = await fetch(`${base}/admin/oversight`, { method: 'POST', headers: { Cookie: cookies.admin, 'Content-Type': 'application/json',
    'X-Requested-With': 'jessbot', Origin: base }, body: JSON.stringify({ readChats: true }) });
  assert.equal(res.status, 200);
  assert.equal(O.oversightOn(), true);
  assert.ok(get(`SELECT 1 AS x FROM audit_log WHERE action = 'admin.oversight'`), 'the change is audited');
  const t = mainThread(member.id);
  assert.equal(threadForViewer(t.id, admin).asAdmin, true);
  assert.ok(get(`SELECT 1 AS x FROM audit_log WHERE action = 'thread.view_as_admin' AND target_id = ?`, String(t.id)), 'the view is audited');
  assert.throws(() => threadForViewer(t.id, admin, { write: true }), e => e.status === 403, 'never write');
  assert.equal((await page('admin', `/chat/${t.id}`)).status, 200);
  assert.match((await page('member', '/chat')).html, /Admins can read your chats here/);
  assert.match((await page('member', '/me')).html, /data-oversight-notice/);
  const me = await (await fetch(`${base}/api/v1/me`, { headers: { Cookie: cookies.member } })).json();
  assert.equal(me.adminsCanRead, true);
  // A member never gets oversight, whatever the setting.
  assert.equal(O.adminMayView(member), false);
  O.setOversight(false, admin.id);
  assert.equal((await page('admin', `/chat/${t.id}`)).status, 404, 'off again: gone again');
});

test('the migration keeps what an existing install had; a new install is left off', async () => {
  settings.set('oversight', null);
  const db = { get, run: (await import('../src/db/index.js')).run };
  await db.run(`DELETE FROM settings WHERE key = 'oversight'`);
  await up(db); // users exist here: an install from before the setting
  assert.equal(O.oversightOn(), true);
  assert.equal(O.oversightState().keptFromBefore, true);
  await db.run(`DELETE FROM settings WHERE key = 'oversight'`);
  const noUsers = { get: sql => (/COUNT\(\*\)/.test(sql) ? { n: 0 } : undefined), run: () => assert.fail('wrote a setting on a fresh install') };
  await up(noUsers);
  assert.equal(O.oversightOn(), false);
});

test('only an admin can change it', async () => {
  const res = await fetch(`${base}/admin/oversight`, { method: 'POST', headers: { Cookie: cookies.member, 'Content-Type': 'application/json',
    'X-Requested-With': 'jessbot', Origin: base }, body: JSON.stringify({ readChats: true }) });
  assert.ok([403, 404].includes(res.status), `status ${res.status}`);
});

test('the You page keeps its tabs whatever the setting (they were once lost to a misplaced comment)', async () => {
  for (const on of [false, true]) {
    O.setOversight(on, admin.id);
    const html = (await page('member', '/me')).html;
    assert.match(html, /data-me-tab="places"/, `tabs missing with oversight ${on ? 'on' : 'off'}`);
  }
  O.setOversight(false, admin.id);
});
