// Household tools (Phase 22 part B): fair draws (decision #141) and public holidays (#141). Both are core: they read
// nothing private and spend nothing. A Secret Santa among household members is revealed privately: each person's match is
// posted only in THEIR OWN main chat (a note from Jess, no model call), and the organiser is told only that it's done.
import { registerTool } from './registry.js';
import { all } from '../../db/index.js';
import * as D from '../../services/draws.js';
import * as H from '../../services/holidays.js';
import { primaryPlace } from '../../services/places.js';
import { logActivity } from '../../services/activity.js';
import { notify } from '../../services/notify.js';
import { postNote } from '../proactive.js';
import { tzOf } from '../../lib/when.js';
import { getUser } from '../../services/users.js';
import { fold } from '../../services/lists.js';

// ---- pick_random -------------------------------------------------------------------------------------------------------
/** People who share a group with the organiser (and the organiser): the only ones a private reveal can reach. */
export function householdOf(user) {
  return all(`SELECT DISTINCT u.id, u.name, u.call_me FROM users u
    WHERE u.status = 'active' AND (u.id = ? OR u.id IN (SELECT m.user_id FROM group_members m WHERE m.group_id IN
      (SELECT group_id FROM group_members WHERE user_id = ?)))`, user.id, user.id);
}

/** Participant names → household accounts. → { found: Map(name → user row), missing: [name], ambiguous: [name] }. */
export function matchHousehold(user, names) {
  const people = householdOf(user);
  const found = new Map(); const missing = []; const ambiguous = [];
  for (const name of names) {
    const n = fold(name);
    if (['me', 'myself', 'moi', 'انا'].includes(n)) { found.set(name, people.find(p => p.id === user.id)); continue; }
    const hits = people.filter(p => [p.name, p.name.split(/\s+/)[0], p.call_me].filter(Boolean).some(x => fold(x) === n));
    if (hits.length === 1) found.set(name, hits[0]);
    else (hits.length ? ambiguous : missing).push(name);
  }
  const ids = [...found.values()].map(p => p.id);
  const twice = [...found.keys()].filter((k, i) => ids.indexOf(ids[i]) !== i);
  return { found, missing, ambiguous: [...ambiguous, ...twice] };
}

const firstName = p => p.call_me || p.name.split(/\s+/)[0];

/** Secret Santa, private reveal: draw, then post each giver's match in their own main chat. Nothing is returned or stored. */
export async function privateSecretSanta(organiser, people, { avoidPairs = [], note = null, runId = null, rng } = {}) {
  const who = matchHousehold(organiser, people);
  if (who.ambiguous.length) return { error: `More than one person (or the same person twice) matches ${who.ambiguous.map(n => `“${n}”`).join(', ')} — use full names, each person once.` };
  if (who.missing.length) {
    return { error: `${who.missing.map(n => `“${n}”`).join(', ')} ${who.missing.length === 1 ? 'isn’t' : 'aren’t'} in ${firstName(organiser)}’s household on Jessbot, `
      + 'so I can’t tell them their match privately. Ask whether to leave them out, or to draw with reveal "organiser" (then the organiser sees '
      + 'every match and hands them out).' };
  }
  const matches = D.secretSanta(people, { avoidPairs, rng });
  const draw = D.recordDraw(organiser, { runId, mode: 'secret_santa', input: { people, avoidPairs, note, reveal: 'private' }, result: null });
  const day = draw.at.slice(0, 10);
  for (const { giver, receiver } of matches) {
    const g = who.found.get(giver); const r = who.found.get(receiver);
    await postNote(getUser(g.id), {
      threadId: null, origin: 'draw', originLabel: 'Secret Santa',
      system: `[Secret Santa draw ${draw.id} run by ${organiser.name}: this person's own match, sent only to them. Nobody else, the organiser included, `
        + 'was told. Keep it secret from everyone else.]',
      text: `**Secret Santa:** you're giving to **${r.name}**.${note ? ` ${String(note).slice(0, 200)}` : ''}\n\n`
        + `Only you can see this. ${firstName(organiser)} ran the draw on ${day} (draw ${draw.id}) and wasn't told who has whom.`,
    });
    notify(g.id, { kind: 'message', title: 'Secret Santa', body: 'Your match is in your chat (only you can see it).', href: '/chat', tag: `draw-${draw.id}` });
  }
  return { draw, count: matches.length };
}

const METHOD = 'crypto.randomInt: every outcome equally likely';
const list = xs => xs.map((x, i) => `${i + 1}. ${x}`).join('\n');

