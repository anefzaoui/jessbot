// Hand-over of Jess's browser tab (decision #61): the chat's owner sees the live tab and can click, scroll and type in it —
// to sign in, solve a check or do a step only they should do — then hands it back. Only the thread's owner (never an admin
// looking read-only). Frames and typed text are not logged.
import { Router } from 'express';
import { threadForViewer, mainThread } from '../../../services/threads.js';
import * as B from '../../../browser/session.js';
import { badRequest } from '../../../lib/errors.js';
import { activeRuns, getRun } from '../../../services/runs.js';
import { startTurn } from '../../../agent/loop.js';
import { assistantView, userView } from '../../../services/chatview.js';
import { signedInSites } from '../../../browser/profiles.js';
import { botName } from '../../../services/bot.js';

const router = Router();
const HANDBACK_TEXT = 'Done — I’ve handled it in the browser. Please take a fresh look and carry on.';
const fragment = (res, partial, data) => new Promise((resolve, reject) =>
  res.render('fragment', { layout: false, partial, data, ...data }, (err, html) => (err ? reject(err) : resolve(html))));

const tabOf = req => {
  const thread = req.params.id === 'main' ? mainThread(req.user.id) : threadForViewer(req.params.id, req.user, { write: true }).thread;
  if (thread.user_id !== req.user.id) throw badRequest('Only the person whose chat this is can use its browser.');
  return { thread, s: B.peek(`t${thread.id}`) };
};

// site: the registrable domain the tab is on; warnings: what looks wrong about it (browser/trust.js, decision #167 — look-alike
// letters, a brand's name on another domain, a password over http, a redirect through other sites). Shown before the person
// types anything into the tab (the viewer's warning line is Phase 25).
router.get('/threads/:id/browser', async (req, res) => {
  const { s } = tabOf(req);
  const page = s?.active;
  const trust = B.trustOf(s);
  res.json({ open: !!page, url: page?.url() || null, title: page ? await page.title().catch(() => '') : null, site: trust?.site || null, warnings: trust?.warnings || [] });
});

router.get('/threads/:id/browser/frame.jpg', async (req, res) => {
  const { s } = tabOf(req);
  let frame;
  // Mid-navigation Chromium can't capture ("Unable to capture screenshot"): a moment later it can. Not an error worth a stack.
  try { frame = await B.handoverFrame(s); } catch { return res.status(503).set('Retry-After', '1').json({ error: 'The page is changing — one moment.' }); }
  if (!frame) return res.status(404).json({ error: `${botName()} has no browser tab open in this chat.` });
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Page-Url': encodeURI(frame.url).slice(0, 500), 'X-Page-Title': encodeURIComponent(frame.title).slice(0, 300) });
  res.end(frame.buf);
});

// The tab as live video (decision #115): an MJPEG stream (multipart/x-mixed-replace) that an <img> plays natively — frames
// arrive as the page changes, up to ~10 a second; the screencast stops when the viewer closes.
router.get('/threads/:id/browser/stream.mjpg', async (req, res) => {
  const { s } = tabOf(req);
  if (!s?.active) return res.status(404).json({ error: `${botName()} has no browser tab open in this chat.` });
  const boundary = 'jbframe';
  res.writeHead(200, { 'Content-Type': `multipart/x-mixed-replace; boundary=${boundary}`, 'Cache-Control': 'no-store, no-transform',
    'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
  let stop = null, closed = false;
  req.on('close', () => { closed = true; stop?.(); });
  try {
    stop = await B.handoverStream(s, buf => {
      if (closed) return;
      res.write(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`);
      res.write(buf);
      res.write('\r\n');
    });
    if (closed) stop();
  } catch { res.end(); }
});

router.post('/threads/:id/browser/input', async (req, res) => {
  const { s } = tabOf(req);
  if (!s?.active) throw badRequest(`${botName()} has no browser tab open in this chat.`);
  res.json({ ok: true, ...(await B.handoverInput(s, req.body || {})) });
});

// Hand back. The server decides how Jess hears about it, so repeated hand-backs never pile up messages and queued replies:
//   running/queued → nothing to send: her next look at the page carries the note that the person used the tab;
//   waiting        → she asked something (or needs an OK): answering it is what resumes her;
//   idle           → one message in the chat starts a reply that picks up from the page;
//   quiet          → the viewer was just closed (✕ / Esc): only the note for her next look, no message.
router.post('/threads/:id/browser/done', async (req, res) => {
  const { thread, s } = tabOf(req);
  B.handoverDone(s);
  if (req.body?.quiet) return res.json({ ok: true, next: 'quiet' }); // closed the viewer: no message
  const active = activeRuns(req.user.id).filter(r => r.thread_id === thread.id);
  if (active.some(r => r.status === 'waiting')) return res.json({ ok: true, next: 'answer' });
  if (active.length) return res.json({ ok: true, next: 'running' });
  const { msg, run } = startTurn({ user: req.user, thread, text: HANDBACK_TEXT });
  res.json({ ok: true, next: 'sent', runId: run.id,
    messageHtml: await fragment(res, 'chat/message', userView(msg)),
    runHtml: await fragment(res, 'chat/message', assistantView(getRun(run.id))) });
});

// Signed-in sites (decision #136): the sites the person's browser holds a sign-in for (cookies that look like one), from
// their sealed profile; forgetting one removes its cookies and storage, from the live browser too. The screen is Phase 25.
router.get('/me/browser/sites', (req, res) => res.json({ sites: signedInSites(req.user.id, { all: req.query.all === '1' }) }));
router.delete('/me/browser/sites/:site', async (req, res) => res.json({ ok: true, removed: await B.forgetSite(req.user.id, req.params.site) }));

export default router;
