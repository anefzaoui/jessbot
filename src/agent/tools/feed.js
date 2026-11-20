// The Feed in chat (decision #192): Jess reads the person's own Feed (ranked stories, or a search of them) instead of
// searching the web again, follows a site or feed for them, and mutes a word, a source or a topic. Stories are outside
// content (publishers wrote the titles and summaries): they come back fenced and mark the run as having read outside
// content. Following a site reaches the internet on their behalf (finding its feed), so it sits with the web tools.
import { registerTool } from './registry.js';
import * as feed from '../../services/feed.js';
import * as src from '../../services/feed-sources.js';
import { guardOutside } from '../injection.js';
import { oneLine } from '../../lib/untrusted.js';

const topicList = user => feed.prefsOf(user).topics.map(t => t.label);

registerTool({
  name: 'feed_stories', toolset: 'core', risk: 'read', activity: 'reading', iconName: 'newspaper',
  description: 'Read the person\'s own Feed (the news topics and sources they follow, ranked by what they read): "what\'s new in my '
    + 'feed?", a morning brief, "anything about the strike?" (query searches every story of their sources). Use it before searching '
    + 'the web for news on their topics. Each story has the source, why it is in their feed, the publisher\'s link and a link to it on '
    + 'their Feed; mention the source and link what you cite.',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      topic: { type: 'string', description: 'One of their Feed topics (name), to read only that one.' },
      query: { type: 'string', description: 'Words to search their stories for, instead of the ranked feed.' },
      hours: { type: 'integer', description: 'How far back, in hours (default 24; a search looks back 7 days unless set; at most 336).' },
      limit: { type: 'integer', description: 'How many stories (default 8, at most 20).' },
    },
  },
  label: args => (args.query ? `Searched your feed for “${String(args.query).slice(0, 40)}”` : `Read your feed${args.topic ? `: ${String(args.topic).slice(0, 30)}` : ''}`),
  target: args => String(args.query || args.topic || '').slice(0, 40),
  run: async (args, ctx) => {
    const topics = topicList(ctx.user);
    if (!topics.length) return 'Their Feed isn’t set up yet (no topics). They can tell you what they care about, and the Feed page’s Tune sets it up.';
    const stories = feed.storiesFor(ctx.user, { topic: args.topic || null, query: args.query || '', hours: args.hours, limit: args.limit });
    const scope = `${args.query ? `matching “${oneLine(args.query, 80)}”` : 'ranked for them'}${args.topic ? ` in ${oneLine(args.topic, 40)}` : ''}`;
    if (!stories.length) return `No stories ${scope} in that time. Their topics: ${topics.join(', ')}.`;
    const lines = stories.map((s, i) => [
      `${i + 1}. ${oneLine(s.title, 200)}`,
      `   Source: ${oneLine(s.source, 80)}${s.topic ? ` · Topic: ${oneLine(s.topic, 40)}` : ''}${s.publishedAt ? ` · ${s.publishedAt.slice(0, 16).replace('T', ' ')} UTC` : ''}`,
      s.why ? `   Why it's in their feed: ${oneLine(s.why, 120)}` : null,
      s.summary ? `   ${oneLine(s.summary, 260)}` : null,
      `   Link: ${s.url || '(none)'} · On their Feed: ${s.feedUrl}`,
    ].filter(Boolean).join('\n'));
    const g = await guardOutside(ctx, { tool: 'feed_stories', kind: 'feed_stories', attrs: { scope }, label: 'stories from their Feed',
      body: lines.join('\n') });
    return { content: `${stories.length} ${stories.length === 1 ? 'story' : 'stories'} ${scope} (their topics: ${topics.join(', ')}):\n${g.content}`,
      step: { detail: `${stories.length} ${stories.length === 1 ? 'story' : 'stories'}`, href: '/feed' } };
  },
});

