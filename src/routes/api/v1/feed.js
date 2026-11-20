// The Feed (decisions #34/#54/#63). Tune and Refresh return at once; the work runs in the background and reports through
// `feed.progress` / `feed.updated` frames (and GET /feed's `status`), so a refresh loses nothing. Cards are stories
// ("i<itemId>") or older posts (public ids); every action also teaches the ranking (feed_events → feed_interests).
import { Router } from 'express';
import * as feed from '../../../services/feed.js';
import { recordEvent, setFollow, readingDiet } from '../../../services/feed-rank.js';
import { tune, refresh, isRunning, ensureArticle, takeFor } from '../../../agent/feed.js';
import { renderFragment } from '../../../views/render.js';
import * as src from '../../../services/feed-sources.js';
import { hit } from '../../../lib/ratelimit.js';
import { invalid, badRequest, tooMany } from '../../../lib/errors.js';

const router = Router();
const quietly = p => p.catch(err => console.warn('[feed]', err.message)); // the error is already on the page's status line

// Learn from an action on a card (its story and topic), without failing the action itself.
function learn(user, post, kind, value = 0) {
  const item = feed.itemOf(post);
  if (item) try { recordEvent(user.id, item, kind, { topic: post.topic, value }); } catch (err) { console.warn('[feed] learn', err.message); }
}

router.get('/feed', (req, res) => res.json(feed.feedData(req.user, feed.feedFilters(req.query))));

// More cards (infinite scroll / "Show more"), same filters as the page: rendered cards + what to ask for next
// (a page number for ranked/search, a cursor for history).
router.get('/feed/page', async (req, res) => {
  const page = feed.feedPage(req.user, feed.feedFilters(req.query));
  res.json({ html: await renderFragment('feed/sections', { sections: page.sections }, req.user), next: page.next, count: page.count, mode: page.mode });
});

// What the page saw and did (cards seen, opened, reading time) — batched by the client.
router.post('/feed/events', (req, res) => {
  const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 100) : [];
  let recorded = 0;
  for (const e of events) {
    if (!['impression', 'open', 'read', 'bounce', 'share'].includes(e?.kind)) continue;
    const m = /^i(\d+)$/.exec(String(e.id));
    let item = m ? feed.itemById(Number(m[1])) : null;
    if (!item && !m) { try { item = feed.itemOf(feed.postForUser(req.user, e.id)); } catch { /* gone */ } }
    if (!item) continue;
    recordEvent(req.user.id, item, e.kind, { topic: feed.topicOfItem(req.user, item), value: Math.min(3600, Number(e.value) || 0) });
    recorded++;
  }
  res.json({ ok: true, recorded });
});

// Reader mode: the story's article (read now if it never was). Waits up to a minute on a first read.
router.get('/feed/posts/:id/article', async (req, res) => {
  const post = await ensureArticle(req.user, feed.postForCard(req.user, req.params.id));
  res.json(feed.articleView(post));
});

// Jess's take on a card that wasn't written yet (the person opened it): { html, title, summary }.
router.post('/feed/posts/:id/take', async (req, res) => {
  const post = await takeFor(req.user, feed.postForCard(req.user, req.params.id));
  const v = feed.postView(post, 'compact');
  res.json({ html: v.html, title: v.title, summary: v.summary, written: v.written });
});

router.post('/feed/prompt', (req, res) => {
  const prompt = String(req.body?.prompt ?? '').trim();
  if (prompt.length > 2000) throw invalid({ prompt: 'That’s a bit long — keep it under 2,000 characters.' });
  quietly(tune(req.user, prompt));
  res.status(202).json({ ok: true, state: 'working' });
});

router.post('/feed/refresh', (req, res) => {
  if (!feed.prefsOf(req.user).topics.length) throw badRequest('Tell me what you care about first — tap Tune.');
  if (!isRunning(req.user.id)) quietly(refresh(req.user));
  res.status(202).json({ ok: true, state: 'working' });
});

router.post('/feed/posts/:id/feedback', (req, res) => {
  const post = feed.postForCard(req.user, req.params.id);
  const v = req.body?.feedback ?? null;
  feed.setFeedback(post, v);
  if (v === 'up') learn(req.user, post, 'like');
  if (v === 'down') learn(req.user, post, 'less');
  res.json({ ok: true });
});