registerTool({
  name: 'pick_random', displayName: 'Fair draws', toolset: 'core', iconName: 'gamepad-2', activity: 'choosing',
  risk: args => (args.mode === 'secret_santa' && args.reveal !== 'organiser' ? 'write' : 'read'), // it posts in others' chats
  description: 'A fair, truly random draw — never pick "at random" yourself. Use whenever someone asks you to choose at random, draw names, '
    + 'pick a winner, decide who goes first, shuffle an order, split people into teams or pairs, roll dice, or run a Secret Santa. '
    + 'Modes: pick (count items, optional weights, never the same item twice), shuffle (an order), teams (teams: how many), pairs, '
    + 'dice (dice: "2d6+1", "d20"), secret_santa (nobody gets themselves; avoid_pairs keeps couples apart, both ways). '
    + 'Secret Santa among people in their household: each person gets their own match privately in their own chat, and you and the '
    + 'organiser are NOT told any match — never guess or reveal one. If someone taking part has no Jessbot account, ask whether to leave '
    + 'them out or use reveal "organiser" (then the organiser sees every match). Every draw has an id and a time: give them so it can be checked.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['mode'],
    properties: {
      mode: { type: 'string', enum: D.MODES },
      items: { type: 'array', items: { type: 'string' }, maxItems: D.MAX_ITEMS, description: 'What to draw from: names, options, chores… (not for dice).' },
      count: { type: 'integer', minimum: 1, description: 'pick: how many to draw (default 1).' },
      weights: { type: 'array', items: { type: 'number' }, description: 'pick: one weight per item, same order (2 = twice as likely as 1).' },
      exclude: { type: 'array', items: { type: 'string' }, description: 'Items to leave out this time (e.g. whoever did it last week).' },
      teams: { type: 'integer', minimum: 2, description: 'teams: how many teams.' },
      dice: { type: 'string', description: 'dice: notation such as "d6", "2d6+1", "1d20+1d4".' },
      avoid_pairs: { type: 'array', items: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 },
        description: 'teams / pairs / secret_santa: pairs of names to keep apart, e.g. [["Sam", "Priya"]].' },
      reveal: { type: 'string', enum: ['private', 'organiser'], description: 'secret_santa: private (default; each person sees only their own match) or organiser.' },
      note: { type: 'string', description: 'secret_santa: one line for everyone, e.g. "Budget 20 EUR, swap on 24 Dec".' },
    },
  },
  label: args => (args.mode === 'dice' ? `Rolled ${String(args.dice || 'dice').slice(0, 20)}` : args.mode === 'secret_santa' ? 'Drew Secret Santa names'
    : args.mode === 'teams' ? 'Split into teams' : args.mode === 'pairs' ? 'Made pairs' : args.mode === 'shuffle' ? 'Shuffled the order' : 'Drew at random'),
  target: args => (args.mode === 'dice' ? null : `${(args.items || []).length} ${args.mode === 'secret_santa' ? 'people' : 'items'}`),
  run: async (args, ctx) => {
    const mode = D.MODES.includes(args.mode) ? args.mode : 'pick';
    const runId = ctx.run?.id ?? null;
    const done = (draw, text, detail) => {
      logActivity(ctx.user.id, { kind: 'task', icon: 'gamepad-2', title: `Fair draw (${mode.replace('_', ' ')}): ${detail}`.slice(0, 160),
        detail: `Draw ${draw.id} · ${draw.at}`, runId, href: ctx.thread ? `/chat/${ctx.thread.id}` : null });
      return { content: `${text}\n\nDraw ${draw.id} at ${draw.at} (${METHOD}${args.weights && mode === 'pick' ? ', weighted as given' : ''}).`, step: { detail } };
    };
    if (mode === 'dice') {
      const r = D.rollDice(args.dice);
      const draw = D.recordDraw(ctx.user, { runId, mode, input: { dice: args.dice }, result: r });
      const parts = r.rolls.map(x => `${x.term}: ${x.values.join(' + ')}`).join('; ');
      return done(draw, `Rolled ${r.expr}: ${parts}${r.modifier ? `; ${r.modifier > 0 ? '+' : ''}${r.modifier}` : ''} → **${r.total}**`, `${r.expr} = ${r.total}`);
    }
    const items = D.withoutExcluded(D.cleanItems(args.items, { unique: mode !== 'pick', min: mode === 'pick' ? 1 : 2 }), args.exclude);
    if (!items.length) return 'Everything was excluded — nothing left to draw from.';
    const input = { items, ...(args.exclude?.length && { exclude: args.exclude }), ...(args.weights && { weights: args.weights }),
      ...(args.count && { count: args.count }), ...(args.teams && { teams: args.teams }), ...(args.avoid_pairs?.length && { avoidPairs: args.avoid_pairs }) };
    if (mode === 'pick') {
      // Weights follow the items as given; excluded items drop out with their weights.
      const weights = args.weights ? D.cleanItems(args.items).map((x, i) => [x, args.weights[i]]).filter(([x]) => items.includes(x)).map(([, w]) => w) : null;
      const out = D.pick(items, { count: args.count || 1, weights });
      const draw = D.recordDraw(ctx.user, { runId, mode, input, result: out });
      return done(draw, `Drew ${out.length} of ${items.length}:\n${list(out)}`, out.join(', ').slice(0, 80));
    }
    if (mode === 'shuffle') {
      const out = D.shuffle(items);
      const draw = D.recordDraw(ctx.user, { runId, mode, input, result: out });
      return done(draw, `Random order:\n${list(out)}`, `${out.length} in order`);
    }
    if (mode === 'teams') {
      const out = D.teams(items, args.teams || 2, { avoidPairs: args.avoid_pairs });
      const draw = D.recordDraw(ctx.user, { runId, mode, input, result: out });
      return done(draw, out.map((t, i) => `Team ${i + 1}: ${t.join(', ')}`).join('\n'), `${out.length} teams`);
    }
    if (mode === 'pairs') {
      const out = D.pairs(items, { avoidPairs: args.avoid_pairs });
      const draw = D.recordDraw(ctx.user, { runId, mode, input, result: out });
      return done(draw, out.map(p => `- ${p.join(' & ')}`).join('\n'), `${out.length} pairs`);
    }
    // secret_santa
    if (args.reveal === 'organiser') {
      const out = D.secretSanta(items, { avoidPairs: args.avoid_pairs });
      const draw = D.recordDraw(ctx.user, { runId, mode, input: { ...input, reveal: 'organiser', note: args.note || null }, result: out });
      return done(draw, `Secret Santa (shown to the organiser, as asked):\n${out.map(m => `- ${m.giver} → ${m.receiver}`).join('\n')}`, `${out.length} people, shown to the organiser`);
    }
    const r = await privateSecretSanta(ctx.user, items, { avoidPairs: args.avoid_pairs, note: args.note, runId });
    if (r.error) return { content: r.error, step: { detail: 'Not drawn', status: 'bad' } };
    return {
      content: `Done: Secret Santa drawn for ${r.count} people (draw ${r.draw.id} at ${r.draw.at}, ${METHOD}). Each person got their own match `
        + 'privately in their own main chat (the organiser too, if taking part: only their own). Nobody was told anyone else\'s match and '
        + 'the matches are not stored anywhere: say it is done, and never guess, hint at or reveal who has whom.',
      step: { detail: `${r.count} people, each told privately` },
    };
  },
});

