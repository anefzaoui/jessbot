// Uploads (Phase 10, decision #76): files from the composer's paperclip / drag & drop / paste, or the Library's "Add
// files". Each becomes a Library item; the chat message then refers to them by id (POST /threads/:id/messages).
import { Router } from 'express';
import multer from 'multer';
import { saveUpload, UPLOAD_MAX_BYTES, UPLOAD_MAX_FILES } from '../../../services/uploads.js';
import { invalid, tooMany } from '../../../lib/errors.js';
import { hit } from '../../../lib/ratelimit.js';
import { sizeLabel } from '../../../services/library.js';
import { publish } from '../../../lib/bus.js';
import { renderFragment } from '../../../views/render.js';
import { threadForViewer } from '../../../services/threads.js';

const router = Router();
// In memory (≤ 25 MB × 6): the bytes are sniffed and written once, by the Library, where they belong.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: UPLOAD_MAX_BYTES, files: UPLOAD_MAX_FILES, fields: 5 } });

const receive = (req, res) => new Promise((resolve, reject) => upload.array('file', UPLOAD_MAX_FILES)(req, res, err => {
  if (!err) return resolve();
  if (err.code === 'LIMIT_FILE_SIZE') return reject(invalid({ file: `A file is over ${sizeLabel(UPLOAD_MAX_BYTES)}.` }));
  if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') return reject(invalid({ file: `Up to ${UPLOAD_MAX_FILES} files at a time.` }));
  reject(invalid({ file: 'That upload didn’t come through — try again.' }));
}));

// → { files: [libraryItemView], errors: [{ name, error }] } — good files are kept even when others are refused.
router.post('/uploads', async (req, res) => {
  const l = hit(`uploads:${req.user.id}`, { limit: 60, windowMs: 10 * 60e3 });
  if (!l.allowed) throw tooMany(`That’s a lot of files — try again in ${Math.ceil(l.retryInMs / 60e3)} min.`);
  await receive(req, res);
  if (!req.files?.length) throw invalid({ file: 'Choose a file first.' });
  // The chat the files are for (their provenance, and a project chat's files join its project) — only the person's own.
  const threadId = Number(req.body?.threadId) || null;
  if (threadId) threadForViewer(threadId, req.user, { write: true });
  const files = [], errors = [];
  for (const f of req.files) {
    try {
      const view = await saveUpload(req.user, f, { threadId });
      files.push(view);
      // Open Library pages add the card live.
      publish(req.user.id, 'library.created', { item: view, html: await renderFragment('library-card', view, req.user).catch(() => null) });
    } catch (err) {
      errors.push({ name: Buffer.from(f.originalname || 'file', 'latin1').toString('utf8'), error: err.errors?.file || err.message });
    }
  }
  if (!files.length) throw invalid({ file: errors.map(e => e.error).join(' ') });
  res.status(201).json({ files, errors });
});

export default router;
