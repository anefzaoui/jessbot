// Fast steps (Phase 16, docs/JEV.md, decision #109) — the pattern browser-use/jev-ultrafast published: while Jess works a
// web page, the decision model reads the task, what she has done so far and the page's elements (from the snapshot she
// just got — the same refs she sees), and picks the obvious next action. Only a confident click or scroll runs this way;
// typing, choosing values, reading, "done", anything needing the person — and anything unsure — go to the full model as
// before. The click goes through the normal tool, so the policy gate, approvals and step timeline are unchanged.
import { get, all } from '../db/index.js';
import { decide, choice, picked, note, threshold, decideSettings } from '../services/decide.js';
import { SNAPSHOT_MARK } from '../browser/session.js';
import { riskOfName } from './tools/browse.js';
import { NEXT_ACTION } from './autopilot.js';

export const FAST_STREAK = 4; // then a full model step re-plans and checks the page

// Tool results that end in a fresh snapshot of the page she is working on.
const PAGE_TOOLS = new Set(['browser_open', 'browser_click', 'browser_type', 'browser_pick_date', 'browser_select', 'browser_press',
  'browser_scroll', 'browser_back', 'browser_wait', 'browser_snapshot', 'browser_dialog', 'browser_tabs']);
// A page state the model must think about (or the person must see) — never a fast step then.
const NEEDS_THOUGHT = /^(BLOCKED|LOGIN|SIGN-IN|STUCK|COOKIES|PAYWALL|ERROR PAGE|CONFIRMATION):/m;
const CLICKABLE = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'option', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'treeitem', 'gridcell', 'combobox', 'listitem', 'img', 'cell', 'row']);
const MAX_ELEMENTS = 200;

/** The elements of a snapshot tool result: [{ ref, label }] — pop-up and "appeared" elements first, as the snapshot orders them. */
export function elementsOf(content) {
  const snap = content.slice(content.indexOf(SNAPSHOT_MARK) + SNAPSHOT_MARK.length);
  const seen = new Set();
  const out = [];
  let section = '';
  for (const line of snap.split('\n')) {
    if (/^Pop-up on top/.test(line)) section = 'pop-up';
    else if (/^Appeared after this action/.test(line)) section = 'new';
    else if (/^Whole page:/.test(line)) section = '';
    const m = /^\s*- ([\w-]+)(.*?)\[ref=([^\]]+)\]/.exec(line);
    if (!m || seen.has(m[3])) continue;
    const role = m[1];
    const clickable = CLICKABLE.has(role) || /\[cursor=pointer\]/.test(line);
    if (!clickable || role === 'textbox' || role === 'searchbox') continue;
    seen.add(m[3]);
    const name = m[2].replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').replace(/:$/, '').trim();
    const extra = /\{([^}]*)\}/.exec(line)?.[1];
    out.push({ ref: m[3], label: `${section ? `[${section}] ` : ''}${role} ${name}${extra ? ` {${extra}}` : ''}`.slice(0, 140) });
    if (out.length >= MAX_ELEMENTS) break;
  }
  return out;
}

