// The skill quality gate (Phase 24): every folder in skills/ must pass it. Run: npm test  (throwaway data dir, no network).
// A skill here parses, isn't broken, has no serious review finding, doesn't collide with another skill's description,
// keeps its description short, lists only real toolsets, ends with "Done when" and a "Sources:" line, and says to call the
// tools exactly as they are: every tool it names exists, every parameter it gives belongs to a tool that step names, and every
// value it gives is one that parameter takes (the contract check below). The recommended core set also carries `examples:`
// that route to it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-unit-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env'); // keys the code makes (secrets, VAPID) never land in the real .env
process.env.JESSBOT_EMBED_OFF = '1'; // no embedding calls from unit tests
process.env.JESSBOT_DECIDE_OFF = '1'; // no decision-model calls either: every use takes its fallback

const { openDb, closeDb } = await import('../src/db/index.js');
const { ensureDirs, paths } = await import('../src/config/index.js');
ensureDirs();
await openDb();

await import('../src/agent/tools/index.js');
const { allTools } = await import('../src/agent/tools/registry.js');
const { TOOLSETS } = await import('../src/services/policy.js');
const sk = await import('../src/services/skills.js');
const { lintSkill, tfidfCosine, COLLISION, examplesCheck } = await import('../src/services/skill-lint.js');

// ---- The contract check -------------------------------------------------------------------------------------------------
// The registry as the check reads it: tool → Map(parameter → [its schemas]), nested properties included (follow_up's
// every_min, a spreadsheet column's input, an ask_user question's kind).
function contractOf(list) {
  const tools = new Map();
  for (const t of list) {
    const params = new Map();
    const walk = schema => {
      if (!schema || typeof schema !== 'object') return;
      for (const [k, v] of Object.entries(schema.properties || {})) {
        if (!params.has(k)) params.set(k, []);
        params.get(k).push(v);
        walk(v);
      }
      if (schema.items) walk(schema.items);
    };
    walk(t.parameters);
    tools.set(t.name, params);
  }
  const everyParam = new Map();
  for (const [name, params] of tools) for (const p of params.keys()) everyParam.set(p, [...(everyParam.get(p) || []), name]);
  return { tools, everyParam };
}

const enumOf = schema => schema.enum || schema.items?.enum || null;
const typesOf = schema => [].concat(schema.type || []);

// The value written after `name:` → what kind of literal it is, or null when the span isn't a parameter at all
// (`diet:halal=yes`, a web address). Placeholders ("…", "<target>") are open: only their kind is checked.
function literalOf(raw) {
  const v = raw.trim();
  if (!v || /^(?:…|\.\.\.)$/.test(v) || /^<[^>]*>$/.test(v)) return { kind: 'any' };
  const q = /^"([^"]*)"$/.exec(v) || /^'([^']*)'$/.exec(v);
  if (q) return { kind: 'string', value: q[1], open: /[<…]/.test(q[1]) };
  if (v === 'true' || v === 'false') return { kind: 'boolean' };
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return { kind: 'number' };
  if (v[0] === '[') return { kind: 'array' };
  if (v[0] === '{') return { kind: 'object' };
  return null;
}

// Does one schema take this literal? → null, or why not.
function refusal(schema, lit) {
  const types = typesOf(schema);
  const want = { string: ['string'], boolean: ['boolean'], number: ['number', 'integer'], array: ['array'], object: ['object'] }[lit.kind];
  if (want && types.length && !types.some(t => want.includes(t))) return `takes ${types.join('/')}, not ${lit.kind === 'number' ? 'a number' : lit.kind === 'string' ? 'text' : `a${lit.kind === 'array' || lit.kind === 'object' ? 'n' : ''} ${lit.kind}`}`;
  const allowed = enumOf(schema);
  if (allowed && lit.kind === 'string' && !lit.open && types.includes('string') && !allowed.includes(lit.value)) return `takes one of ${allowed.join(', ')}, not "${lit.value}"`;
  return null;
}

