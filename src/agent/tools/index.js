// Built-in tools (Phase 3). Later phases add web (P5), library (P6), schedule/alarms/weather/feed (P7),
// goals/ideas (P8), email/calendar/files (P10), office/PDF (P11) — each in its own module, registered here.
import { registerTool } from './registry.js';
import { createQuestion } from '../../services/questions.js';
import { addFactChecked, supersedeFact, forgetFact, recallHybrid, recallEpisodesHybrid, factLine, episodeLine, dateText }
  from '../../services/memory.js';
import { searchHistory, dayDigest, readOffloaded, getMessage } from '../../services/messages.js';
import { tzOf } from '../../lib/when.js';
import { NOTICE } from '../../lib/untrusted.js';
import { isOffRecord, asksToRemember } from '../../services/threads.js';
import * as browser from '../../browser/session.js';
import { saveShot } from '../../browser/read.js';
import './web.js';
import './browse.js';
import './library.js';
import './schedule.js';
import './weather.js';
import './goals.js';
import './email.js';
import './calendar.js';
import './office.js';
import './skills.js';
import './projects.js';
import './voice.js';
import './delegate.js'; // delegate + leave_note (decisions #197, #200)
import './lists.js';
import './household.js';
import './image.js';
import './lessons.js';
import './feed.js';
import { botName } from '../../services/bot.js';

// ---- ask_user ------------------------------------------------------------------------------------
registerTool({
  name: 'ask_user', toolset: 'core', risk: 'read', activity: 'waiting',
  description: 'Ask the person 1–4 structured questions shown as buttons (single choice, multiple choice, yes/no, or short text). '
    + 'Use when a choice or detail only they can give would change what you do; facts you can look up (memory, recall, '
    + 'search_history, calendar, the Library, the web) are yours to find first. One call is one round: only questions that don’t '
    + 'depend on each other’s answers; a follow-up waits for the next round. Put your recommended option first and mark it '
    + 'recommended. Keep headers to 1–2 words. The run pauses until they answer; do everything else first. Ask BEFORE the work a '
    + 'decision changes, never after finishing it. While browsing, when '
    + 'you are stuck or the choice is theirs (which flight/option, a login, a CAPTCHA, anything unclear), set show_screen=true so '
    + 'they see exactly what you see, and say briefly what you tried.',
  parameters: {
    type: 'object', required: ['questions'], additionalProperties: false,
    properties: {
      show_screen: { type: 'boolean', description: 'Attach a screenshot of your open browser tab to the question.' },
      questions: {
        type: 'array', minItems: 1, maxItems: 4,
        items: {
          type: 'object', required: ['header', 'question', 'kind'], additionalProperties: false,
          properties: {
            header: { type: 'string', description: 'Very short label, e.g. "Seats", "Budget".' },
            question: { type: 'string' },
            kind: { type: 'string', enum: ['single', 'multi', 'yesno', 'text', 'longtext'] },
            options: {
              type: 'array', maxItems: 9,
              items: { type: 'object', required: ['label'], additionalProperties: false, properties: {
                label: { type: 'string' }, description: { type: 'string' }, recommended: { type: 'boolean' },
              } },
            },
            allowOther: { type: 'boolean', description: 'Offer a free-text "Other" option (default true for choices).' },
          },
        },
      },
    },
  },
  label: args => `Asked ${args.questions?.length || 1} question${(args.questions?.length || 1) > 1 ? 's' : ''}`,
  run: async (args, ctx) => {
    let image = null;
    const s = args.show_screen && browser.peek(`t${ctx.thread.id}`);
    if (s?.active) {
      try { image = saveShot(ctx.user.id, (await browser.screenshot(s)).buf).href; } catch { /* ask anyway */ }
    }
    const q = createQuestion({ runId: ctx.run.id, threadId: ctx.thread.id, userId: ctx.user.id, toolCallId: ctx.toolCallId, questions: args.questions, image });
    return { pause: true, questionId: q.id };
  },
});

