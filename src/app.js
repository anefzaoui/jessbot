import express from 'express';
import { engine } from 'express-handlebars';
import path from 'node:path';
import { config, paths } from './config/index.js';
import helpers from './views/helpers.js';
import { securityHeaders } from './middleware/security.js';
import { locals } from './middleware/locals.js';
import webRoutes from './routes/web/index.js';
import apiRoutes from './routes/api/v1/index.js';
import { loadUser, sameOrigin } from './middleware/auth.js';
import { isAjax } from './lib/respond.js';
import { HttpError } from './lib/errors.js';
import { configureRenderer } from './views/render.js';
import { staticCacheHeaders } from './lib/assets.js';
import './agent/tools/index.js'; // register the built-in tools

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy); // TRUST_PROXY (src/config): who may set X-Forwarded-For

  app.engine('hbs', engine({
    extname: '.hbs',
    defaultLayout: 'app',
    layoutsDir: path.join(paths.views, 'layouts'),
    partialsDir: path.join(paths.views, 'partials'),
    helpers,
  }));
  app.set('view engine', 'hbs');
  app.set('views', path.join(paths.views, 'pages'));
  configureRenderer(app);

  app.use(securityHeaders);
  app.use(express.static(paths.public, { index: false, setHeaders: staticCacheHeaders }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(loadUser);
  app.use(locals);
  app.use(sameOrigin);

  app.use('/api/v1', apiRoutes);
  app.use('/', webRoutes);

  app.use((req, res) => {
    res.status(404).render('error', { layout: 'base', title: 'Not found', code: 404,
      message: "That page doesn't exist — or it moved." });
  });

  // Express 5 forwards rejected promises from async handlers here.
  app.use((err, req, res, _next) => {
    const code = err.status || err.statusCode || 500;
    // 4xx messages are written for people ("That account isn’t connected any more"); 5xx details stay in the log (http-errors' rule).
    const expose = err.expose ?? code < 500;
    if (code >= 500) console.error(`[http] ${req.method} ${req.originalUrl.split('?')[0]} → ${code} (user ${req.user?.id ?? '-'})`, err);
    if (isAjax(req)) {
      return res.status(code).json({ error: expose ? err.message : 'Something went wrong on our side.', ...(err.errors && { errors: err.errors }),
        ...(expose && err instanceof HttpError && err.code && { code: err.code }) }); // code: a machine-readable reason (e.g. lint_bad)
    }
    res.status(code).render('error', { layout: 'base', title: 'Something broke', code,
      message: expose ? err.message : 'Jessbot hit an unexpected error. It has been logged.' });
  });

  return app;
}