// Steps: a numbered item with its indented lines, a paragraph, a heading, a list bullet or a table row.
function stepsOf(body) {
  const out = [];
  let cur = null;
  const flush = () => { if (cur) out.push(cur); cur = null; };
  body.split('\n').forEach((line, i) => {
    if (!line.trim()) return flush();
    if (!cur || /^(?:\d+[.)]\s|#{1,6}\s|[-*]\s|\|)/.test(line)) { flush(); cur = { line: i + 1, text: line }; }
    else cur.text += `\n${line}`;
  });
  flush();
  return out;
}

const SNAKE = /^[a-z][a-z0-9]*_[a-z0-9_]+$/;
const WORD = /^[a-z][a-zA-Z0-9]*$/;

/** Every place a skill's steps don't match the tools' contract → ["line N: …"]. A step's scope is the tools it names (in
 *  backticks or not); a step naming none is read against every tool the skill names. */
function contractProblems(body, contract) {
  const { tools, everyParam } = contract;
  const toolRe = [...tools.keys()].map(n => [n, new RegExp(`(?<![\\w-])${n}(?![\\w-])`)]);
  const named = text => toolRe.filter(([, re]) => re.test(text)).map(([n]) => n);
  const skillTools = named(body);
  const problems = [];
  const where = names => names.length ? `the tools this step names (${names.join(', ')})` : 'any tool';
  for (const step of stepsOf(body)) {
    const text = step.text.replace(/\n\s*/g, ' ');
    const own = named(text);
    const scope = own.length ? own : skillTools;
    const paramsIn = p => scope.filter(t => tools.get(t).has(p));
    const enumValueIn = v => scope.some(t => [...tools.get(t).values()].flat().some(s => enumOf(s)?.includes(v)));
    const say = msg => problems.push(`line ${step.line}: ${msg}`);
    const elsewhere = p => (everyParam.get(p) ? ` (it is a parameter of ${everyParam.get(p).slice(0, 4).join(', ')})` : '');
    // A value is checked against its parameter: `name: value`, `name` "value", and a quoted span listed right after one
    // (`site: "dhl"`, `"laposte"`).
    const checkValue = (name, lit, shown) => {
      const owners = paramsIn(name);
      if (!owners.length) return say(`${shown}: "${name}" is not a parameter of ${where(scope)}${elsewhere(name)}`);
      const why = owners.flatMap(t => tools.get(t).get(name)).map(s => refusal(s, lit));
      if (why.every(Boolean)) say(`${shown}: ${name} ${why[0]}`);
    };
    let last = null; // { name, end }: the parameter the previous span gave a value to
    for (const m of text.matchAll(/`([^`]+)`/g)) {
      const span = m[1].trim();
      const end = m.index + m[0].length;
      const before = last ? text.slice(last.end, m.index) : null;
      if (tools.has(span)) { last = null; continue; }
      const pv = /^([a-z][a-z0-9_]*)\s*:(?!\/\/)\s*(.*)$/.exec(span);
      const lit = pv && literalOf(pv[2]);
      if (pv && lit) { checkValue(pv[1], lit, `\`${span}\``); last = { name: pv[1], end }; continue; }
      const quoted = /^"[^"]*"$/.test(span) && literalOf(span);
      if (quoted && last && /^[\s,]*(?:or|and)?[\s,]*$/.test(before)) { checkValue(last.name, quoted, `\`${last.name}: ${span}\``); last.end = end; continue; }
      last = null;
      const after = WORD.test(span) || SNAKE.test(span) ? /^\s+("[^"]*")/.exec(text.slice(end)) : null;
      if (after && paramsIn(span).length) { checkValue(span, literalOf(after[1]), `\`${span}\` ${after[1]}`); continue; }
      if (SNAKE.test(span)) {
        if (paramsIn(span).length || enumValueIn(span)) continue;
        say(`\`${span}\` is neither a tool nor a parameter of ${where(scope)}${elsewhere(span)}`);
      } else if (WORD.test(span) && everyParam.has(span) && !paramsIn(span).length && !enumValueIn(span)) {
        say(`\`${span}\` is not a parameter of ${where(scope)}${elsewhere(span)}`);
      }
    }
    // A snake_case word outside backticks and quotes reads as a tool or parameter name too: it must be one.
    for (const m of text.replace(/`[^`]*`/g, ' ').replace(/"[^"]{0,80}"/g, ' ').matchAll(/(?<![\w/.-])[a-z][a-z0-9]*_[a-z0-9_]+(?![\w-])/g)) {
      if (!tools.has(m[0]) && !everyParam.has(m[0]) && !enumValueIn(m[0])) say(`${m[0]} reads as a tool or parameter name, but there is none`);
    }
  }
  return problems;
}

let skills, contract;
before(() => {
  skills = sk.allSkills().filter(s => s.origin === 'built-in');
  contract = contractOf(allTools());
});
after(() => { closeDb(); fs.rmSync(HOME, { recursive: true, force: true }); });

const folders = () => fs.readdirSync(paths.skills, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);

test('skills: every folder in skills/ has a SKILL.md that is listed', () => {
  const listed = new Set(skills.map(s => s.name));
  for (const name of folders()) {
    assert.ok(fs.existsSync(path.join(paths.skills, name, 'SKILL.md')), `${name}: no SKILL.md`);
    assert.ok(listed.has(name), `${name}: not listed by allSkills()`);
  }
  assert.ok(skills.length >= 4);
});

test('skills: none is broken; front matter is name + description + real toolsets', () => {
  for (const s of skills) {
    assert.notEqual(s.status, 'broken', `${s.name}: ${s.problems.join(' ')}`);
    assert.equal(s.meta.name, s.name);
    assert.ok(s.description.length > 0 && s.description.length <= sk.DESCRIPTION_MAX, `${s.name}: description is ${s.description.length} characters (max ${sk.DESCRIPTION_MAX})`);
    for (const t of s.toolsets) assert.ok(TOOLSETS[t], `${s.name}: unknown toolset ${t}`);
    assert.equal(new Set(s.toolsets).size, s.toolsets.length, `${s.name}: a toolset is listed twice`);
  }
});

test('skills: the review assistant finds nothing serious and no description collides with another skill', () => {
  for (const s of skills) {
    const others = skills.filter(o => o.name !== s.name).map(o => ({ name: o.name, description: o.description }));
    const findings = lintSkill({ name: s.name, raw: s.raw, meta: s.meta, body: s.body, files: s.fileBufs }, { others });
    const bad = findings.filter(f => f.level === 'bad');
    assert.deepEqual(bad, [], `${s.name} has a serious finding: ${JSON.stringify(bad)}`);
    const clash = findings.filter(f => f.code === 'description-collision');
    assert.deepEqual(clash.map(f => f.message), [], `${s.name} collides`);
    const unknown = findings.filter(f => f.code === 'unknown-tool' || f.code.startsWith('examples-'));
    assert.deepEqual(unknown.map(f => f.message), [], `${s.name}: the review assistant notes`);
  }
});

test('skills: pairwise description similarity stays under the collision threshold (whole-catalogue corpus)', () => {
  const corpus = skills.map(s => s.description);
  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      const score = tfidfCosine(skills[i].description, skills[j].description, corpus);
      assert.ok(score < COLLISION, `${skills[i].name} ~ ${skills[j].name}: ${score.toFixed(2)}`);
    }
  }
});

test('skills: every body has a "Done when" section and ends with a Sources line', () => {
  for (const s of skills) {
    assert.match(s.body, /^(?:#{1,6}\s*|\*\*)Done when\b/im, `${s.name}: no "Done when" section`);
    const last = s.body.trim().split('\n').pop();
    assert.match(last, /^Sources:\s*\S/, `${s.name}: the last line should be "Sources: …"`);
  }
});

test('skills: the contract check catches a wrong tool, a parameter of another tool, a bad enum value and a wrong type', () => {
  const body = [
    '1. Save it with `remember`, `recurs: "yearly"` and `yearly: "yes"`.',
    '2. `open_search` with `site: "expedia"`, then `web_read` with `save_pdf: true`.',
    '3. `recall` first, then fix it with `action: "update"`.',
    '4. Call `make_magic` and `schedule_task` with `only_when: "…"`, `until:` the last day and `watch_url`.',
    '5. `list_show` with `kind: "wish"`; `pick_random` with `mode: "shuffle"`, `reveal: "organiser"`; a `secret_santa` draw.',
    '6. Plain words stay plain: `SUMIFS`, `0 9 * * *`, `diet:halal=yes`, `https://example.org/a`, `"story"`.',
    '7. `library_export` with `format: "png"` and `size: "square"` or `"poster"`; `list_show` `kind` "wishes".',
    '8. `ask_user` (`show_screen: true`) with a question of `kind: "single"`; `set_reminder` with `every_min: 30`.',
    '9. Then `set_timer`, `start` it, and call schedule_tasks.',
    '- Done when the watch has `watch_url`.',
  ].join('\n');
  const got = contractProblems(body, contract);
  const expect = [
    /^line 1: `recurs: "yearly"`: "recurs" is not a parameter of the tools this step names \(remember\)/,
    /^line 1: `yearly: "yes"`: yearly takes boolean, not text/,
    /^line 2: `site: "expedia"`: site takes one of google_flights, /,
    /^line 2: `save_pdf: true`: "save_pdf" is not a parameter of the tools this step names \(web_read, open_search\) \(it is a parameter of web_screenshot\)/,
    /^line 3: `action: "update"`: "action" is not a parameter of the tools this step names \(recall\)/,
    /^line 4: `make_magic` is neither a tool nor a parameter/,
    /^line 7: `size: "poster"`: size takes one of A4, A5, Letter, square, story, not "poster"/,
    /^line 7: `kind` "wishes": kind takes one of shopping, todo, wish, packing, custom, not "wishes"/,
    /^line 9: `start` is not a parameter of the tools this step names \(set_timer\) \(it is a parameter of /,
    /^line 9: schedule_tasks reads as a tool or parameter name, but there is none/,
  ];
  assert.equal(got.length, expect.length, got.join('\n'));
  expect.forEach((re, i) => assert.match(got[i], re));
});

