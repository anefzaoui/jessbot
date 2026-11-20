// The assistant's pictures (#7): uploads are checked by their bytes and size, drawn again as WebP without their metadata
// (and upright), stored under a random id, served only to signed-in people with locked-down headers, and replaced or
// removed cleanly. Run: npm test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { listen } from './helpers/listen.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-pictures-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env');
process.env.JESSBOT_EMBED_OFF = '1';
process.env.JESSBOT_DECIDE_OFF = '1';
for (const k of ['PUBLIC_URL', 'ALLOWED_HOSTS', 'ALLOWED_ORIGINS', 'HOST']) delete process.env[k];

const { openDb, closeDb, settings } = await import('../src/db/index.js');
const { ensureDirs } = await import('../src/config/index.js');
ensureDirs();
await openDb();
const P = await import('../src/services/assistant-pictures.js');
const { presenceFor } = await import('../src/services/presence.js');
const { identityBlock } = await import('../src/services/workspace.js');
const { createUser } = await import('../src/services/users.js');
const { createSession } = await import('../src/services/sessions.js');
const { createApp } = await import('../src/app.js');
const { createCanvas, loadImage } = await import('@napi-rs/canvas');

// ---- Test pictures -------------------------------------------------------------------------------------------------
// w×h, left half blue, right half red.
async function halves(w, h, type = 'png') {
  const c = createCanvas(w, h), ctx = c.getContext('2d');
  ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 0, w / 2, h);
  return Buffer.from(await c.encode(type === 'jpeg' ? 'jpeg' : type, 95));
}
// A JPEG with an EXIF block (orientation + Artist) put in after SOI, and bytes appended after the image ends.
function withExif(jpeg, { orientation = 6, artist = 'PLANTED-ARTIST' } = {}) {
  const text = Buffer.from(`${artist}\0`);
  const ifd = Buffer.alloc(2 + 2 * 12 + 4);
  ifd.writeUInt16LE(2, 0);
  ifd.writeUInt16LE(0x0112, 2); ifd.writeUInt16LE(3, 4); ifd.writeUInt32LE(1, 6); ifd.writeUInt16LE(orientation, 10);
  ifd.writeUInt16LE(0x013B, 14); ifd.writeUInt16LE(2, 16); ifd.writeUInt32LE(text.length, 18); ifd.writeUInt32LE(8 + ifd.length, 22);
  const tiff = Buffer.concat([Buffer.from('II*\0'), Buffer.from([8, 0, 0, 0]), ifd, text]);
  const body = Buffer.concat([Buffer.from('Exif\0\0'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([(body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2), Buffer.from('PLANTED-TRAILER')]);
}
// A real PNG whose header claims 20000×20000 (nothing to decode, the size check must refuse it first).
async function claimsHuge() {
  const png = await halves(64, 64);
  png.writeUInt32BE(20000, 16); png.writeUInt32BE(20000, 20);
  png.writeUInt32BE(zlib.crc32(png.subarray(12, 29)), 29);
  return png;
}
const pixel = async (buf, x, y) => {
  const img = await loadImage(buf);
  const c = createCanvas(img.width, img.height), ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(x, y, 1, 1).data;
  return d[2] > 150 && d[0] < 100 ? 'blue' : d[0] > 150 && d[2] < 100 ? 'red' : `${d[0]},${d[1]},${d[2]}`;
};
const sizeOf = async buf => { const i = await loadImage(buf); return `${i.width}x${i.height}`; };
const refusal = async (fn, re) => { await assert.rejects(fn, err => err.status === 422 && re.test(err.errors?.picture || '')); };

let server, base, adminCookie, memberCookie;
before(async () => {
  const admin = await createUser({ name: 'Alex Admin', email: 'alex@pictures.test', password: 'correct horse battery', role: 'admin' });
  const member = await createUser({ name: 'Maya Member', email: 'maya@pictures.test', password: 'correct horse battery' });
  settings.set('setup', { done: ['account', 'model', 'browser', 'identity', 'people'], completedAt: new Date().toISOString() });
  settings.set('bot', { name: 'Nova', variant: 'neutral', tone: 'calm', pronouns: 'they/them', description: '' });
  adminCookie = `jb_session=${createSession(admin.id)}`;
  memberCookie = `jb_session=${createSession(member.id)}`;
  server = await listen(createApp());
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); closeDb(); fs.rmSync(HOME, { recursive: true, force: true }); });

test('refused: not a picture (by its bytes), SVG, a header claiming 400 megapixels, a tiny one, over 10 MB', async () => {
  await refusal(() => P.reencode(Buffer.from('<script>alert(1)</script>'), 'avatar'), /PNG, JPEG, WebP or GIF/);
  await refusal(() => P.reencode(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'avatar'), /PNG, JPEG, WebP or GIF/);
  await refusal(() => P.reencode(fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'img', 'favicon.svg')), 'cover'), /PNG, JPEG, WebP or GIF/);
  await refusal(async () => P.reencode(await claimsHuge(), 'background'), /40 megapixels/);
  await refusal(async () => P.reencode(await halves(40, 40), 'avatar'), /too small/);
  await refusal(async () => P.reencode(Buffer.concat([await halves(100, 100), Buffer.alloc(P.UPLOAD_MAX_BYTES)]), 'avatar'), /10 MB/);
  await assert.rejects(() => P.reencode(Buffer.from('x'), 'favicon'), err => err.status === 422);
});

