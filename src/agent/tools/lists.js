// Family lists (decision #139): shopping, to-dos, wish and packing lists that the family shares, changed one item at a time
// (services/lists.js). Toolset `lists`, on for everyone like schedules: it only touches the person's own lists and their
// groups' lists, and every change can be undone by a tap or a word. The scope is decided on the server, never by the model.
import { registerTool } from './registry.js';
import * as L from '../../services/lists.js';
import { tzOf, localLabel } from '../../lib/when.js';

const where = v => (v.shared ? `shared with ${v.scope}` : 'private');
const head = v => `“${v.title}” (${v.kind}, ${where(v)}${v.kind === 'wish' && v.wisher ? `, ${v.wisher}'s wishes` : ''}) — ${v.open} open, ${v.done} done`;

function itemLine(i, tz) {
  const bits = [`[#${i.id}] ${i.text}${i.qty ? ` (${i.qty})` : ''}`];
  if (i.assignee) bits.push(`for ${i.assignee}`);
  if (i.dueAt) bits.push(`due ${localLabel(i.dueAt, tz)}`);
  if (i.bought) bits.push(`bought by ${i.doneBy} (hidden from the wisher)`);
  else if (i.done) bits.push(`done${i.doneBy ? ` by ${i.doneBy}` : ''}`);
  return `- ${bits.join(' · ')}`;
}

/** A list as text: open items (grouped by aisle for shopping), then the done ones (only when asked, or a count). */
export function listText(shown, { tz, includeDone = false } = {}) {
  const { list: v, items } = shown;
  const open = items.filter(i => !i.done), done = items.filter(i => i.done);
  const lines = [head(v)];
  if (!open.length) lines.push('Nothing open.');
  else if (v.kind === 'shopping') {
    const groups = new Map();
    for (const i of open) { const k = i.category || 'Other'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); }
    const order = [...L.AISLE_NAMES, 'Other'].filter(k => groups.has(k)).concat([...groups.keys()].filter(k => ![...L.AISLE_NAMES, 'Other'].includes(k)));
    for (const k of order) lines.push(`${k}:`, ...groups.get(k).map(i => itemLine(i, tz)));
  } else lines.push(...open.map(i => itemLine(i, tz)));
  if (done.length) lines.push(includeDone ? 'Done:' : `(${done.length} done — list_show with include_done to see them)`, ...(includeDone ? done.map(i => itemLine(i, tz)) : []));
  return lines.join('\n');
}

