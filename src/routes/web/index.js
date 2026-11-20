import { Router } from 'express';
import appRoutes from './app.js';
import libraryRoutes from './library.js';
import styleguideRoutes from './styleguide.js';
import setupRoutes from './setup.js';
import authRoutes from './auth.js';
import adminRoutes from './admin.js';
import { requireSetup, requireAuth, requireAdmin } from '../../middleware/auth.js';

const router = Router();

// Liveness probe for process managers / reverse proxies.
router.get('/healthz', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

// Dev-only: component gallery + every page rendered with demo data against a simulated API.
if (process.env.NODE_ENV !== 'production') router.use('/styleguide', styleguideRoutes);

router.use('/setup', setupRoutes);            // first-run wizard (gates itself)
router.use(requireSetup);                     // nothing else until setup is complete
router.use('/', authRoutes);                  // /login, /logout, /invite/:token
router.use('/admin', requireAdmin, adminRoutes);
router.use('/', requireAuth, appRoutes);
router.use('/', requireAuth, libraryRoutes);

export default router;