// ---- get_holidays ------------------------------------------------------------------------------------------------------
const today = tz => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const plusDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

registerTool({
  name: 'get_holidays', displayName: 'Public holidays', toolset: 'core', risk: 'read', iconName: 'calendar-days', activity: 'planning',
  description: 'Public (and bank) holidays for a country, offline and exact: "is Monday a holiday?", "holidays this year", "next long '
    + 'weekend". Country defaults to where the person lives; region for regional holidays (e.g. a German state, a US state). Islamic '
    + 'holidays are marked when their date follows the moon sighting.',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      country: { type: 'string', description: 'Country name or two-letter code; omit for where they live.' },
      region: { type: 'string', description: 'Optional state/region name or code.' },
      date: { type: 'string', description: 'YYYY-MM-DD: is this date a holiday?' },
      year: { type: 'integer', description: 'A whole year.' },
      from: { type: 'string', description: 'YYYY-MM-DD (default today).' },
      to: { type: 'string', description: 'YYYY-MM-DD (default a year after from).' },
      all: { type: 'boolean', description: 'Also school, optional and observance days (default: public and bank holidays only).' },
    },
  },
  label: args => (args.date ? `Checked if ${String(args.date).slice(0, 10)} is a holiday` : 'Looked up public holidays'),
  target: args => args.country || null,
  run: async (args, ctx) => {
    const home = primaryPlace(ctx.user);
    const country = args.country || home?.country_code;
    if (!country) return 'I don’t know which country they live in — ask (or save their home with set_location), then look again.';
    const timezone = (!args.country && home?.timezone) || tzOf(ctx.user);
    const base = { country, region: args.region || null, timezone, all: !!args.all };
    if (args.date) {
      const r = H.holidaysOn({ ...base, date: String(args.date).slice(0, 10) });
      return { content: H.holidaysText(r, { asked: r.date }), step: { detail: r.holidays.length ? r.holidays[0].name : 'Not a holiday' } };
    }
    const from = args.year ? `${args.year}-01-01` : (args.from || today(timezone));
    const to = args.year ? `${args.year}-12-31` : (args.to || plusDays(from, 365));
    const r = H.holidaysBetween({ ...base, from, to });
    return { content: H.holidaysText(r), step: { detail: `${r.holidays.length} in ${r.countryName}` } };
  },
});