router.post('/feed/posts/:id/save', (req, res) => {
  const post = feed.postForCard(req.user, req.params.id);
  feed.setSaved(post, !!req.body?.saved);
  if (req.body?.saved) learn(req.user, post, 'save');
  res.json({ ok: true });
});

router.post('/feed/posts/:id/hide', (req, res) => {
  const what = req.body?.what;
  if (!['topic', 'source'].includes(what)) throw invalid({ what: 'Hide a topic or a source.' });
  const post = feed.postForCard(req.user, req.params.id);
  feed.mute(req.user, post, what, !!req.body?.undo);
  if (!req.body?.undo) learn(req.user, post, 'hide');
  res.json({ ok: true });
});

// ---- Sources: see, add, remove, pause (decision #89). Each change answers with the topic's re-rendered card. -----------
const topicCard = async (req, topic) => ({ topic, html: await renderFragment('feed/topic-sources', { topic }, req.user) });
function slowDown(req, what, limit) {
  const l = hit(`feed-${what}:${req.user.id}`, { limit, windowMs: 10 * 60e3 });
  if (!l.allowed) throw tooMany(`That's a lot of checking — try again in ${Math.ceil(l.retryInMs / 60e3)} min.`);
}

// ?fragment=1 (after an OPML import, Phase 25 #204): plus `html`, the page's topic list, and `counts` for its summary.
router.get('/feed/sources', async (req, res) => {
  if (req.query.fragment !== '1') return res.json({ topics: src.topicsWithSources(req.user), limits: { topics: src.MAX_TOPICS, sourcesPerTopic: src.MAX_SOURCES_PER_TOPIC } });
  const page = src.sourcesPage(req.user);
  res.json({ topics: page.topics, limits: page.limits, counts: page.counts, html: await renderFragment('feed/topic-list', { topics: page.topics }, req.user) });
});

router.post('/feed/topics', async (req, res) => res.status(201).json(await topicCard(req, src.createTopic(req.user, req.body))));
router.post('/feed/topics/:key/edit', async (req, res) => res.json(await topicCard(req, src.editTopic(req.user, req.params.key, req.body))));
router.post('/feed/topics/:key/pause', async (req, res) => res.json(await topicCard(req, src.pauseTopic(req.user, req.params.key, req.body?.paused !== false))));
router.delete('/feed/topics/:key', (req, res) => res.json({ ok: true, ...src.deleteTopic(req.user, req.params.key) }));

// Adding reads the site (finding its feed can take up to a minute) and fetches it once, so the person sees it work.
router.post('/feed/topics/:key/sources', async (req, res) => {
  slowDown(req, 'add', 20);
  const out = await src.addSource(req.user, req.params.key, req.body?.url, { signal: AbortSignal.timeout(90000) });
  const s = out.source;
  const message = out.already ? `You already had ${s.title} here — it’s marked as yours now.`
    : out.how === 'feed' ? `Added ${s.title}${s.state === 'failing' ? ', but it didn’t answer yet — I’ll keep trying.' : out.added ? ` · ${out.added} recent ${out.added === 1 ? 'story' : 'stories'}.` : '.'}`
      : `${s.host} has no feed I could find, so I’ll follow it through Google News.`;
  res.status(out.already ? 200 : 201).json({ ...(await topicCard(req, out.topic)), source: s, how: out.how, added: out.added, message });
});
router.delete('/feed/topics/:key/sources/:id', async (req, res) => {
  const out = src.removeSource(req.user, req.params.key, req.params.id);
  res.json({ ...(await topicCard(req, out.topic)), message: `Removed ${out.title || 'that source'} — re-tuning won’t bring it back.` });
});
router.post('/feed/sources/:id/check', async (req, res) => {
  slowDown(req, 'check', 30);
  const topicKey = String(req.body?.topic || '');
  const out = await src.checkSource(req.user, req.params.id, topicKey, { signal: AbortSignal.timeout(60000) });
  res.json({ source: out.source, added: out.added, html: await renderFragment('feed/source-row', { source: out.source, topicKey }, req.user) });
});