const namesOf = xs => xs.map(i => `${i.text}${i.qty ? ` (${i.qty})` : ''}`).join(', ');
function refsText(r, { verb, doneVerb }) {
  const changed = r.changed.filter(i => !i.unchanged), same = r.changed.filter(i => i.unchanged);
  return [changed.length ? `${verb}: ${namesOf(changed)}.` : null,
    same.length ? `${doneVerb}: ${namesOf(same)}.` : null,
    r.missing.length ? `Not on the list: ${r.missing.map(m => `“${m}”`).join(', ')}.` : null,
    ...r.ambiguous.map(a => `Several items match “${a.ref}”: ${a.candidates.map(c => `[#${c.id}] ${c.text}`).join(', ')} — ask which one, then use its #id.`),
  ].filter(Boolean).join('\n');
}

const LIST_PARAM = { type: 'string', description: 'The list: its name ("Shopping", "Maya’s birthday") or #id. Omit to use their one list of that kind.' };
const KIND_PARAM = { type: 'string', enum: L.KINDS, description: 'Which kind of list when `list` is omitted (default shopping).' };
const resolve = (ctx, args) => L.resolveList(ctx.user, { ref: args.list, kind: args.kind });

registerTool({
  name: 'list_create', displayName: 'Lists', toolset: 'lists', risk: 'write', iconName: 'list-checks', activity: 'planning',
  description: 'Make a list: shopping, to-do, wish (birthday / gift ideas), packing or custom. shared_with: "private" (default) or the '
    + 'name of a group they belong to (e.g. "Family") so everyone in it sees and changes it. Ask which when it isn’t clear. For a wish '
    + 'list, `for` names whose wishes they are: others can then mark items bought without that person ever seeing it. If a list with '
    + 'that name already exists there, it is reused.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['title'],
    properties: {
      title: { type: 'string', description: 'Short name: "Shopping", "Trip to Madeira", "Maya’s birthday".' },
      kind: { type: 'string', enum: L.KINDS },
      shared_with: { type: 'string', description: '"private" (default) or a group name they belong to.' },
      for: { type: 'string', description: 'Wish lists: whose wishes (a name, or "me"). Default: the person asking.' },
    },
  },
  label: args => `Made the list “${String(args.title || '').slice(0, 40)}”`,
  target: args => args.shared_with && args.shared_with !== 'private' ? `shared with ${args.shared_with}` : 'private',
  run: async (args, ctx) => {
    const { list, existed } = L.createList(ctx.user, { title: args.title, kind: args.kind || 'todo', scope: args.shared_with || 'private', wisher: args.for });
    const v = L.listView(list, ctx.user);
    return { content: `${existed ? 'Already there, using it' : 'Made it'}: ${head(v)}. Id #${v.id}.`, step: { detail: `${v.title} · ${where(v)}` } };
  },
});

registerTool({
  name: 'list_add', displayName: 'Lists', toolset: 'lists', risk: 'write', iconName: 'list-checks', activity: 'planning',
  description: 'Add items to a list, all in one call ("add milk, 2 kg rice and eggs"). Quantities can stay in the text ("Milk 1L", '
    + '"2 kg rice") — they are read for shopping and packing lists. Something already open on the list isn’t added twice. Shopping items '
    + 'are sorted into aisles. To-dos can have an assignee (someone who shares the list) and a due date or time.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['items'],
    properties: {
      list: LIST_PARAM, kind: KIND_PARAM,
      items: {
        type: 'array', minItems: 1, maxItems: L.BATCH_MAX,
        items: {
          type: 'object', additionalProperties: false, required: ['text'],
          properties: {
            text: { type: 'string', description: 'The item, as said: "Milk 1L", "Call the plumber".' },
            qty: { type: 'string', description: 'Only if separate from the text: "2", "500 g".' },
            assignee: { type: 'string', description: 'Who it is for (a name, or "me").' },
            due: { type: 'string', description: 'YYYY-MM-DD or an ISO date-time with their offset.' },
          },
        },
      },
    },
  },
  label: args => `Added ${args.items?.length || 1} item${(args.items?.length || 1) === 1 ? '' : 's'} to ${args.list ? `“${String(args.list).slice(0, 30)}”` : `the ${args.kind || 'shopping'} list`}`,
  target: args => (args.items || []).map(i => i.text).join(', ').slice(0, 60),
  run: async (args, ctx) => {
    const { list, created } = resolve(ctx, args);
    const r = L.addItems(ctx.user, list.id, (args.items || []).map(i => ({ text: i.text, qty: i.qty ?? null, assignee: i.assignee, due: i.due })),
      { sourceMsgId: ctx.run?.trigger_message_id ?? null });
    const lines = [created ? `Made a new private list “${r.list.title}” (they aren’t in any group).` : null,
      r.added.length ? `Added: ${namesOf(r.added)}.` : null,
      r.updated.length ? `Updated: ${namesOf(r.updated)}.` : null,
      r.already.length ? `Already on the list: ${namesOf(r.already)}.` : null,
      head(r.list)].filter(Boolean);
    return { content: lines.join('\n'), step: { detail: `${r.list.title}: ${r.list.open} open` } };
  },
});

