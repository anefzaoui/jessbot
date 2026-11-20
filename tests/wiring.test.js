// Cross-chunk wiring the orchestrator added between parts built separately (docs/PLAN-SKILLS.md). Run: npm test.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-unit-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env');
process.env.JESSBOT_EMBED_OFF = '1';
process.env.JESSBOT_DECIDE_OFF = '1';

const { openDb, closeDb } = await import('../src/db/index.js');
const { ensureDirs } = await import('../src/config/index.js');
ensureDirs();
await openDb();
after(() => { closeDb(); fs.rmSync(HOME, { recursive: true, force: true }); });

const call = id => JSON.stringify([{ id, type: 'function', function: { name: 'library_create', arguments: '{}' } }]);

test('a page self-check screenshot in a tool result reaches the model as an image (decision #147)', async () => {
  const { shotRef } = await import('../src/services/page-check.js');
  const { __test: P } = await import('../src/agent/prompt.js');
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);
  const { ref } = shotRef(1, jpeg);
  const out = P.toChat([
    { id: 1, role: 'user', content: 'make me a page' },
    { id: 2, role: 'assistant', content: '', tool_calls: call('a') },
    { id: 3, role: 'tool', tool_call_id: 'a', content: 'Saved. Checks: page is 512 px wide on a phone', attachments: JSON.stringify([ref]) },
  ]);
  const img = out.at(-1);
  assert.equal(img.role, 'user');
  assert.equal(img.content[0].text, '(images from the steps above)');
  assert.equal(img.content[1].type, 'image_url');
  assert.match(img.content[1].image_url.url, /^data:image\/jpeg;base64,/);

  // An unknown or foreign-looking ref adds nothing (no crash, no empty image turn).
  const none = P.toChat([
    { id: 1, role: 'user', content: 'x' },
    { id: 2, role: 'assistant', content: '', tool_calls: call('b') },
    { id: 3, role: 'tool', tool_call_id: 'b', content: 'ok', attachments: JSON.stringify(['shot:../../etc/passwd', 'nope']) },
  ]);
  assert.equal(none.at(-1).role, 'tool');
});

test("a person's check-ins setting is part of the user object (proactive.js reads user.checkins)", async () => {
  const { createUser, getUser } = await import('../src/services/users.js');
  const { run } = await import('../src/db/index.js');
  const u = await createUser({ name: 'Dana Checkins', email: 'dana@t.dev', password: 'correct horse battery' });
  assert.equal(getUser(u.id).checkins, 'normal');
  run("UPDATE users SET checkins = 'off' WHERE id = ?", u.id);
  assert.equal(getUser(u.id).checkins, 'off');
});
