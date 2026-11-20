// The assistant's pictures (#7): the admin uploads or picks the avatar, the background behind it and the cover (the chat
// header and the Feed's greeting). Built-in art stays the default: the portrait set of the chosen look and the live sky
// (time of day × weather, decision #33).
//
// An upload is never served as it came. Its bytes must be a PNG, JPEG, WebP or GIF (file-type, not the name or the
// browser's claim), at most UPLOAD_MAX_BYTES and MAX_PIXELS (checked from the header before anything is decoded), and it is
// decoded and drawn again by @napi-rs/canvas into a new WebP: EXIF (location, camera, dates), XMP, comments and anything
// appended after the image are gone, a phone photo comes out upright, a GIF keeps its first frame. Avatar and background
// are cropped to a centred square (1024 px and 256 px files, the sizes the built-in art has); a cover keeps its shape, at
// most COVER_EDGE px wide. Files live in data/assistant/ under a random id ("avatar-<16 hex>.webp"), so a new upload is a
// new address (cached for good) and the old files are deleted. They are served only to signed-in people
// (routes/web/app.js), as image/webp with nosniff and a CSP that allows nothing.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import { imageSize } from 'image-size';
import { paths } from '../config/index.js';
import { settings } from '../db/index.js';
import { invalid } from '../lib/errors.js';
import { inside } from '../lib/safe-path.js';
import { presenceManifest } from './presence.js';

export const SLOTS = ['avatar', 'background', 'cover'];
export const UPLOAD_MAX_BYTES = 10 * 1048576;
export const MAX_PIXELS = 40e6;          // 40 megapixels: a big phone photo fits, a decompression bomb doesn't
const MIN_EDGE = 64;
const COVER_EDGE = 1920;
const QUALITY = 86;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
const FILE = /^(avatar|background|cover)-([0-9a-f]{16})(-256)?\.webp$/;

export const dir = () => path.join(paths.data, 'assistant');
const KEY = 'assistantPictures';
const DEFAULTS = { avatar: { kind: 'look' }, background: { kind: 'sky' }, cover: { kind: 'sky' } };

/** The admin's choices: { avatar: { kind: look|upload, id? }, background|cover: { kind: sky|scene|upload, scene?, id? } }. */
export function pictureChoices() {
  const saved = settings.get(KEY, {}) || {};
  return Object.fromEntries(SLOTS.map(s => [s, saved[s]?.kind ? saved[s] : DEFAULTS[s]]));
}

const badSlot = slot => { if (!SLOTS.includes(slot)) throw invalid({ picture: 'Unknown picture.' }); };
const fileOf = (slot, id, small = false) => inside(dir(), `${slot}-${id}${small ? '-256' : ''}.webp`);

function removeFiles(slot, id) {
  if (!id) return;
  for (const small of [false, true]) { const f = fileOf(slot, id, small); if (f) fs.rmSync(f, { force: true }); }
}

function writeAtomic(file, buf) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}

/** Check an upload and draw it again as WebP → { large, small? } buffers. Throws invalid({ picture }) with a reason. */
export async function reencode(buffer, slot) {
  badSlot(slot);
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw invalid({ picture: 'Choose a picture first.' });
  if (buffer.length > UPLOAD_MAX_BYTES) throw invalid({ picture: 'That picture is over 10 MB. Pick a smaller one.' });
  const ft = await fileTypeFromBuffer(buffer).catch(() => null);
  if (!ft || !TYPES.has(ft.mime)) throw invalid({ picture: 'Use a PNG, JPEG, WebP or GIF picture.' });
  let dims;
  try { dims = imageSize(buffer); } catch { throw invalid({ picture: 'That picture couldn’t be read.' }); }
  if (!dims?.width || !dims?.height) throw invalid({ picture: 'That picture couldn’t be read.' });
  if (dims.width * dims.height > MAX_PIXELS) throw invalid({ picture: 'That picture is too large (over 40 megapixels).' });
  if (Math.min(dims.width, dims.height) < MIN_EDGE) throw invalid({ picture: `That picture is too small (at least ${MIN_EDGE} px on each side).` });

  const { loadImage, createCanvas } = await import('@napi-rs/canvas');
  const img = await loadImage(buffer).catch(() => { throw invalid({ picture: 'That picture couldn’t be read.' }); });
  const draw = (w, h, crop) => {
    const c = createCanvas(w, h);
    c.getContext('2d').drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, w, h);
    return c.encode('webp', QUALITY).then(b => Buffer.from(b));
  };
  if (slot === 'cover') {
    const scale = Math.min(1, COVER_EDGE / img.width);
    const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
    return { large: await draw(w, h, { x: 0, y: 0, w: img.width, h: img.height }) };
  }
  // A centred square: the portrait's face and the sky's middle are where people put them.
  const side = Math.min(img.width, img.height);
  const crop = { x: Math.floor((img.width - side) / 2), y: Math.floor((img.height - side) / 2), w: side, h: side };
  const big = Math.min(1024, side);
  return { large: await draw(big, big, crop), small: await draw(Math.min(256, side), Math.min(256, side), crop) };
}

/** Store an upload for a slot and make it the slot's choice → the new choice. The previous upload's files are deleted. */
export async function savePicture(slot, buffer) {
  const out = await reencode(buffer, slot);
  fs.mkdirSync(dir(), { recursive: true });
  const id = crypto.randomBytes(8).toString('hex');
  writeAtomic(fileOf(slot, id), out.large);
  if (out.small) writeAtomic(fileOf(slot, id, true), out.small);
  const before = pictureChoices()[slot];
  setChoice(slot, { kind: 'upload', id });
  if (before.kind === 'upload' && before.id !== id) removeFiles(slot, before.id);
  return pictureChoices()[slot];
}

/** Pick for a slot without uploading: avatar → look; background/cover → sky | scene (one of the built-in scenes). */
export function pickPicture(slot, { kind, scene } = {}) {
  badSlot(slot);
  const allowed = slot === 'avatar' ? ['look'] : ['sky', 'scene'];
  if (!allowed.includes(kind)) throw invalid({ kind: 'Pick one of the choices.' });
  if (kind === 'scene' && !presenceManifest().scenes.includes(scene)) throw invalid({ scene: 'Pick one of the scenes.' });
  const before = pictureChoices()[slot];
  setChoice(slot, kind === 'scene' ? { kind, scene } : { kind });
  if (before.kind === 'upload') removeFiles(slot, before.id);
  return pictureChoices()[slot];
}

function setChoice(slot, choice) {
  settings.set(KEY, { ...pictureChoices(), [slot]: choice });
}

/** A stored picture's path for the route, from its file name, or null (not one of ours, or not the current one). */
export function pictureFile(name) {
  const m = FILE.exec(String(name ?? ''));
  if (!m) return null;
  const choice = pictureChoices()[m[1]];
  if (choice.kind !== 'upload' || choice.id !== m[2]) return null;
  return fileOf(m[1], m[2], !!m[3]);
}

/** Where a slot's uploaded picture is served: "/assistant-pictures/<slot>-<id>" (+ "/<frame>[-256].webp"). */
export const pictureBase = (slot, id) => `/assistant-pictures/${slot}-${id}`;
