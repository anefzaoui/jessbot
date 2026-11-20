// Goals tools (Phase 8, decision #55): see what the person is working toward, notice new goals from conversation,
// and record progress so each goal's status and timeline follow what actually happens in chat.
import { registerTool } from './registry.js';
import { all } from '../../db/index.js';
import * as G from '../../services/goals.js';
import { GOAL_CATEGORIES } from '../../content/starters.js';
import { kick, startReady } from '../goals.js';
import { tzOf } from '../../lib/when.js';
import { projectOfThread } from '../../services/projects.js';
import { run as sql } from '../../db/index.js';

const CATEGORIES = GOAL_CATEGORIES.map(c => c.value);

registerTool({
  name: 'goals_list', toolset: 'goals', risk: 'read', activity: 'thinking', iconName: 'target',
  description: 'The person’s goals (Goals page) with each plan step and its status. Use before planning anything related, '
    + 'or when they ask how a goal is going.',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  label: () => 'Looked at your goals',
  run: async (args, ctx) => {
    const goals = all(`SELECT * FROM goals WHERE user_id = ? AND state IN ('active', 'paused', 'suggested', 'done') ORDER BY state, updated_at DESC`, ctx.user.id);
    const down = G.turnedDownBlock(ctx.user);
    if (!goals.length) return `No goals yet. If they mention something they want to achieve, offer to set it up as a goal (goal_suggest).${down ? `\n\n${down}` : ''}`;
    const tz = tzOf(ctx.user);
    return goals.map(g => {
      const tasks = G.tasksOf(g);
      const next = G.nextStepOf(g, tasks);
      const streak = G.streakOf(g, { tz }).label;
      return [`[goal ${g.id}] ${g.title} — ${g.state}${g.horizon === 'long' ? ', longer horizon' : ''}, ${g.progress}%${streak ? `, ${streak}` : ''}`,
        g.status_line && `  status: ${g.status_line}`, next && `  next: ${next}`,
        ...G.measuresOf(g).map(m => `  measure: ${G.measureView(m, { tz }).line}`),
        ...tasks.map(t => {
          const waits = G.blockersOf(t, tasks);
          return `  - [step ${t.id}] ${t.title} (${t.status}${t.enabled ? (waits.length ? ', queued' : ', switched on') : ''}${t.kind === 'recurring' ? `, ${t.repeat}` : ''})`
            + `${waits.length ? ` after: ${waits.map(w => `[step ${w.id}]`).join(', ')}` : ''}${t.done_when ? ` · done when: ${t.done_when}` : ''}`;
        }),
      ].filter(Boolean).join('\n');
    }).join('\n\n') + `${down ? `\n\n${down}` : ''}\nLink a goal as [title](/goals/ID).`;
  },
});

registerTool({
  name: 'goal_suggest', toolset: 'goals', risk: 'write', activity: 'thinking', iconName: 'sparkles',
  persistent: true, // a goal drives plans and check-ins from now on: asks first after outside content (#124)
  undo: { possible: true, note: 'you can remove it on the Goals page' },
  description: 'Put a goal on the person’s Goals page. Use when they say they want to achieve something lasting (get fit, save for a '
    + 'house, grow on LinkedIn, learn Spanish). If they explicitly asked to set it as a goal, set confirmed=true (it becomes active and '
    + 'I start asking them a few questions on the Goals page); otherwise it appears under "I noticed you care about…" for them to accept. '
    + 'Never suggest anything like what they turned down (listed as TURNED DOWN with their goals), even in other words.',
  parameters: {
    type: 'object', required: ['title', 'category'], additionalProperties: false,
    properties: {
      title: { type: 'string', description: 'Short, in their words, ≤ 60 chars: "Run a 5k by spring".' },
      category: { type: 'string', enum: CATEGORIES },
      why: { type: 'string', description: 'For a suggestion: ≤ 120 chars, "You mentioned …".' },
      confirmed: { type: 'boolean', description: 'true only when they asked for it to be a goal (default false: a suggestion).' },
    },
  },
  label: args => `${args.confirmed ? 'Set a goal' : 'Suggested a goal'}: “${String(args.title || '').slice(0, 50)}”`,
  run: async (args, ctx) => {
    const same = all(`SELECT id, state FROM goals WHERE user_id = ? AND lower(title) = lower(?) AND state != 'archived'`, ctx.user.id, String(args.title).trim());
    if (same.length) return `That goal already exists ([goal ${same[0].id}], ${same[0].state}) — link it as [${args.title}](/goals/${same[0].id}).`;
    const g = G.createGoal({ user: ctx.user, title: args.title, category: args.category, createdBy: 'agent',
      state: args.confirmed ? 'active' : 'suggested', why: args.why });
    const project = projectOfThread(ctx.thread.id); // a goal set inside a project chat belongs to that project
    if (project) sql('UPDATE goals SET project_id = ? WHERE id = ?', project.id, g.id);
    G.announceGoal(ctx.user.id, g.id);
    if (args.confirmed) kick(g);
    return {
      content: args.confirmed
        ? `Goal set. Tell them it's on their Goals page — [${g.title}](/goals/${g.id}) — where you'll ask a few quick questions, then show everything you can do.`
        : `Suggested. It's waiting on their Goals page under “I noticed you care about…” — [open Goals](/goals).`,
      step: { detail: g.title, href: args.confirmed ? `/goals/${g.id}` : '/goals' },
    };
  },
});