// ---- memory --------------------------------------------------------------------------------------
registerTool({
  name: 'remember', displayName: 'Sharing memories', toolset: 'memory', activity: 'remembering', iconName: 'bookmark-plus', activityKind: 'memory',
  // Sharing with a group is outward (other people will see it) → asks first. Private saves are ordinary writes.
  risk: args => (args?.scope && args.scope !== 'private' && args.action !== 'forget' ? 'external' : 'write'),
  // A memory rides along with every future prompt: after the task read outside content, saving, changing or forgetting one
  // asks first (decision #124).
  persistent: true,
  undo: args => (args.action === 'forget' ? { possible: true, note: 'you can undo it for a minute on the Memory page' }
    : { possible: true, note: 'you can edit or forget it on the Memory page' }),
  reach: args => (args?.scope && args.scope !== 'private' && args.action !== 'forget'
    ? `everyone in the ${String(args.scope).replace(/^(group|shared):/i, '')} group` : 'only you'),
  approvalTitle: args => `Share with ${String(args.scope).replace(/^(group|shared):/i, '')}: “${String(args.text || '').slice(0, 80)}”`,
  approvalPreview: args => `Everyone in the ${String(args.scope).replace(/^(group|shared):/i, '')} group will see this memory:\n\n${args.text}`,
  description: 'Save, update or forget a durable fact about the person or the people they share with. Save short facts '
    + '(≤300 chars): preferences, people, plans, routines, places. Name people with their relation ("Maya (daughter) starts school '
    + 'on 1 Sep"). Only a fact about one particular calendar day gets `date` (an appointment, a trip, a deadline; with yearly=true '
    + 'a birthday or anniversary); dated memories come up by themselves when the day is near. Leave `date` empty for everything '
    + 'else, routines like "every Sunday" included, and never put today’s date on a fact that isn’t about today. importance (when '
    + 'adding): 1 detail (default), 2 matters to them, 3 essential (health, allergies, key people). If the '
    + 'answer lists similar memories already saved and one is now wrong, update it by id (or forget the duplicate). To change a '
    + 'fact, use action "update" with its memory_id — never store contradictions. Use "forget" when asked to. scope: "private" '
    + '(default) or "group:<GroupName>" only when the '
    + 'person clearly wants it shared with that group. Inside a project chat, how they want the work done there (units, format, '
    + 'a correction) goes to project_note instead, not here. Saying you’ll remember something means calling this in the same turn. '
    + 'Refused: passwords, PINs, one-time codes, card numbers and keys (suggest a password manager), and saves in an off-the-record '
    + 'chat unless their message asks you to remember.',
  parameters: {
    type: 'object', required: ['action'], additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['add', 'update', 'forget'] },
      text: { type: 'string' }, memory_id: { type: 'integer' },
      kind: { type: 'string', enum: ['profile', 'preference', 'fact', 'event', 'instruction', 'schedule', 'place'], description: 'Default fact.' },
      scope: { type: 'string', description: '"private" (default) or "group:<name>".' },
      pinned: { type: 'boolean', description: 'Core memory, always in mind (default false). Only for what every chat needs: their name, a severe allergy.' },
      date: { type: 'string', description: 'Only for a fact about one particular calendar day: "YYYY-MM-DD", "YYYY-MM-DDTHH:MM", or '
        + '"MM-DD" for a yearly date whose year is unknown. Empty ("") for anything else.' },
      yearly: { type: 'boolean', description: 'Leave out (false) unless it is a birthday or anniversary with a `date`: the date then comes back every year.' },
      importance: { type: 'integer', minimum: 1, maximum: 3, description: 'When adding: 1 detail · 2 matters to them · 3 essential.' },
    },
  },
  label: args => (args.action === 'forget' ? 'Forgot a memory' : args.action === 'update' ? 'Updated a memory' : 'Saved to memory'),
  target: args => (args.text ? String(args.text).slice(0, 40) : null),
  run: (args, ctx) => {
    if (args.action === 'forget') { forgetFact(ctx.user, args.memory_id, 'agent'); return `Forgotten (memory ${args.memory_id}).`; }
    // Off the record (#123): nothing is saved from this chat unless the message that started this turn asks for it.
    if (isOffRecord(ctx.thread.id) && !asksToRemember(ctx.run.trigger_message_id ? getMessage(ctx.run.trigger_message_id)?.content : '')) {
      return 'Not saved: this chat is off the record, so nothing from it is remembered unless the person asks you to remember '
        + 'something in their own message. Don’t try again. If it seems worth keeping, tell them it wasn’t saved and that they can say '
        + '“remember that” if they want it kept.';
    }
    if (args.action === 'update') {
      // The date changes only when a new one is given; importance carries over (models fill every field, often with 1).
      const f = supersedeFact(ctx.user, args.memory_id, args.text, 'agent', args.date ? { date: args.date, recurs: args.yearly ? 'yearly' : null } : {});
      return `Updated → memory ${f.id}: ${f.text}${f.event_at ? ` (date: ${dateText(f)})` : ''}`;
    }
    // Validation (text, secrets, scope, date) throws here; the near-duplicate check (decision #152) is asynchronous.
    return addFactChecked({ user: ctx.user, text: args.text, kind: args.kind || 'fact', scopeHint: args.scope, pinned: !!args.pinned,
      date: args.date || null, recurs: args.date && args.yearly ? 'yearly' : null, importance: args.importance, sourceThreadId: ctx.thread.id, sourceMessageId: ctx.run.trigger_message_id })
      .then(({ fact: f, duplicate, similar }) => {
        if (duplicate) return `Already in memory as ${f.id}: ${f.text} (not saved twice). If it needs changing, update memory ${f.id}.`;
        return `Saved as memory ${f.id} (${args.scope || 'private'})${f.event_at ? `, dated ${dateText(f)}` : ''}.`
          + (similar.length ? `\nSimilar memories already saved:\n${similar.map(m => `- ${factLine(m)}`).join('\n')}\n`
            + 'If one of them is now wrong, update it by id; if one says the same thing, forget the new one.' : '');
      });
  },
});