test('re-encoded: EXIF, the planted text and trailing bytes are gone; a sideways phone photo comes out upright; square crops', async () => {
  const src = withExif(await halves(200, 100, 'jpeg'));
  assert.ok(src.includes('PLANTED-ARTIST') && src.includes('PLANTED-TRAILER'));
  const out = await P.reencode(src, 'avatar');
  for (const buf of [out.large, out.small]) {
    assert.equal(buf.subarray(8, 12).toString(), 'WEBP');
    assert.ok(!buf.includes('PLANTED') && !buf.includes('Exif'), 'no metadata left');
  }
  assert.equal(await sizeOf(out.large), '100x100', 'a centred square, never enlarged');
  // Orientation 6 turns the stored 200×100 a quarter clockwise: the blue left half ends up on top.
  assert.equal(await pixel(out.large, 50, 10), 'blue');
  assert.equal(await pixel(out.large, 50, 90), 'red');
  const big = await P.reencode(await halves(3000, 2000), 'background');
  assert.equal(await sizeOf(big.large), '1024x1024');
  assert.equal(await sizeOf(big.small), '256x256');
  const cover = await P.reencode(await halves(4000, 1000, 'webp'), 'cover');
  assert.equal(await sizeOf(cover.large), '1920x480', 'a cover keeps its shape');
  assert.equal(cover.small, undefined);
});

test('stored and replaced: a new upload is a new id, the old files are deleted; picking the built-in art removes the upload', async () => {
  const first = await P.savePicture('avatar', await halves(300, 300));
  assert.equal(first.kind, 'upload');
  assert.match(first.id, /^[0-9a-f]{16}$/);
  const files = () => fs.readdirSync(P.dir()).sort();
  assert.deepEqual(files(), [`avatar-${first.id}-256.webp`, `avatar-${first.id}.webp`]);
  const second = await P.savePicture('avatar', await halves(300, 300));
  assert.notEqual(second.id, first.id);
  assert.deepEqual(files(), [`avatar-${second.id}-256.webp`, `avatar-${second.id}.webp`]);
  assert.equal(P.pictureFile(`avatar-${first.id}.webp`), null, 'the old address is gone');
  assert.ok(P.pictureFile(`avatar-${second.id}-256.webp`));
  for (const bad of ['../jessbot.sqlite', `avatar-${second.id}.png`, `avatar-${second.id}.webp/..`, 'cover-0000000000000000.webp', '']) {
    assert.equal(P.pictureFile(bad), null, bad);
  }
  P.pickPicture('avatar', { kind: 'look' });
  assert.deepEqual(files(), []);
  assert.throws(() => P.pickPicture('background', { kind: 'scene', scene: '../../etc' }), err => err.status === 422);
  assert.throws(() => P.pickPicture('avatar', { kind: 'upload' }), err => err.status === 422);
  assert.deepEqual(P.pickPicture('background', { kind: 'scene', scene: 'night-clear' }), { kind: 'scene', scene: 'night-clear' });
  P.pickPicture('background', { kind: 'sky' });
});

