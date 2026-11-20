// File names that come from a request (a URL segment, a form field) become paths only through here (decision #224,
// code scanning #22): a plain name (no separators, no "..", no drive letters), resolved inside its folder and checked to
// still be inside it.
import fs from 'node:fs';
import path from 'node:path';

const PLAIN = /^[\w][\w.-]{0,199}$/; // starts with a word character: no ".", "..", or hidden-file tricks

/** The path of `name` inside `root`, or null when name isn't a plain file name or would land outside root. */
export function inside(root, name) {
  const n = String(name ?? '');
  if (!PLAIN.test(n) || n.includes('..')) return null;
  const base = path.resolve(root);
  const full = path.resolve(base, n);
  return full.startsWith(base + path.sep) ? full : null;
}

// Check-then-use without a gap (code scanning's file-system race): the size or age is read from the same open file that
// is then read, and a file that must be written once is created exclusively.

/** { stat, read() } of one open file; read() returns its bytes (or text with an encoding). Closes after read or skip. */
export function openRead(file) {
  const fd = fs.openSync(file, 'r');
  let closed = false;
  const close = () => { if (!closed) { closed = true; fs.closeSync(fd); } };
  try {
    const stat = fs.fstatSync(fd);
    return { stat, read: encoding => { try { return fs.readFileSync(fd, encoding); } finally { close(); } }, close };
  } catch (err) { close(); throw err; }
}

/** Write a file only if it doesn't exist yet (content-addressed files). → true when written. */
export function writeNew(file, data) {
  try { fs.writeFileSync(file, data, { flag: 'wx' }); return true; } catch (err) { if (err.code === 'EEXIST') return false; throw err; }
}
