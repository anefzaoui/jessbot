// use_skill (decision #84): load an approved skill's instructions when a task matches it (only names + descriptions sit in
// the prompt). Skill text is written by the admin or ships with Jessbot — trusted guidance, unlike web pages or email.
// Phase 23 (decisions #171–#172): use_skill also opens a skill's supporting files (progressive disclosure: the steps say
// when), and skill_propose lets Jess draft a skill for the admin's review, never from a task that read outside content.
import { registerTool } from './registry.js';
import { skillsFor, skillByName, openableFiles, skillFileText, proposeSkill, PROPOSAL_BODY_MAX, DESCRIPTION_MAX } from '../../services/skills.js';
import { enabledToolsets, TOOLSETS } from '../../services/policy.js';
import { fenceId } from '../../lib/untrusted.js';
import { isTainted } from '../taint.js';

const reasons = err => (err.errors ? Object.entries(err.errors).map(([k, v]) => `${k}: ${v}`).join(' ') : err.message);

registerTool({
  name: 'use_skill', toolset: 'core', risk: 'read', activity: 'planning', iconName: 'book-marked',
  displayName: 'Follows a skill',
  available: user => skillsFor(user, enabledToolsets(user)).length > 0,
  description: 'Load the step-by-step know-how for a kind of task (see the Skills list in your instructions). Call it first when a '
    + 'request matches a skill, then follow it. With `file`, open one of that skill\'s supporting files (listed at the end of '
    + 'the skill) when its steps say to.',
  parameters: { type: 'object', required: ['name'], additionalProperties: false, properties: {
    name: { type: 'string' },
    file: { type: 'string', description: 'A supporting file\'s exact name as the skill lists it (e.g. "frameworks.md"). Leave out to load the skill itself.' },
  } },
  label: args => (args.file ? `Opened “${String(args.file).slice(0, 40)}” from the “${String(args.name || '').slice(0, 40)}” skill`
    : `Opened the “${String(args.name || '').slice(0, 40)}” skill`),
  run: (args, ctx) => {
    const usable = skillsFor(ctx.user, enabledToolsets(ctx.user));
    const s = usable.find(x => x.name === String(args.name));
    if (!s) {
      let known;
      try { known = skillByName(args.name); } catch { return `There's no skill called “${args.name}”. Available: ${usable.map(x => x.name).join(', ') || 'none'}.`; }
      if (known.status === 'broken') return `The “${known.name}” skill is broken (${known.problems.join(' ')}), so it can't be used until the admin fixes its file in Admin → Skills. Do the task without it.`;
      return `The “${args.name}” skill isn't available right now (switched off, waiting for the admin's review, or it needs tools this person doesn't have).`;
    }
    if (args.file != null && args.file !== '') {
      let text;
      try { text = skillFileText(s, args.file); } catch (err) { return `Not opened: ${reasons(err)}`; }
      // Reviewed with the skill (the folder checksum covers it), so it is guidance like the steps; the random boundary
      // only keeps the file from ending its own block.
      const id = fenceId();
      return { content: `<skill_file skill="${s.name}" name="${args.file}" fence="${id}">\n(Part of the “${s.name}” skill, reviewed with it. Use it as the steps say.)\n\n${text.trim()}\n</skill_file fence="${id}">`,
        step: { detail: String(args.file).slice(0, 90) } };
    }
    const files = openableFiles(s);
    const more = files.length ? `\n\nSupporting files (open with use_skill name+file when the steps say so): ${files.join(', ')}` : '';
    return { content: `Skill “${s.name}” — follow it:\n\n${s.body}${more}`, step: { detail: s.description.slice(0, 90) } };
  },
});

registerTool({
  name: 'skill_propose', toolset: 'core', risk: 'write', activity: 'writing', iconName: 'notebook-pen',
  displayName: 'Drafts a skill',
  description: 'Draft a new skill (know-how for a kind of task) when the person asks to turn a way of doing something into one '
    + '("make this a skill", "do it like this every time"). It does NOT switch on: the admin reviews it in Admin → Skills first, '
    + 'so tell them that. Only from what they asked in this chat: refused when this task read outside content (web, email, files). '
    + `name: lowercase words with dashes. description: at most ${DESCRIPTION_MAX} characters, what it is for and when to use it in the `
    + 'words people say, no summary of the steps. body: numbered imperative steps with real tool names, safety lines kept, '
    + `at most ${PROPOSAL_BODY_MAX.toLocaleString('en')} characters, no web addresses to open. toolsets: only the essential ones. `
    + 'Proposing the same name again updates your own earlier draft (it goes back to review). If it is refused, fix what it says and try again.',
  parameters: {
    type: 'object', required: ['name', 'description', 'body', 'tests'], additionalProperties: false,
    properties: {
      name: { type: 'string', description: 'e.g. "school-lunch-order".' },
      description: { type: 'string' },
      toolsets: { type: 'array', items: { type: 'string', enum: Object.keys(TOOLSETS) }, description: 'Toolsets it cannot work without ([] for none).' },
      body: { type: 'string', description: 'The steps (markdown): a title, numbered steps, a "Done when" list.' },
      tests: { type: 'array', items: { type: 'string' }, description: '2 realistic requests that should open this skill.' },
      near_misses: { type: 'array', items: { type: 'string' }, description: '1 or 2 requests that sound similar but should not open it.' },
      why: { type: 'string', description: 'One line for the admin: what this captures and what they asked.' },
    },
  },
  label: args => `Drafted the “${String(args.name || '').slice(0, 40)}” skill for review`,
  run: (args, ctx) => {
    if (isTainted(ctx.run?.id)) {
      return 'Not proposed: this task read outside content (web, email, files), and a skill must come only from what they asked. '
        + 'If they want it, propose it on a later turn that reads nothing from outside.';
    }
    let out;
    try {
      out = proposeSkill({ name: args.name, description: args.description, toolsets: args.toolsets, body: args.body, tests: args.tests,
        nearMisses: args.near_misses, why: args.why }, { user: ctx.user, threadId: ctx.thread?.id ?? null, runId: ctx.run?.id ?? null });
    } catch (err) {
      if (err.code === 'lint_bad') return `Not proposed. ${err.message} Rewrite those lines and propose it again.`;
      if (err.status && err.expose) return `Not proposed: ${reasons(err)}`;
      throw err;
    }
    const warn = out.warnings.length ? ` The review assistant noted (you may improve these first): ${out.warnings.slice(0, 4).map(f => f.message).join(' ')}` : '';
    const who = ctx.user.role === 'admin' ? 'You can review and approve it in Admin → Skills' : 'The admin reviews it in Admin → Skills';
    return { content: `${out.updated ? 'Updated the draft' : 'Drafted'} “${out.skill.name}”: it waits for review and isn't in use yet. `
      + `${who} before it's used; tell them that in a line.${warn}`, step: { detail: out.updated ? 'Updated draft, waiting for review' : 'Waiting for the admin’s review' } };
  },
});