const shortArgs = a => Object.entries(a || {}).filter(([k]) => k !== 'ref').map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`).join(', ');

/** { name, args, model } for a confident click or scroll — or null (the full model takes the step). */
export async function proposeFastStep({ run: r, user, signal }) {
  const last = get(`SELECT * FROM messages WHERE run_id = ? ORDER BY id DESC LIMIT 1`, r.id);
  if (!last || last.role !== 'tool' || !PAGE_TOOLS.has(last.tool_name) || !String(last.content).includes(SNAPSHOT_MARK)) return null;
  const head = last.content.slice(0, last.content.indexOf(SNAPSHOT_MARK));
  if (NEEDS_THOUGHT.test(head) || /^A \w+ dialog is open/m.test(head)) return null;
  const elements = elementsOf(last.content);
  if (!elements.length) return null;

  // The task: their words, her plan (what she said while working), and the steps so far.
  const task = get('SELECT content FROM messages WHERE id = ?', r.trigger_message_id)?.content || '';
  const said = all(`SELECT content FROM messages WHERE run_id = ? AND role = 'assistant' AND trim(content) != '' ORDER BY id DESC LIMIT 2`, r.id)
    .map(m => m.content).reverse().join('\n');
  const calls = all(`SELECT tool_calls FROM messages WHERE run_id = ? AND role = 'assistant' AND tool_calls IS NOT NULL ORDER BY id DESC LIMIT 8`, r.id)
    .reverse().flatMap(m => { try { return JSON.parse(m.tool_calls); } catch { return []; } });
  const steps = calls.map(c => { let a = {}; try { a = JSON.parse(c.function.arguments || '{}'); } catch { /* none */ } return `${c.function.name}(${shortArgs(a)})`; });
  const lastClick = calls.at(-1)?.function.name === 'browser_click' ? (() => { try { return JSON.parse(calls.at(-1).function.arguments).ref; } catch { return null; } })() : null;
  const scrolls = steps.slice(-2).filter(st => st.startsWith('browser_scroll')).length;

  const res = await decide('steps', {
    user, runId: r.id, timeoutMs: 2500, signal,
    state: {
      their_request: task.slice(0, 1500),
      jess_plan: said.slice(-1200) || '(none yet)',
      steps_so_far: steps.join('\n') || '(none)',
      page: head.replace(/\n{2,}/g, '\n').trim().slice(0, 1500),
    },
    questions: {
      next: choice({ question: 'What is the single best next action toward `their_request`, following `jess_plan`, on the page as it is now?', rules: NEXT_ACTION }, {
        click: 'click one element on the page (a link, button, tab, option, checkbox, a day, a result)',
        scroll: 'scroll down to see more of the page',
        type: 'type text into a field',
        choose: 'choose a value in a dropdown, or set a date',
        read: 'read, compare or pick among what is on the page before acting',
        done: 'what they asked for is already on the page',
        person: 'something only the person can do or decide (sign in, CAPTCHA, payment, a personal choice)',
        other: 'anything else',
      }),
      target: choice({ question: 'If the next action is a click, which element should be clicked?', rules: NEXT_ACTION },
        { ...Object.fromEntries(elements.map(e => [e.ref, e.label])), none: 'none of these' }),
    },
  });
  if (!res) return null;
  const thr = threshold();
  const next = picked(res.answers.next);
  const target = picked(res.answers.target);
  const el = elements.find(e => e.ref === target?.pick);
  const model = decideSettings().model;
  let step = null, why = null;
  if (next?.pick === 'click' && next.p >= thr) {
    if (!el || target.p < thr) why = `unsure which element (${(target?.p ?? 0).toFixed(2)})`;
    else if (el.ref === lastClick) why = 'same click as the last step';
    else if (riskOfName(el.label) !== 'read') why = 'it may pay or send';
    else step = { name: 'browser_click', args: { ref: el.ref, element: el.label.replace(/^\[[\w-]+\] /, '').replace(/ \{[^}]*\}$/, '').slice(0, 80) }, model };
  } else if (next?.pick === 'scroll' && next.p >= thr) {
    if (scrolls >= 2) why = 'scrolled twice already';
    else step = { name: 'browser_scroll', args: { direction: 'down' }, model };
  } else why = `${next?.pick || '?'} (${(next?.p ?? 0).toFixed(2)})`;
  note(res.id, step ? `${step.name === 'browser_click' ? `clicked ${step.args.element}` : 'scrolled down'} (${next.p.toFixed(2)}${el ? ` · ${target.p.toFixed(2)}` : ''})`
    : `handed to the model — ${why}`, { confidence: next?.p ?? null, acted: !!step, fallback: step ? null : 'unsure' });
  return step;
}
