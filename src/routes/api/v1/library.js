// Library API (Phase 6, decision #47) — for the web UI and apps. Owners change their items; admins may only view.
import { Router } from 'express';
import { listItems, itemForUser, itemView, versionsOf, describeItem, deleteItem, restoreItem, restoreVersion } from '../../../services/library.js';
import { audit } from '../../../services/audit.js';
import { publish } from '../../../lib/bus.js';
import { ocrEstimate, readScan, ocrReading } from '../../../services/ocr.js';
import { listenEstimate, listenJob, startListen } from '../../../services/read-aloud.js';

const router = Router();

// ?query= ranks best matches first; ?type=pdf|sheet|doc|md|html|image|slides|audio only filters (#207).
router.get('/library', (req, res) => res.json({ items: listItems(req.user, { query: req.query.query || '', type: req.query.type || null }).map(itemView) }));

router.get('/library/:id', (req, res) => {
  const item = itemForUser(req.user, req.params.id);
  res.json({ item: itemView(item), versions: versionsOf(item) });
});

router.patch('/library/:id', (req, res) => {
  // { title?, description? }: either or both (decision #147); the file itself isn't touched.
  const item = describeItem(itemForUser(req.user, req.params.id, { write: true }), { title: req.body?.title, description: req.body?.description });
  publish(req.user.id, 'library.updated', { item: itemView(item) });
  res.json({ item: itemView(item) });
});

router.delete('/library/:id', (req, res) => {
  const item = itemForUser(req.user, req.params.id, { write: true });
  deleteItem(item);
  audit('library.delete', { actorId: req.user.id, targetType: 'library', targetId: item.id });
  publish(req.user.id, 'library.deleted', { id: item.public_id });
  res.json({ ok: true, undo: `/api/v1/library/${item.public_id}/restore` });
});

router.post('/library/:id/restore', (req, res) => {
  const item = itemForUser(req.user, req.params.id, { write: true, includeDeleted: true });
  restoreItem(item);
  res.json({ item: itemView(item) });
});

router.post('/library/:id/versions/:v/restore', (req, res) => {
  const item = restoreVersion(itemForUser(req.user, req.params.id, { write: true }), req.params.v);
  publish(req.user.id, 'library.updated', { item: itemView(item) });
  res.json({ item: itemView(item), versions: versionsOf(item) });
});

// Reading a scan by OCR (decision #163), opt-in per file: { pages?, confirm? }. Without confirm → { estimate } (what it would
// read and roughly what it costs; nothing is spent). With confirm: true, after that estimate for the same pages → the reading.
router.post('/library/:id/ocr', async (req, res) => {
  const item = itemForUser(req.user, req.params.id, { write: true });
  const pages = req.body?.pages ? String(req.body.pages) : undefined;
  if (!req.body?.confirm) return res.json({ estimate: await ocrEstimate(req.user, item, { pages }) });
  const out = await readScan(req.user, item, { pages }); // remembered while it runs: a reloaded viewer shows "Reading …" (#196)
  const view = itemView(out.item);
  publish(req.user.id, 'library.updated', { item: view });
  res.json({ item: view, read: out.read, blank: out.blank, missing: out.missing, capped: out.capped, cost: out.cost, costLabel: out.costLabel, error: out.error });
});

// Is a scan being read right now (the viewer after a refresh)? → { reading: { startedAt, pages } | null }
router.get('/library/:id/ocr', (req, res) => res.json({ reading: ocrReading(req.user, itemForUser(req.user, req.params.id, { write: true })) }));

// Listen (#196): an item read aloud into a new audio item, in the background. { confirm? }: without it → { estimate: { minutes,
// minutesLabel, parts, limit, tooLong, overBudget } } (nothing is spent); with confirm: true → 202 { job } (400 when too long or
// over budget, 409 while it records). Progress: 'library.listen' { id, job } frames; GET → { job } after a refresh.
router.post('/library/:id/listen', (req, res) => {
  const item = itemForUser(req.user, req.params.id, { write: true });
  if (!req.body?.confirm) return res.json({ estimate: listenEstimate(req.user, item) });
  res.status(202).json({ job: startListen(req.user, item) });
});
router.get('/library/:id/listen', (req, res) => res.json({ job: listenJob(req.user, itemForUser(req.user, req.params.id, { write: true })) }));

export default router;
