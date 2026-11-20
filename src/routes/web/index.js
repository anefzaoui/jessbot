import { Router } from 'express';
import appRoutes from './app.js';
import libraryRoutes from './library.js';
import styleguideRoutes from './styleguide.js';
import setupRoutes from './setup.js';
import authRoutes from './auth.js';
import adminRoutes from './admin.js';
import { requireSetup, requireAuth, requireAdmin } from '../../middleware/auth.js';
import { settings } from '../../db/index.js';
import { webManifest } from '../../services/presence.js';

const router = Router();

// Liveness probe for process managers / reverse proxies.
router.get('/healthz', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

// The web app manifest (#55, decision #253): before setup and sign-in, because the browser fetches it without the session
// cookie. It names the assistant and points at public icons; nothing else about the install.
router.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').set('Cache-Control', 'no-cache').send(JSON.stringify(webManifest(settings.get('bot', null) || {})));
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