test('presence: the pictures for signed-in people, the built-in look for everyone else; the identity block says how it is drawn', async () => {
  const a = await P.savePicture('avatar', await halves(300, 300));
  const c = await P.savePicture('cover', await halves(800, 300));
  P.pickPicture('background', { kind: 'scene', scene: 'dusk-rain' });
  const bot = settings.get('bot');
  const signedIn = presenceFor({ bot, user: { id: 1 } });
  assert.equal(signedIn.avatarBase, `/assistant-pictures/avatar-${a.id}`);
  assert.deepEqual(signedIn.frames, ['neutral']);
  assert.equal(signedIn.avatarUpload, true);
  assert.equal(signedIn.scene, 'dusk-rain');
  assert.equal(signedIn.pinned, true);
  assert.deepEqual(signedIn.cover, { url: `/assistant-pictures/cover-${c.id}/picture.webp`, live: false });
  const anyone = presenceFor({ bot, user: null });
  assert.equal(anyone.avatarBase, '/img/avatars/neutral');
  assert.equal(anyone.pinned, false);
  assert.equal(anyone.cover.live, true);
  assert.match(identityBlock(bot), /a picture the admin chose/);
  P.pickPicture('avatar', { kind: 'look' });
  assert.match(identityBlock(bot), /a portrait of an androgynous person/);
  P.pickPicture('cover', { kind: 'sky' });
  P.pickPicture('background', { kind: 'sky' });
});

test('routes: only the admin uploads; files go to signed-in people as image/webp with nosniff and a CSP that allows nothing', async () => {
  const upload = async (cookie, slot, buf, name = 'x.png') => {
    const fd = new FormData();
    fd.append('picture', new Blob([buf]), name);
    return fetch(`${base}/admin/identity/pictures/${slot}`, { method: 'POST', body: fd, headers: { Cookie: cookie, Origin: base, Accept: 'application/json', 'X-Requested-With': 'jessbot' }, redirect: 'manual' });
  };
  const member = await upload(memberCookie, 'avatar', await halves(300, 300));
  assert.ok([403, 404].includes(member.status), `a member can't upload (${member.status})`);
  const bad = await upload(adminCookie, 'avatar', Buffer.from('#!/bin/sh\necho not a picture\n'), 'cat.png');
  assert.equal(bad.status, 422);
  assert.match((await bad.json()).errors.picture, /PNG, JPEG, WebP or GIF/);
  assert.equal((await upload(adminCookie, 'avatar', Buffer.from('GIF89a but not really'))).status, 422, 'a GIF signature with nothing behind it');
  const tooBig = await upload(adminCookie, 'avatar', Buffer.alloc(P.UPLOAD_MAX_BYTES + 10));
  assert.equal(tooBig.status, 422);
  assert.match((await tooBig.json()).errors.picture, /over 10 MB/);
  const ok = await upload(adminCookie, 'avatar', await halves(300, 300), 'me.jpg');
  assert.equal(ok.status, 200);
  const { choice } = await ok.json();
  const url = `/assistant-pictures/avatar-${choice.id}/neutral-256.webp`;
  const got = await fetch(`${base}${url}`, { headers: { Cookie: memberCookie } });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/webp');
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(got.headers.get('content-security-policy'), "default-src 'none'");
  assert.equal((await got.arrayBuffer()).byteLength, fs.statSync(path.join(P.dir(), `avatar-${choice.id}-256.webp`)).size);
  const anon = await fetch(`${base}${url}`, { redirect: 'manual' });
  assert.ok([302, 401].includes(anon.status), `signed out: ${anon.status}`);
  for (const p of [`/assistant-pictures/avatar-${choice.id}/..%2F..%2Fjessbot.sqlite`, '/assistant-pictures/avatar-0123456789abcdef/neutral.webp',
    `/assistant-pictures/avatar-${choice.id}/neutral.png`]) {
    assert.equal((await fetch(`${base}${p}`, { headers: { Cookie: memberCookie } })).status, 404, p);
  }
  const page = await (await fetch(`${base}/admin/identity`, { headers: { Cookie: adminCookie } })).text();
  assert.match(page, new RegExp(`<link rel="icon" href="/assistant-pictures/avatar-${choice.id}/neutral-256.webp"`));
  assert.match(page, /id="pictures"/);
  const reset = await fetch(`${base}/admin/identity/pictures/avatar/choice`, { method: 'POST', redirect: 'manual',
    headers: { Cookie: adminCookie, Origin: base, Accept: 'application/json', 'X-Requested-With': 'jessbot', 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'look' }) });
  assert.equal(reset.status, 200);
  assert.equal((await fetch(`${base}${url}`, { headers: { Cookie: memberCookie } })).status, 404, 'gone once replaced');
});