test('skills: every tool, parameter and value a skill names matches the tools’ contract', () => {
  const all = [];
  for (const s of skills) for (const p of contractProblems(s.body, contract)) all.push(`${s.name} ${p}`);
  assert.deepEqual(all, [], `\n${all.join('\n')}`);
});

test('skills: the review assistant takes a tool’s parameter or value for what it is, not for an unknown tool', () => {
  const body = '1. `schedule_task` with `watch_url`, then `pick_random` for a `secret_santa` draw, then `teleport_now`.';
  const meta = { name: 'x', description: 'Watching a page when someone asks.' };
  const f = lintSkill({ name: 'x', raw: `---
name: x
description: ${meta.description}
---

${body}
`, meta, body });
  assert.deepEqual(f.filter(x => x.code === 'unknown-tool').map(x => x.message), ['Names a tool Jess doesn’t have: teleport_now.']);
});
test('skills: the recommended core set carries 3 positive and 2 negative examples, and they route to the skill', () => {
  const pool = skills.filter(s => s.status !== 'broken');
  const misses = [];
  for (const name of sk.RECOMMENDED) {
    const s = skills.find(x => x.name === name);
    assert.ok(s, `recommended skill ${name} is missing`);
    assert.ok(s.examples, `${name}: no examples`);
    assert.deepEqual(s.examples.problems, [], `${name}: ${s.examples.problems.join(' ')}`);
    assert.ok(s.examples.positive.length >= 3 && s.examples.negative.length >= 2, `${name}: ${s.examples.positive.length} positive, ${s.examples.negative.length} negative`);
    for (const f of examplesCheck(s, pool)) misses.push(`${name}: ${f.kind} “${f.text}” ranks #${f.rank} (“${f.top}” first)`);
  }
  assert.deepEqual(misses, [], `\n${misses.join('\n')}`);
});