registerTool({
  name: 'list_show', displayName: 'Lists', toolset: 'lists', risk: 'read', iconName: 'list-checks', activity: 'reading',
  description: 'Show a list with its items (#ids, quantities, who, when; shopping grouped by aisle). Without `list` and `kind`: all their '
    + 'lists with counts. Read it before ticking or removing when unsure what is on it.',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: { list: LIST_PARAM, kind: KIND_PARAM, include_done: { type: 'boolean', description: 'Also list the ticked items.' } },
  },
  label: args => (args.list || args.kind ? `Looked at ${args.list ? `“${String(args.list).slice(0, 30)}”` : `the ${args.kind} list`}` : 'Looked at the lists'),
  run: async (args, ctx) => {
    if (!args.list && !args.kind) {
      const lists = L.listsOf(ctx.user).map(l => L.listView(l, ctx.user));
      if (!lists.length) return 'They have no lists yet. Make one with list_create when they want one.';
      return { content: `Their lists:\n${lists.map(v => `- #${v.id} ${head(v)}`).join('\n')}`, step: { detail: `${lists.length} lists` } };
    }
    const { list } = resolve(ctx, args);
    const shown = L.showList(ctx.user, list.id);
    return { content: listText(shown, { tz: tzOf(ctx.user), includeDone: !!args.include_done }), step: { detail: `${shown.list.title}: ${shown.list.open} open` } };
  },
});

registerTool({
  name: 'list_check', displayName: 'Lists', toolset: 'lists', risk: 'write', iconName: 'check', activity: 'planning',
  description: 'Tick items off (bought, done, packed) — or untick them with undo. Name items as said ("milk") or by #id; when several '
    + 'items match, nothing is changed and you get the choices: ask which one. On someone else’s wish list a tick means "bought": the '
    + 'wisher never sees it.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['items'],
    properties: {
      list: LIST_PARAM, kind: KIND_PARAM,
      items: { type: 'array', minItems: 1, maxItems: L.BATCH_MAX, items: { type: 'string' }, description: 'Item words or #ids.' },
      undo: { type: 'boolean', description: 'Untick instead (put back on the list).' },
    },
  },
  label: args => `${args.undo ? 'Unticked' : 'Ticked off'} ${(args.items || []).join(', ').slice(0, 40)}`,
  run: async (args, ctx) => {
    const { list } = resolve(ctx, args);
    const r = L.checkItems(ctx.user, list.id, args.items, { done: !args.undo });
    const bought = r.list.kind === 'wish' && r.list.wisherId !== ctx.user.id && !args.undo;
    const text = refsText(r, { verb: args.undo ? 'Back on the list' : bought ? 'Marked bought (hidden from the wisher)' : 'Ticked', doneVerb: args.undo ? 'Already open' : 'Already done' });
    return { content: `${text}\n${head(r.list)}`, step: { detail: `${r.list.title}: ${r.list.open} open`, status: r.changed.length ? 'ok' : 'bad' } };
  },
});

registerTool({
  name: 'list_remove', displayName: 'Lists', toolset: 'lists', risk: 'write', iconName: 'trash-2', activity: 'planning',
  description: 'Remove items from a list (by words or #id; several matches → ask which), or clear_done to remove every ticked item. '
    + 'archive_list puts the whole list away (only whoever made it, or the admin; it can be restored from the Lists page).',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      list: LIST_PARAM, kind: KIND_PARAM,
      items: { type: 'array', maxItems: L.BATCH_MAX, items: { type: 'string' } },
      clear_done: { type: 'boolean', description: 'Remove all ticked items.' },
      archive_list: { type: 'boolean', description: 'Archive the whole list.' },
    },
  },
  label: args => (args.archive_list ? 'Archived a list' : args.clear_done ? 'Cleared the ticked items' : `Removed ${(args.items || []).join(', ').slice(0, 40)}`),
  run: async (args, ctx) => {
    const { list } = resolve(ctx, args);
    if (args.archive_list) {
      L.archiveList(ctx.user, list.id);
      return { content: `Archived “${list.title}”. It can be restored from the Lists page.`, step: { detail: list.title } };
    }
    if (!args.items?.length && !args.clear_done) return 'Say which items to remove, or set clear_done.';
    const r = L.removeItems(ctx.user, list.id, args.items || [], { clearDone: !!args.clear_done });
    return { content: `${refsText(r, { verb: 'Removed', doneVerb: 'Removed' }) || 'Nothing to remove.'}\n${head(r.list)}`, step: { detail: `${r.list.title}: ${r.list.open} open` } };
  },
});