// ---- OPML, muted words, the reading diet, stories for the app (decisions #192, #193) ------------------------------------------
// Import a feed reader's OPML list: { opml: "<opml …>", topic?: "a topic name" } → { added, skipped, topics, message }.
router.post('/feed/opml', async (req, res) => {
  slowDown(req, 'opml', 10);
  const text = String(req.body?.opml ?? '');
  if (!text.trim()) throw invalid({ opml: 'Choose the .opml file your feed reader exported.' });
  if (text.length > 900_000) throw invalid({ opml: 'That file is too big for a feed list.' });
  const out = src.importOpml(req.user, text, { topic: req.body?.topic ? String(req.body.topic) : null });
  const message = out.added.length
    ? `Added ${out.added.length} ${out.added.length === 1 ? 'feed' : 'feeds'}${out.skipped.length ? `, skipped ${out.skipped.length}` : ''}. New stories arrive with the next check.`
    : `Nothing new to add: ${out.skipped.length} ${out.skipped.length === 1 ? 'feed was' : 'feeds were'} skipped.`;
  // ?fragment=1 (the Sources page, Phase 25 #204): plus `html`, the summary card (what was added where, what was skipped and why).
  const html = req.query.fragment === '1' ? await renderFragment('feed/opml-result', { result: opmlResult(out, message) }, req.user) : undefined;
  res.status(out.added.length ? 201 : 200).json({ ...out, message, ...(html ? { html } : {}) });
});

// The import's summary for partials/feed/opml-result.hbs: skipped feeds grouped by why, in words.
const SKIP_WHY = {
  already: () => 'You already follow these there',
  duplicate: () => 'Listed twice in the file',
  invalid: () => 'Not a web address',
  full: () => `That topic already has ${src.MAX_SOURCES_PER_TOPIC} feeds, the most one topic holds`,
  topics: () => `No room for another topic (${src.MAX_TOPICS} at most)`,
  too_many: () => `Past the ${src.MAX_OPML_FEEDS} feeds one file can bring`,
};
function opmlResult(out, message) {
  const byTopic = new Map();
  for (const a of out.added) byTopic.set(a.topic, (byTopic.get(a.topic) || 0) + 1);
  const groups = Object.keys(SKIP_WHY).map(reason => ({ reason, label: SKIP_WHY[reason](), items: out.skipped.filter(x => x.reason === reason) }))
    .filter(g => g.items.length);
  return { ...out, message, groups, topics: out.topics.map(t => ({ ...t, added: byTopic.get(t.label) || 0 })) };
}
router.get('/feed/opml', (req, res) => {
  res.type('text/x-opml; charset=utf-8').attachment('jessbot-feeds.opml').send(src.exportOpml(req.user));
});

// Mutes by kind (topic | source | word): list, add, remove. Adding or removing re-hides exactly what the mutes cover.
// ?fragment=1 (the Sources page, Phase 25 #204): plus `html`, its muted-words card rendered from partials/feed/mutes.hbs.
const mutesHtml = async (req, mutes) => (req.query.fragment === '1' ? { html: await renderFragment('feed/mutes', { mutes }, req.user) } : {});
router.get('/feed/mutes', async (req, res) => { const mutes = feed.mutesList(req.user); res.json({ ...mutes, ...(await mutesHtml(req, mutes)) }); });
router.post('/feed/mutes', async (req, res) => {
  const out = feed.setMute(req.user, String(req.body?.kind || ''), req.body?.value);
  const mutes = feed.mutesList(req.user);
  res.status(201).json({ ...out, mutes, ...(await mutesHtml(req, mutes)) });
});
router.delete('/feed/mutes', async (req, res) => {
  const out = feed.setMute(req.user, String(req.body?.kind || ''), req.body?.value, { undo: true });
  const mutes = feed.mutesList(req.user);
  res.json({ ...out, mutes, ...(await mutesHtml(req, mutes)) });
});

// Your reading diet: what you read over the last `days` (default 30), how varied, and one suggestion.
router.get('/feed/diet', (req, res) => res.json({ diet: readingDiet(req.user, { days: req.query.days }) }));

// The same stories Jess sees with feed_stories: ?topic=&q=&hours=&limit=.
router.get('/feed/stories', (req, res) => res.json({ stories: feed.storiesFor(req.user, {
  topic: req.query.topic ? String(req.query.topic) : null, query: req.query.q ? String(req.query.q).slice(0, 120) : '',
  hours: req.query.hours, limit: req.query.limit }) }));

// Follow / unfollow a topic from any card or chip.
router.post('/feed/topics/follow', (req, res) => {
  const topic = String(req.body?.topic || '').trim().slice(0, 60);
  if (!topic) throw invalid({ topic: 'Which topic?' });
  setFollow(req.user.id, topic, req.body?.on !== false);
  res.json({ ok: true, topic, following: req.body?.on !== false });
});

export default router;