registerTool({
  name: 'recall', toolset: 'memory', risk: 'read', activity: 'thinking',
  description: 'Search long-term memory (facts you saved about the person and their shared groups, in any language, by meaning as '
    + 'well as words) and short notes of earlier conversations. Returns memory ids you can update.',
  parameters: { type: 'object', required: ['query'], additionalProperties: false, properties: { query: { type: 'string' } } },
  label: () => 'Checked my memory',
  target: args => args.query,
  run: async (args, ctx) => {
    const rows = await recallHybrid(ctx.user, args.query, 8, { touch: true });
    const eps = await recallEpisodesHybrid(ctx.user, args.query, 3);
    if (!rows.length && !eps.length) return 'Nothing relevant in memory.';
    return [...rows.map(r => `${factLine(r)} (noted ${r.observed_at.slice(0, 10)})`),
      ...(eps.length ? ['Earlier conversations:', ...eps.map(e => `- ${episodeLine(e)}`)] : [])].join('\n');
  },
});

// ---- history -------------------------------------------------------------------------------------
// Dates are the person's local days (decision #155): "last Tuesday" is worked out from "Right now" in the prompt.
registerTool({
  name: 'search_history', toolset: 'core', risk: 'read', activity: 'reading',
  description: "Search this person's past conversations with you (all their chats). With `query`: the best matching messages, each "
    + 'with the message before and after it. With `from`/`to` (their local dates, YYYY-MM-DD; work out "last Tuesday" from Right now) '
    + 'and no query: a day-by-day digest of what was discussed and done. Both: matches within those days only.',
  parameters: { type: 'object', additionalProperties: false, properties: {
    query: { type: 'string' }, from: { type: 'string', description: 'First day (YYYY-MM-DD), their timezone.' },
    to: { type: 'string', description: 'Last day (YYYY-MM-DD), inclusive; defaults to `from`.' },
  } },
  label: () => 'Searched our past chats',
  target: args => args.query || [args.from, args.to].filter(Boolean).join(' to ') || null,
  run: (args, ctx) => {
    const tz = tzOf(ctx.user);
    const query = String(args.query || '').trim();
    if (!query && !args.from && !args.to) return 'Give a query, or the days to look at (from/to as YYYY-MM-DD).';
    if (!query) {
      const { lines } = dayDigest(ctx.user.id, { from: args.from, to: args.to, tz });
      return lines.length ? lines.join('\n') : 'Nothing in our chats on those days.';
    }
    const rows = searchHistory(ctx.user.id, query, { limit: 6, from: args.from, to: args.to, tz, context: true });
    if (!rows.length) return `No matches in past chats${args.from || args.to ? ' on those days' : ''}.`;
    const bot = botName();
    const who = role => (role === 'user' ? 'Them' : bot);
    const local = at => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(`${at.replace(' ', 'T')}Z`));
    return rows.map(r => [`${local(r.created_at)} · “${r.thread_title}” · ${who(r.role)}: ${r.snippet}`,
      r.before ? `  before, ${who(r.before.role)}: ${r.before.text}` : null, r.after ? `  after, ${who(r.after.role)}: ${r.after.text}` : null]
      .filter(Boolean).join('\n')).join('\n\n');
  },
});

registerTool({
  name: 'read_offloaded', toolset: 'core', risk: 'read', activity: 'reading',
  description: 'Read the full text of an earlier tool output that was stored to save space (use the ref shown in its stub).',
  parameters: { type: 'object', required: ['ref'], additionalProperties: false, properties: {
    ref: { type: 'string' }, start: { type: 'integer', minimum: 0 },
  } },
  label: () => 'Reopened a stored result',
  // Only this person's own stored results. A later part of a fenced result has lost its opening tag and notice line, so it
  // gets the notice again (the closing tag, banner and defanged text are still the ones stored).
  run: (args, ctx) => {
    const start = Math.max(0, Number(args.start) || 0);
    const r = readOffloaded(String(args.ref || ''), { start, userId: ctx?.user?.id ?? null });
    if (!r) return 'No stored output with that ref.';
    const head = start > 0 && r.outside ? `(A later part of a stored result that holds outside content. ${NOTICE})\n` : '';
    return `${head}${r.text}${r.text.length + start < r.total ? `\n…(${r.total} chars total — continue with start=${start + r.text.length})` : ''}`;
  },
});