registerTool({
  name: 'goal_progress', toolset: 'goals', risk: 'write', activity: 'thinking', iconName: 'flag',
  description: 'Record progress on one of their goals from this conversation: something they did or told you ("ran 3k today"), '
    + 'or a plan step you finished here. It lands on the goal’s timeline and refreshes its status. When there is a number, log it '
    + 'against a measure (goals_list shows each goal’s measures): the level now ("weighed 88 kg", "savings at 2,400") or one session '
    + 'of a rhythm ("ran today" → value 1, or the distance). To start counting something new, give measure plus target and/or per_week.',
  parameters: {
    type: 'object', required: ['goal_id', 'note'], additionalProperties: false,
    properties: {
      goal_id: { type: 'integer' },
      note: { type: 'string', description: 'One line, ≤ 140 chars, e.g. "Ran 3 km without stopping".' },
      step_done: { type: 'integer', description: 'A plan step id this finished, if any.' },
      measure: { type: 'string', description: 'Which number this logs, by its name ("Weight", "Runs"). Leave out when the goal has only one measure.' },
      value: { type: 'number', description: 'The number: the level now (weight today, savings balance now) or, for a per-week rhythm, this session’s amount (1 if none).' },
      target: { type: 'number', description: 'New measure only: the level they want to reach (84 for "down to 84 kg").' },
      start: { type: 'number', description: 'New measure only: where they started, if not today’s value.' },
      unit: { type: 'string', description: 'New measure only: "kg", "EUR", "km"…' },
      per_week: { type: 'integer', description: 'New measure only: how many times a week they aim for (3 for "run 3× a week").' },
    },
  },
  label: args => `Noted progress: ${String(args.note || '').slice(0, 50)}`,
  run: async (args, ctx) => {
    const g = G.goalForUser(ctx.user, args.goal_id);
    // The number first: a wrong measure name is reported back (with the goal's measures) and nothing is half-recorded.
    let logged = null;
    if (args.value != null || args.target != null || args.per_week != null) {
      let m = G.findMeasure(g, args.measure);
      if (!m && args.measure && (args.target != null || args.per_week != null)) {
        m = G.addMeasure(g, { label: args.measure, unit: args.unit, start: args.start ?? (args.target != null ? args.value : null), target: args.target, per_week: args.per_week });
      }
      if (!m) {
        const names = G.measuresOf(g).map(x => `“${x.label}”`).join(', ');
        return `Not recorded: ${names ? `this goal counts ${names}; say which one (measure)` : 'this goal has no measure yet; to start one give measure plus target and/or per_week'}.`;
      }
      if (args.value != null) m = G.logMeasure(g, m, { value: args.value, note: args.note, runId: ctx.run.id });
      logged = G.measureView(m, { tz: tzOf(ctx.user) });
    }
    G.addEvent(g, { kind: 'reply', iconName: logged ? 'chart-line' : 'message-circle', title: String(args.note).slice(0, 140),
      detail: logged && args.value != null ? logged.line : null, href: `/chat/${ctx.thread.id}`, runId: ctx.run.id });
    if (args.step_done) {
      const t = G.taskOfGoal(g, args.step_done);
      G.setTask(t.id, { status: 'done', done_at: new Date().toISOString() });
      startReady(g); // steps queued after it start now
    }
    G.setGoalFields(g.id, { next_review_at: new Date(Date.now() + 60000).toISOString() }); // a fresh status shortly
    G.announceGoal(ctx.user.id, g.id);
    const now = G.getGoal(g.id);
    const numbers = logged ? ` ${logged.line}${logged.progress != null ? ` (${now.progress}% of the way)` : ''}.` : '';
    return { content: `Noted on [${g.title}](/goals/${g.id}).${numbers}`, step: { detail: g.title, href: `/goals/${g.id}` } };
  },
});
