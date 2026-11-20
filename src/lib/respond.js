// Forms work with or without JS. public/js/forms.js sends X-Requested-With: jessbot and expects JSON
// ({ redirect } or { error, errors }); a plain HTML post gets a redirect or the page re-rendered with errors.
export const isAjax = req => req.get('X-Requested-With') === 'jessbot' || req.originalUrl.startsWith('/api/');

// Wrap a POST handler: handler returns { redirect?, json? } or throws HttpError (with optional field errors).
export function formPost(view, pageData, handler) {
  return async (req, res, next) => {
    try {
      const out = (await handler(req, res)) || {};
      if (res.headersSent) return;
      if (isAjax(req)) return res.json({ ok: true, ...out.json, redirect: out.redirect });
      return res.redirect(out.redirect || req.originalUrl);
    } catch (err) {
      if (!err.expose || isAjax(req)) return next(err);
      const data = typeof pageData === 'function' ? await pageData(req, res) : pageData;
      res.status(err.status || 422).render(view, { ...data, values: req.body, errors: err.errors || {}, error: err.errors ? null : err.message });
    }
  };
}
