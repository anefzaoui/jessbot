// Admin → Browser's second half (Phase 25, decision #195): forget a learned recipe, turn ad blocking back on for a site, and
// the office previews setting. Mounted inside routes/web/admin.js (admin-only). Each answers with the section re-rendered.
import { Router } from 'express';
import { browserExtras, deleteRecipe, allowBlockingAgain, saveOfficeSettings } from '../../services/browser-admin.js';
import { audit } from '../../services/audit.js';
import { renderFragment } from '../../views/render.js';

const router = Router();
const section = async req => renderFragment('admin/browser-extras', { extras: browserExtras() }, req.user);

router.delete('/browser/recipes/:id', async (req, res) => {
  const host = deleteRecipe(req.params.id);
  audit('browser.recipe_delete', { actorId: req.user.id, detail: { host } });
  res.json({ ok: true, html: await section(req) });
});

router.delete('/browser/adblock-off/:host', async (req, res) => {
  allowBlockingAgain(req.params.host);
  audit('browser.adblock_on', { actorId: req.user.id, detail: { host: req.params.host } });
  res.json({ ok: true, html: await section(req) });
});

// { previews: bool, soffice: path | '' } → the status (a path that isn't a file is 422 { errors: { soffice } }, nothing saved).
router.post('/browser/office', async (req, res) => {
  const office = saveOfficeSettings({ previews: req.body?.previews, soffice: req.body?.soffice });
  audit('office.settings', { actorId: req.user.id, detail: { previews: office.previews, soffice: office.soffice || null } });
  res.json({ ok: true, office, html: await section(req) });
});

export default router;