registerTool({
  name: 'feed_follow', toolset: 'web', risk: 'write', activity: 'editing', iconName: 'rss', persistent: true,
  undo: { possible: true, note: 'they can remove it on Your sources' },
  description: 'Add a site, blog or feed link to the person\'s Feed ("add this blog to my feed", "follow The Verge"), under one of '
    + 'their topics or a new one. Finds the site\'s feed (or follows the site through Google News when it has none) and fetches it '
    + 'once, like the Sources page. topic: one of their topics, or a new name to create it.',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      url: { type: 'string', description: 'A feed or page address (https://…).' },
      site: { type: 'string', description: 'A site name as a domain ("theverge.com"), when there is no link.' },
      topic: { type: 'string', description: 'Which of their Feed topics (name) it belongs to, or a new topic name.' },
    },
  },
  label: args => `Followed ${String(args.site || args.url || 'a site').slice(0, 50)} in the Feed`,
  target: args => String(args.site || args.url || '').slice(0, 60),
  run: async (args, ctx) => {
    const input = String(args.url || args.site || '').trim();
    if (!input) throw new Error('Give the site (a domain) or the feed / page link to follow.');
    const topics = feed.prefsOf(ctx.user).topics;
    let t = args.topic ? src.findTopic(ctx.user, args.topic) : topics.length === 1 ? topics[0] : null;
    let created = false;
    if (!t && args.topic) { t = src.createTopic(ctx.user, { label: String(args.topic).trim().slice(0, 30) }); created = true; }
    if (!t) {
      throw new Error(topics.length ? `Which topic should it go under? Their topics: ${topics.map(x => x.label).join(', ')} (or give a new topic name).`
        : 'Their Feed has no topics yet: give a topic name for it (it will be created).');
    }
    const out = await src.addSource(ctx.user, t.key, input, { signal: ctx.signal });
    const s = out.source;
    const how = out.already ? `was already in ${out.topic.label}; it is marked as theirs now`
      : out.how === 'feed' ? `added to ${out.topic.label}${s.state === 'failing' ? ', but it did not answer yet (it will be retried)' : out.added ? ` with ${out.added} recent ${out.added === 1 ? 'story' : 'stories'}` : ''}`
        : `has no feed, so it is followed through Google News in ${out.topic.label}`;
    return { content: `${s.title} ${how}.${created ? ` (New topic “${out.topic.label}”.)` : ''} They can review it on Your sources (/feed/sources).`,
      step: { detail: `${s.title} · ${out.topic.label}`, href: '/feed/sources' } };
  },
});

registerTool({
  name: 'feed_mute', toolset: 'core', risk: 'write', activity: 'editing', iconName: 'eye-off', persistent: true,
  undo: { possible: true, note: 'undo=true unmutes it' },
  description: 'Hide stories from the person\'s Feed: a word or short phrase ("football", "ترامب"; whole words in the title or summary, '
    + 'any language), a source (publisher name or domain), or one of their topics. Give exactly one. undo=true shows them again.',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      word: { type: 'string', description: 'A word or short phrase (up to 5 words).' },
      source: { type: 'string', description: 'A publisher name or domain as the Feed shows it.' },
      topic: { type: 'string', description: 'One of their Feed topics (name).' },
      undo: { type: 'boolean', description: 'Unmute it instead.' },
    },
  },
  label: args => `${args.undo ? 'Unmuted' : 'Muted'} “${String(args.word || args.source || args.topic || '').slice(0, 40)}” in the Feed`,
  target: args => String(args.word || args.source || args.topic || '').slice(0, 40),
  run: (args, ctx) => {
    const given = ['word', 'source', 'topic'].filter(k => String(args[k] ?? '').trim());
    if (given.length !== 1) throw new Error('Give exactly one of word, source or topic.');
    const kind = given[0];
    let value = String(args[kind]).trim();
    if (kind === 'topic') {
      const t = src.findTopic(ctx.user, value);
      if (!t) throw new Error(`There is no Feed topic “${value}”. Their topics: ${topicList(ctx.user).join(', ') || 'none yet'}.`);
      value = t.label;
    }
    const out = feed.setMute(ctx.user, kind, value, { undo: !!args.undo });
    const what = kind === 'word' ? `stories with the word “${out.value}”` : kind === 'source' ? `stories from ${out.value}` : `the topic ${out.value}`;
    return args.undo ? `Unmuted: ${what} can show in their Feed again.` : `Muted: ${what} won't show in their Feed (they can undo it).`;
  },
});
