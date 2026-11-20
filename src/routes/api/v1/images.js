// Pictures (decision #169, docs/API.md): the admin's image model for make_image. Empty = pictures off. Who may use it is a
// permission (the 'images' toolset, Admin → People / Groups), not a setting here. Admin only.
import { Router } from 'express';
import { saveImageSettings } from '../../../services/images.js';
import { audit } from '../../../services/audit.js';
import { forbidden } from '../../../lib/errors.js';

const router = Router();

router.post('/admin/images', async (req, res) => {
  if (req.user.role !== 'admin') throw forbidden('Only the admin can choose the image model.');
  const out = await saveImageSettings({ model: req.body?.model });
  audit('images.settings', { actorId: req.user.id, detail: { model: out.settings.model || 'off' } });
  res.json({ ok: true, ...out });
});

export default router;
