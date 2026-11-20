// Family lists (decision #139) for the web UI and the Android app. Every call goes through services/lists.js, which decides
// visibility from who is asking (own lists + their groups' lists; a wisher never sees "bought"). Changes are published as
// `list.updated` { listId } to everyone who shares the list; a page refetches GET /lists/:id.
// ?fragment=1 (the Lists page, Phase 25): the same data plus `html`, the page's own partial rendered on the server (one
// source of markup), so a live refresh or a reconcile after a tick never rebuilds rows in the browser.
import { Router } from 'express';
import * as L from '../../../services/lists.js';

const router = Router();
const fragment = (res, partial, data) => new Promise((resolve, reject) =>
  res.render('fragment', { layout: false, partial, data, ...data }, (err, html) => (err ? reject(err) : resolve(html))));

// ?archived=1 → the archived lists instead (to restore one).
router.get('/lists', async (req, res) => {
  if (req.query.archived === '1') return res.json({ lists: L.archivedListsOf(req.user).map(l => L.listView(l, req.user)) });
  if (req.query.fragment !== '1') return res.json({ lists: L.listsOf(req.user).map(l => L.listView(l, req.user)) });
  const page = L.listsPage(req.user);
  res.json({ lists: page.lists, html: await fragment(res, 'lists/index-body', { page }) });
});

router.post('/lists', (req, res) => {
  const b = req.body || {};
  const { list, existed } = L.createList(req.user, { title: b.title, kind: b.kind, scope: b.scope || 'private', wisherId: b.wisherId ?? null });
  res.status(existed ? 200 : 201).json({ list: L.listView(list, req.user), existed });
});

router.get('/lists/:id', async (req, res) => {
  if (req.query.fragment !== '1') return res.json(L.showList(req.user, req.params.id));
  const detail = L.listDetail(req.user, req.params.id);
  res.json({ list: detail.list, items: detail.items, members: detail.members, html: await fragment(res, 'lists/items', { detail }) });
});

router.patch('/lists/:id', (req, res) => {
  const list = L.updateList(req.user, req.params.id, { title: req.body?.title, kind: req.body?.kind });
  res.json({ list: L.listView(list, req.user) });
});

router.delete('/lists/:id', (req, res) => { L.archiveList(req.user, req.params.id); res.json({ ok: true }); });

router.post('/lists/:id/restore', (req, res) => res.json({ list: L.listView(L.restoreList(req.user, req.params.id), req.user) }));

// Items: one or many ({ items: [...] } or a single { text, qty?, category?, assigneeId?, due? }).
router.post('/lists/:id/items', (req, res) => {
  const b = req.body || {};
  const r = L.addItems(req.user, req.params.id, Array.isArray(b.items) ? b.items : [b]);
  res.status(r.added.length ? 201 : 200).json(r);
});

router.patch('/lists/:id/items/:itemId', (req, res) => res.json({ item: L.updateItem(req.user, req.params.id, req.params.itemId, req.body || {}) }));

router.delete('/lists/:id/items/:itemId', (req, res) => res.json(L.deleteItem(req.user, req.params.id, req.params.itemId)));

router.post('/lists/:id/clear-done', (req, res) => {
  const r = L.removeItems(req.user, req.params.id, [], { clearDone: true });
  res.json({ removed: r.changed.length, list: r.list });
});

export default router;
