// Library pages + artifact files (decision #47). HTML artifacts are model-written and may echo web content, so
// they are ALWAYS served with a CSP `sandbox` (opaque origin: no cookies, no storage, no same-origin API access)
// — inside the viewer's sandboxed iframe and when opened full screen alike — and they cannot call any network API.
import { Router } from 'express';
import fs from 'node:fs';
import { libraryData, itemForUser, itemView, renderedDoc, readContent, versionsOf, thumbFile, isBinary, fileOf, audioView, ARTIFACT_CSP, pageFileOf,
  PREVIEW_PAGES, previewLater, metaOf } from '../../services/library.js';
import { ocrOffer, ocrReading } from '../../services/ocr.js';
import { listenJob } from '../../services/read-aloud.js';
import { dollars } from '../../services/images.js';
import { voiceSettings } from '../../services/voice.js';
import { viewerDrawsAnswers } from '../../services/pdf-viewer.js';
import { audit } from '../../services/audit.js';
import { notFound } from '../../lib/errors.js';

export { ARTIFACT_CSP };

const router = Router();

function viewItem(req) {
  const item = itemForUser(req.user, req.params.id);
  if (item.owner_id !== req.user.id) audit('library.view_as_admin', { actorId: req.user.id, targetType: 'library', targetId: item.id });
  return item;
}

function versionParam(req, item) {
  if (req.query.v === undefined) return item.version;
  const v = Number(req.query.v);
  if (!Number.isInteger(v) || v < 1 || v > item.version) throw notFound('That version doesn’t exist.');
  return v;
}

// ?type= opens it filtered (a chip key, or an item type; the page keeps it in the address as the filter changes, #212).
router.get('/library', (req, res) => res.render('library', { nav: 'library', title: 'Library',
  library: libraryData(req.user, { type: typeof req.query.type === 'string' ? req.query.type : null }) }));

router.get('/library/:id', async (req, res) => {
  const item = viewItem(req);
  previewLater(item); // an older PDF (or an office file, once LibreOffice is installed) gets its pictures for next time
  res.render('library-item', {
    nav: 'library', title: item.title, mainClass: 'min-h-0 flex-1 overflow-hidden',
    item: { ...itemView(item), html: renderedDoc(item), audio: audioView(item, { rate: voiceSettings().speed }), viewerDraws: await viewerDrawsAnswers(item),
      // Phase 25 (#196): how a picture Jess made was made; whether a scan can be read, and a reading or a Listen in progress.
      madeWith: madeWithOf(item), ocrOffer: ocrOffer(item), ocrReading: ocrReading(req.user, item),
      listenable: !['image', 'audio'].includes(item.type) && item.ext !== 'ics', listen: listenJob(req.user, item) },
    versions: versionsOf(item),
    readOnly: item.owner_id !== req.user.id,
  });
});

// A picture made with the image model (services/images.js keeps these in the version's meta sidecar): what the viewer says.
function madeWithOf(item) {
  if (item.type !== 'image') return null;
  const m = metaOf(item);
  if (!m?.model) return null;
  return { model: m.model, prompt: m.prompt || null, style: m.style ? String(m.style).replace(/_/g, ' ') : null,
    size: m.width && m.height ? `${m.width}×${m.height}` : m.aspectRatio || null, costLabel: m.cost != null ? dollars(m.cost) : null };
}

router.get('/library/:id/raw', (req, res) => {
  const item = viewItem(req);
  res.set('Cache-Control', 'private, no-cache');
  // Uploaded files (PDF, images, Word, CSV) are served as the bytes they are, with their sniffed type; nosniff is global.
  if (item.source_label === 'Uploaded' || isBinary(item)) {
    res.set('Content-Disposition', 'inline');
    return res.type(item.mime).sendFile(fileOf(item, versionParam(req, item)));
  }
  const body = readContent(item, versionParam(req, item));
  if (item.type === 'html') {
    res.set('Content-Security-Policy', ARTIFACT_CSP);
    res.type('html').send(body);
  } else res.type('text/plain; charset=utf-8').send(body);
});

router.get('/library/:id/download', (req, res) => {
  const item = viewItem(req);
  const v = versionParam(req, item);
  const slug = item.title.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase().slice(0, 60) || 'item';
  const name = `${slug}${v !== item.version ? `-v${v}` : ''}.${item.ext}`;
  res.set('Content-Disposition', `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  if (item.source_label === 'Uploaded' || isBinary(item)) return res.type(item.mime).sendFile(fileOf(item, v));
  if (item.type === 'html') res.set('Content-Security-Policy', ARTIFACT_CSP);
  // Its own type: a document is markdown, a calendar file text/calendar (phones offer to add it, #160), a downloaded CSV text/csv.
  res.type(item.type === 'html' ? 'html' : item.mime || 'text/markdown; charset=utf-8').send(readContent(item, v));
});

router.get('/library/:id/thumb.jpg', (req, res) => {
  const item = viewItem(req);
  const file = thumbFile(item);
  if (!item.has_thumb || !fs.existsSync(file)) throw notFound();
  res.set('Cache-Control', 'private, max-age=86400');
  res.type('jpg').sendFile(file);
});

// Pictures of an office file's first pages as LibreOffice prints them (decision #162); ?v= picks the version.
router.get('/library/:id/pages/:n.jpg', (req, res) => {
  const item = viewItem(req);
  const v = versionParam(req, item);
  const n = Number(req.params.n);
  const file = pageFileOf(item, n, v);
  if (!Number.isInteger(n) || n < 1 || n > PREVIEW_PAGES || !fs.existsSync(file)) throw notFound();
  res.set('Cache-Control', 'private, max-age=86400');
  res.type('jpg').sendFile(file);
});

export default router;
