// Skills (decision #17, built in Phase 12 — #84): know-how for a kind of task, written as `SKILL.md` (the agentskills
// format: YAML frontmatter with name + description, then markdown). Built-in ones live in the repo's `skills/`, ones the
// admin writes in `data/skills/` (backed up). Only name + description reach the prompt; Jess loads the body with use_skill
// when a task matches. A skill runs only once an admin approved it — and any change to its folder (a git pull, an edit,
// a changed supporting file) puts it back to "needs review" (the checksum no longer matches what was approved). No
// marketplace.
//
// Phase 18 (decisions #121–#122): a skill that can't be used is listed as `broken` with the reasons (it used to vanish);
// the checksum covers the whole folder; the approved SKILL.md is kept for a "changed since you approved it" diff; the
// review assistant (services/skill-lint.js) runs on demand, and approving a skill with a `bad` finding needs `force`.
//
// Phase 23 (decisions #171–#173): Jess can draft a skill (proposeSkill, the skill_propose tool): it lands in review, never
// active, with who asked, the chat and the test requests kept in skill_proposals (outside the folder the checksum covers);
// use_skill opens a skill's supporting .md/.txt files; optional `examples:` front matter is checked offline for routing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { structuredPatch } from 'diff';
import { all, get, run } from '../db/index.js';
import { paths } from '../config/index.js';
import { HttpError, invalid, notFound } from '../lib/errors.js';
import { findShapes, secretsIn } from '../lib/dlp.js';
import { looksLikeInjection } from '../agent/injection.js';
import { TOOLSETS } from './policy.js';
import { lintSkill, lintSummary, examplesOf, openableFile, SUPPORT_TEXT_MAX, urlFetchLines } from './skill-lint.js';
import { listUsers } from './users.js';
import { notify } from './notify.js';
import { logActivity } from './activity.js';
import { audit } from './audit.js';
import { botName } from './bot.js';

const SOURCES = [{ dir: paths.skills, origin: 'built-in' }, { dir: path.join(paths.data, 'skills'), origin: 'yours' }];

// ---- The recommended core set and the categories (Phase 25, decision #195) ------------------------------------------
/** The skills proposed on for a household (docs/PLAN-SKILLS.md Phase 24): Admin → Skills shows them as "Recommended to switch
 *  on" with one "Approve these" that runs the normal approval for each (checksum-pinned, review-gated, never silent). */
export const RECOMMENDED = Object.freeze(['research-report', 'inbox-triage', 'trip-planner', 'weekly-review', 'scam-check', 'fact-check',
  'medicine-info', 'read-long-document', 'bills-and-receipts', 'household-budget', 'meal-planner', 'grocery-order', 'morning-briefing',
  'plan-my-day', 'birthdays-and-people', 'appointment-prep', 'meeting-notes', 'write-with-me', 'polish-writing', 'decision-stress-test',
  'buying-guide', 'price-watch', 'troubleshoot', 'homework-helper', 'school-helper', 'bedtime-story']);

/** What each built-in skill is about, for the list's filter (kept here, not in SKILL.md: a front-matter edit would change every
 *  skill's checksum and put it back in review). A skill of your own, or one missing here, is 'other'. */
export const CATEGORIES = Object.freeze([
  { key: 'research', label: 'Research and facts', names: ['research-report', 'fact-check', 'scam-check', 'medicine-info', 'digital-safety-checkup', 'watch-topic', 'save-page', 'knowledge-notes'] },
  { key: 'day', label: 'Days and habits', names: ['morning-briefing', 'plan-my-day', 'weekly-review', 'life-planner', 'habit-coach', 'get-unstuck', 'automate-my-routines', 'daily-log', 'training-plan', 'time-capsule', 'get-to-know-me'] },
  { key: 'people', label: 'People, mail and calendar', names: ['inbox-triage', 'birthdays-and-people', 'appointment-prep', 'meeting-notes', 'find-a-time', 'email-to-calendar', 'family-update', 'questions-for-someone', 'difficult-conversation'] },
  { key: 'money', label: 'Money and home', names: ['household-budget', 'bills-and-receipts', 'expense-log', 'switch-provider', 'home-upkeep', 'home-search', 'document-expiry'] },
  { key: 'shopping', label: 'Shopping', names: ['buying-guide', 'price-watch', 'grocery-order', 'shop-and-return', 'second-hand-search', 'gift-finder', 'parcel-tracking'] },
  { key: 'food', label: 'Food', names: ['meal-planner', 'family-cookbook', 'sourdough-starter'] },
  { key: 'travel', label: 'Travel and going out', names: ['trip-planner', 'trip-organizer', 'flight-deals', 'places-and-directions', 'public-transport', 'events-finder', 'book-something', 'where-to-watch', 'media-tracker'] },
  { key: 'writing', label: 'Writing', names: ['write-with-me', 'polish-writing', 'draft-feedback', 'academic-writing', 'social-post', 'cv-and-cover-letter', 'book-or-memoir', 'translate-a-document', 'job-search'] },
  { key: 'documents', label: 'Documents and pages', names: ['read-long-document', 'document-compare', 'fill-a-form', 'spreadsheet-analysis', 'make-a-page', 'printables', 'mind-map-page', 'what-if-page', 'generative-art'] },
  { key: 'learning', label: 'Learning and school', names: ['homework-helper', 'school-helper', 'learn-with-me', 'learn-this', 'worksheet-maker'] },
  { key: 'family', label: 'Kids and family', names: ['bedtime-story', 'story-game', 'chore-quest', 'kids-activities', 'baby-log', 'family-history', 'fair-draw'] },
  { key: 'decisions', label: 'Decisions and ideas', names: ['decide', 'decision-stress-test', 'big-decision-map', 'idea-shaper'] },
  { key: 'help', label: 'Help and calm', names: ['troubleshoot', 'walk-me-through', 'calm-and-breathe', 'calm-requests', 'daily-devotion', 'skill-writer'] },
]);
const CATEGORY_OF = new Map(CATEGORIES.flatMap(c => c.names.map(n => [n, c.key])));
export const categoryOf = name => CATEGORY_OF.get(name) || 'other';
const NAME = /^[a-z0-9][a-z0-9-]{1,48}$/;
const BODY_MAX = 40_000;
export const DESCRIPTION_MAX = 400; // what the admin can write here: it sits in every prompt
const DESCRIPTION_SPEC_MAX = 1024; // the agentskills format's limit: longer ones on disk are broken
const TEMP = /\.tmp-\d+$/; // saveSkill's half-written file (renamed into place a moment later)
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

/** Every file in a skill's folder (recursive, sorted by relative path, `/` separators). Symlinks count by their target. */
function folderFiles(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (TEMP.test(e.name)) continue;
    if (e.isSymbolicLink()) out.push({ rel: r, buf: Buffer.from(`symlink:${fs.readlinkSync(path.join(dir, r))}`) });
    else if (e.isDirectory()) out.push(...folderFiles(dir, r));
    else if (e.isFile()) out.push({ rel: r, buf: fs.readFileSync(path.join(dir, r)) });
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** The folder checksum: SHA-256 over every file's relative path, length and bytes, in path order (#122). */
export function folderChecksum(files) {
  const h = crypto.createHash('sha256');
  for (const f of files) h.update(`${f.rel}\0${f.buf.length}\0`).update(f.buf);
  return h.digest('hex');
}

// SKILL.md → { raw, meta, body, problems[] }. Never throws: what's wrong becomes a reason the admin can read.
function parse(raw) {
  const m = /^\u{FEFF}?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(raw);
  if (!m) return { raw, meta: null, body: raw.trim(), problems: ['The file has no front matter (a --- block with name and description at the top).'] };
  let meta;
  try { meta = YAML.parse(m[1]); } catch (err) {
    return { raw, meta: null, body: m[2].trim(), problems: [`The front matter isn’t valid YAML: ${String(err.message).split('\n')[0]}`] };
  }
  if (meta == null) meta = {};
  if (typeof meta !== 'object' || Array.isArray(meta)) return { raw, meta: null, body: m[2].trim(), problems: ['The front matter must be a list of fields (name, description…).'] };
  return { raw, meta, body: m[2].trim(), problems: [] };
}

const toolsetsOf = meta => [].concat(meta?.toolsets ?? meta?.metadata?.toolsets ?? []).map(String);

function problemsOf(name, p) {
  const out = [...p.problems];
  if (!NAME.test(name)) out.push('The folder name must be lowercase letters, numbers and dashes (2 to 49 characters).');
  if (!p.meta) return out;
  if (p.meta.name !== name) out.push(p.meta.name ? `The front matter says name “${p.meta.name}” but the folder is “${name}”: they must match.` : 'The front matter has no name.');
  const d = typeof p.meta.description === 'string' ? p.meta.description.trim() : '';
  if (!d) out.push('The front matter has no description (what it’s for and when to use it).');
  else if (d.length > DESCRIPTION_SPEC_MAX) out.push(`The description is ${d.length} characters; the skill format allows ${DESCRIPTION_SPEC_MAX}.`);
  const unknown = toolsetsOf(p.meta).filter(t => !TOOLSETS[t]);
  if (unknown.length) out.push(`Unknown toolset${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Known: ${Object.keys(TOOLSETS).join(', ')}.`);
  if (!p.body) out.push('There are no instructions after the front matter.');
  else if (p.body.length > BODY_MAX) out.push(`The instructions are ${p.body.length.toLocaleString('en')} characters; the limit is ${BODY_MAX.toLocaleString('en')}.`);
  return out;
}

// Approvals made when the checksum covered SKILL.md alone are re-pinned to the folder checksum once, automatically,
// when that file is still exactly what was approved — so the new algorithm doesn't send every skill back to review (#122).
const repinWarned = new Set();
function repinLegacy(s, name, raw, checksum, fileHashes) {
  if (!s?.approved_checksum || s.approved_checksum === checksum || s.approved_checksum !== sha(raw)) return s;
  try {
    run(`UPDATE skills SET approved_checksum = ?, approved_body = COALESCE(approved_body, ?), approved_files = COALESCE(approved_files, ?)
         WHERE name = ? AND approved_checksum = ?`, checksum, raw, JSON.stringify(fileHashes), name, s.approved_checksum);
    console.log(`[skills] “${name}”: approval re-pinned to the whole-folder checksum`);
  } catch (err) { // a database whose updates aren't applied yet (npm run doctor before a start): same answer, written later
    if (!repinWarned.has(name)) console.warn(`[skills] couldn’t re-pin “${name}” yet: ${err.message}`);
    repinWarned.add(name);
  }
  return { ...s, approved_checksum: checksum, approved_body: s.approved_body ?? raw, approved_files: s.approved_files ?? JSON.stringify(fileHashes) };
}

/** Every skill on disk with its review state: [{ name, description, toolsets, origin, dir, checksum,
 *  status: active|review|off|broken, problems[], … }]. Broken ones (bad front matter, unknown toolsets…) are listed too. */
export function allSkills() {
  const state = new Map(all('SELECT * FROM skills').map(r => [r.name, r]));
  const proposals = latestProposals();
  const out = new Map();
  for (const { dir, origin } of SOURCES) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const folder = path.join(dir, name);
      const file = path.join(folder, 'SKILL.md');
      if (name.startsWith('.') || !fs.existsSync(file)) continue;
      const files = folderFiles(folder);
      const raw = files.find(f => f.rel === 'SKILL.md').buf.toString('utf8');
      const p = parse(raw);
      const problems = problemsOf(name, p);
      const checksum = folderChecksum(files);
      const fileHashes = Object.fromEntries(files.map(f => [f.rel, sha(f.buf)]));
      const s = problems.length ? state.get(name) : repinLegacy(state.get(name), name, raw, checksum, fileHashes);
      const approved = s?.approved_checksum === checksum;
      const status = problems.length ? 'broken' : !s || !s.enabled ? (approved ? 'off' : 'review') : approved ? 'active' : 'review';
      out.set(name, { name, description: typeof p.meta?.description === 'string' ? p.meta.description.trim() : '', toolsets: toolsetsOf(p.meta),
        license: p.meta?.license ? String(p.meta.license) : null, origin, dir: folder, checksum, status, problems, body: p.body, raw, meta: p.meta,
        approvedBy: s?.approved_by || null, approvedAt: s?.approved_at || null, approvedBody: s?.approved_body ?? null,
        approvedFiles: s?.approved_files ? JSON.parse(s.approved_files) : null, fileHashes, examples: examplesOf(p.meta),
        proposal: origin === 'yours' ? proposals.get(name) || null : null,
        files: files.map(f => f.rel).filter(r => r !== 'SKILL.md'), fileBufs: files.filter(f => f.rel !== 'SKILL.md').map(f => ({ name: f.rel, buf: f.buf })) });
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Active skills this person's toolsets can carry out. */
export const skillsFor = (user, toolsets) => allSkills().filter(s => s.status === 'active' && s.toolsets.every(t => toolsets.has(t)));

export function skillByName(name) {
  const s = allSkills().find(x => x.name === String(name));
  if (!s) throw notFound('No such skill.');
  return s;
}

/** The review assistant's findings for a skill (worst first), with collisions checked against the other active skills. */
export function lintOf(s, list = allSkills()) {
  const others = list.filter(o => o.status === 'active' && o.name !== s.name).map(o => ({ name: o.name, description: o.description }));
  return lintSkill({ name: s.name, raw: s.raw, meta: s.meta, body: s.body, files: s.fileBufs }, { others });
}

const lintBlocked = findings => {
  const bad = findings.filter(f => f.level === 'bad');
  return new HttpError(409, `This skill has ${bad.length === 1 ? 'a serious warning' : `${bad.length} serious warnings`}: ${bad[0].message} `
    + 'Read it, and approve anyway only if you trust it.', { code: 'lint_bad' });
};

/** Approve the folder as it is now (and switch it on), or switch it off. Approving a skill whose review found something
 *  serious (a `bad` finding) needs force: true ("approve anyway"). A broken skill can't be switched on. */
export function setSkill(name, enabled, actorId, { force = false } = {}) {
  const list = allSkills();
  const s = list.find(x => x.name === String(name));
  if (!s) throw notFound('No such skill.');
  if (enabled && s.status === 'broken') throw invalid({ name: `This skill is broken: ${s.problems.join(' ')}` });
  if (enabled && !force) {
    const findings = lintOf(s, list);
    if (findings.some(f => f.level === 'bad')) throw lintBlocked(findings);
  }
  run(`INSERT INTO skills (name, enabled, approved_checksum, approved_by, approved_at, approved_body, approved_files) VALUES (?, ?, ?, ?, datetime('now'), ?, ?)
       ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled,
         approved_checksum = CASE WHEN excluded.enabled THEN excluded.approved_checksum ELSE approved_checksum END,
         approved_body = CASE WHEN excluded.enabled THEN excluded.approved_body ELSE approved_body END,
         approved_files = CASE WHEN excluded.enabled THEN excluded.approved_files ELSE approved_files END,
         approved_by = excluded.approved_by, approved_at = excluded.approved_at`,
  s.name, enabled ? 1 : 0, enabled ? s.checksum : null, actorId, enabled ? s.raw : null, enabled ? JSON.stringify(s.fileHashes) : null);
  return skillByName(name);
}

const skillFile = ({ name, description, toolsets, body }) => {
  const front = YAML.stringify({ name, description: String(description).trim(), ...(toolsets.length ? { toolsets } : {}) }).trim();
  return `---\n${front}\n---\n\n${String(body).trim()}\n`;
};

/** The admin writes (or rewrites) one of their own skills; it is approved as written (force: approve despite a serious
 *  warning from the review assistant). Nothing is cut: a too-long description or an unknown toolset is an error. */
export function saveSkill({ name, description, toolsets = [], body }, actorId, { force = false } = {}) {
  const errors = {};
  const sets = [].concat(toolsets || []).map(String);
  if (!NAME.test(String(name || ''))) errors.name = 'Lowercase letters, numbers and dashes, e.g. trip-planner.';
  const desc = String(description || '').trim();
  if (!desc) errors.description = 'One or two sentences: what it’s for and when to use it.';
  else if (desc.length > DESCRIPTION_MAX) errors.description = `Keep it under ${DESCRIPTION_MAX} characters (it’s ${desc.length}): it sits in every prompt.`;
  const unknown = sets.filter(t => !TOOLSETS[t]);
  if (unknown.length) errors.toolsets = `Unknown toolset${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`;
  if (!String(body || '').trim()) errors.body = 'The instructions.';
  else if (String(body).length > BODY_MAX) errors.body = 'Keep it under 40,000 characters.';
  const builtIn = fs.existsSync(path.join(paths.skills, String(name || ''), 'SKILL.md'));
  if (builtIn) errors.name = 'A built-in skill has that name — pick another.';
  if (Object.keys(errors).length) throw invalid(errors);
  const raw = skillFile({ name, description: desc, toolsets: sets, body });
  if (!force) {
    const p = parse(raw);
    const others = allSkills().filter(o => o.status === 'active' && o.name !== name).map(o => ({ name: o.name, description: o.description }));
    const findings = lintSkill({ name, raw, meta: p.meta, body: p.body }, { others });
    if (findings.some(f => f.level === 'bad')) throw lintBlocked(findings);
  }
  const dir = path.join(paths.data, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `SKILL.md.tmp-${process.pid}`);
  fs.writeFileSync(tmp, raw);
  fs.renameSync(tmp, path.join(dir, 'SKILL.md'));
  return setSkill(name, true, actorId, { force: true }); // linted just above (or forced)
}

export function deleteSkill(name) {
  const s = skillByName(name);
  if (s.origin !== 'yours') throw invalid({ name: 'Built-in skills can be switched off, not deleted.' });
  fs.rmSync(s.dir, { recursive: true, force: true });
  run('DELETE FROM skills WHERE name = ?', s.name);
  run('DELETE FROM skill_proposals WHERE name = ?', s.name); // a deleted draft is gone, and its name is free again
}

/** For the prompt: one line per usable skill. */
export function skillsBlock(user, toolsets) {
  return skillsBlockOf(skillsFor(user, toolsets));
}
/** The skills block for a given list of skills (the trigger test builds it with a skill still in review). */
export function skillsBlockOf(list) {
  if (!list.length) return null;
  return `## Skills (know-how for kinds of tasks)\nWhen a request matches one, call use_skill with its name first and follow it.\n${list.map(s => `- ${s.name}: ${s.description}`).join('\n')}`;
}

// ---- Supporting files (#172): what use_skill may open ----------------------------------------------------------------
/** The supporting files Jess may open for a skill: top-level .md/.txt files, not licence/notice files (skill-lint.js), and
 *  not one over the size cap (the review assistant tells the admin to split it). */
export const openableFiles = s => s.fileBufs.filter(f => openableFile(f.name) && f.buf.toString('utf8').length <= SUPPORT_TEXT_MAX).map(f => f.name);

/** One supporting file's text, from the bytes allSkills() read and checksummed (so it is exactly what the admin approved
 *  while the skill is active). Only a name on the openable list, verbatim: no separators, no "..", nothing unlisted. */
export function skillFileText(s, file) {
  const name = String(file ?? '');
  if (!name || /[/\\]/.test(name) || name.includes('..') || name.includes('\0')) throw invalid({ file: 'Give just the file’s name, as listed.' });
  const f = s.fileBufs.find(x => x.name === name && openableFile(x.name));
  const text = f ? f.buf.toString('utf8') : null;
  if (text != null && text.length > SUPPORT_TEXT_MAX) throw invalid({ file: `“${name}” is ${text.length.toLocaleString('en')} characters; supporting files open up to ${SUPPORT_TEXT_MAX.toLocaleString('en')}. The admin should split it.` });
  if (text == null) {
    const listed = openableFiles(s);
    throw invalid({ file: listed.length ? `Not one of this skill’s files. It has: ${listed.join(', ')}.` : 'This skill has no supporting files.' });
  }
  return text;
}

// ---- Skills Jess drafts (#171): skill_propose → review, never active --------------------------------------------------
export const PROPOSAL_BODY_MAX = 8000;
const TEST_MAX = 5, TEST_CHARS = 300, WHY_MAX = 500;

// The newest proposal row per skill name (a database without migration 042 yet, e.g. `npm run doctor` before a start: none).
function latestProposals() {
  try {
    return new Map(all(`SELECT p.* FROM skill_proposals p JOIN (SELECT name, MAX(id) AS id FROM skill_proposals GROUP BY name) l ON l.id = p.id`).map(r => [r.name, r]));
  } catch (err) {
    if (/no such table/i.test(err.message)) return new Map();
    throw err;
  }
}

const cleanList = (v, field, errors, { min = 0 } = {}) => {
  if (v != null && !Array.isArray(v)) { errors[field] = 'A list of requests, as someone would type them.'; return []; }
  const list = [...new Set([].concat(v || []).map(x => String(x ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean))];
  if (list.length < min) errors[field] = `At least ${min}: a realistic request that should open this skill.`;
  else if (list.length > TEST_MAX) errors[field] = `At most ${TEST_MAX}.`;
  else if (list.some(x => x.length > TEST_CHARS)) errors[field] = `Keep each under ${TEST_CHARS} characters.`;
  return list;
};

/** May this person's Jess write over the folder `name` in data/skills? Only a draft Jess proposed whose folder is still
 *  exactly what she proposed (an admin's edit makes it theirs), proposed by this person, or this person is an admin. */
function ownDraft(list, name, user) {
  const s = list.find(x => x.name === name && x.origin === 'yours');
  if (!s) return { exists: false };
  const p = s.proposal;
  const mine = !!p && p.checksum === s.checksum && (p.proposer_id === user.id || user.role === 'admin');
  return { exists: true, mine, skill: s };
}

/**
 * Jess drafts a skill for the admin's review. Writes data/skills/<name>/SKILL.md WITHOUT approving it (so it is `review`,
 * or stays `review` when it replaces an earlier draft), keeps who/where/why and the test requests in skill_proposals, and
 * tells the admins. Refuses (field errors, or 409 lint_bad with `findings`): a bad name, a description over 400, an unknown
 * toolset, a body over 8,000, missing tests, a built-in's name or someone else's skill, links she'd be told to open, text
 * addressed to an AI, secrets, and anything the review assistant finds serious. The caller checks the run's taint.
 * → { skill (skillView), updated, warnings: [finding], notified: n }
 */
export function proposeSkill({ name, description, toolsets = [], body, tests, nearMisses, why = '' }, { user, threadId = null, runId = null }) {
  const errors = {};
  const n = String(name || '').trim();
  const desc = String(description || '').replace(/\s+/g, ' ').trim();
  const text = String(body || '').trim();
  const sets = [...new Set([].concat(toolsets || []).map(String))];
  if (!NAME.test(n)) errors.name = 'Lowercase words joined by dashes, e.g. school-lunch-order.';
  if (!desc) errors.description = 'What it’s for and when to use it, in the words people say.';
  else if (desc.length > DESCRIPTION_MAX) errors.description = `Keep it under ${DESCRIPTION_MAX} characters (it’s ${desc.length}): it sits in every prompt.`;
  const unknown = sets.filter(t => !TOOLSETS[t]);
  if (unknown.length) errors.toolsets = `Unknown toolset${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Known: ${Object.keys(TOOLSETS).join(', ')}.`;
  if (!text) errors.body = 'The steps.';
  else if (text.length > PROPOSAL_BODY_MAX) errors.body = `Keep a draft under ${PROPOSAL_BODY_MAX.toLocaleString('en')} characters (it’s ${text.length.toLocaleString('en')}).`;
  const positives = cleanList(tests, 'tests', errors, { min: 1 });
  const negatives = cleanList(nearMisses, 'near_misses', errors);
  const reason = String(why || '').replace(/\s+/g, ' ').trim();
  if (reason.length > WHY_MAX) errors.why = `Keep it under ${WHY_MAX} characters.`;
  const list = allSkills();
  if (!errors.name) {
    if (fs.existsSync(path.join(paths.skills, n))) errors.name = 'A built-in skill has that name. Built-in skills change only with Jessbot’s updates: pick another name for your version.';
    else {
      const d = ownDraft(list, n, user);
      if (d.exists && !d.mine) errors.name = 'A skill of this install already has that name (the admin’s, or someone else’s draft). Pick another name.';
    }
  }
  if (Object.keys(errors).length) throw invalid(errors);

  const all3 = [desc, text, ...positives, ...negatives].join('\n');
  const links = urlFetchLines(text);
  if (links.length) throw invalid({ body: `Line ${links[0].line} sends ${botName()} to a web address (“${links[0].excerpt}”). A drafted skill can’t: what a page says later would become the steps. Name the site in words and search for it when the skill runs.` });
  if (looksLikeInjection(all3)) throw invalid({ body: `Part of it reads like instructions to an AI assistant (“ignore previous instructions”, “assistant: send…”). Write the steps plainly, to ${botName()}.` });
  if (findShapes(all3).length || secretsIn(all3).length) throw invalid({ body: 'It contains a password, key, code or card number. A skill never holds secrets.' });

  const raw = skillFile({ name: n, description: desc, toolsets: sets, body: text });
  const p = parse(raw);
  const others = list.filter(o => o.status === 'active' && o.name !== n).map(o => ({ name: o.name, description: o.description }));
  const findings = lintSkill({ name: n, raw, meta: p.meta, body: p.body }, { others });
  const bad = findings.filter(f => f.level === 'bad');
  if (bad.length) {
    const err = new HttpError(409, `The review assistant found ${bad.length === 1 ? 'something serious' : `${bad.length} serious things`}: `
      + bad.map(f => `line ${f.line}: ${f.message} (“${f.excerpt}”)`).join(' '), { code: 'lint_bad' });
    err.findings = bad;
    throw err;
  }

  const dir = path.join(paths.data, 'skills', n);
  const file = path.join(dir, 'SKILL.md');
  const updated = fs.existsSync(file);
  if (updated && fs.readFileSync(file, 'utf8') === raw) throw invalid({ body: 'That is exactly the draft already waiting; nothing changed.' });
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `SKILL.md.tmp-${process.pid}`);
  fs.writeFileSync(tmp, raw);
  fs.renameSync(tmp, file);
  const checksum = folderChecksum(folderFiles(dir));
  run(`INSERT INTO skill_proposals (name, proposer_id, thread_id, run_id, why, tests, near_misses, checksum, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    n, user.id, threadId, runId, reason, JSON.stringify(positives), JSON.stringify(negatives), checksum, raw);
  audit('skill.propose', { actorId: user.id, targetType: 'skill', targetId: n, detail: { updated, runId, checksum: checksum.slice(0, 12) } });

  // The admins hear about it (the proposer, if an admin, is told in the chat). A toast or push now, and a line in their
  // activity so it isn't lost when they weren't looking.
  const href = `/admin/skills#${n}`;
  const admins = listUsers().filter(u => u.role === 'admin' && u.status === 'active' && u.id !== user.id);
  for (const a of admins) {
    const title = `${updated ? 'An updated skill' : 'A new skill'} to review: “${n}”`;
    notify(a.id, { kind: 'skill', title, body: `Drafted by ${botName()} with ${user.name}. ${desc}`, href, tag: `skill-${n}-${checksum.slice(0, 8)}` });
    logActivity(a.id, { kind: 'task', icon: 'notebook-pen', title, detail: `Drafted by ${botName()} with ${user.name}`, status: 'warn', href });
  }
  return { skill: skillView(skillByName(n)), updated, warnings: findings.filter(f => f.level === 'warn'), notified: admins.length };
}

/** The proposal behind a skill, for the review screen (null when Jess didn't draft it). `current`: the folder is still
 *  exactly what she proposed (false once the admin edited it). The chat is named only to the person it belongs to. */
export function proposalView(s, viewer = null) {
  const p = s.proposal;
  if (!p) return null;
  const by = p.proposer_id ? get('SELECT id, name FROM users WHERE id = ?', p.proposer_id) : null;
  const thread = p.thread_id ? get('SELECT id, user_id, kind, title FROM threads WHERE id = ?', p.thread_id) : null;
  const theirs = !!thread && !!viewer && thread.user_id === viewer.id;
  const count = get('SELECT COUNT(*) AS n FROM skill_proposals WHERE name = ?', s.name).n;
  return {
    by: by ? { id: by.id, name: by.name } : null, at: p.created_at ? new Date(`${p.created_at.replace(' ', 'T')}Z`).toISOString() : null,
    why: p.why || '', tests: JSON.parse(p.tests || '[]'), nearMisses: JSON.parse(p.near_misses || '[]'), runId: p.run_id, current: p.checksum === s.checksum,
    thread: thread ? { id: thread.id, href: theirs ? `/chat/${thread.id}` : null, title: theirs ? (thread.kind === 'main' ? 'Main chat' : thread.title || 'Side chat') : null, own: theirs } : null,
    versions: count,
  };
}

// ---- Usage (#121): use_skill calls per skill, from the stored tool calls ---------------------------------------------
/** Map name → { count (last `days` days), lastUsedAt (ever, ISO) }. A call is counted once it ran (it has a tool result). */
export function skillUsage({ days = 30 } = {}) {
  const rows = all(`SELECT json_extract(json_extract(j.value, '$.function.arguments'), '$.name') AS name,
      SUM(m.created_at >= datetime('now', ?)) AS n, MAX(m.created_at) AS last
    FROM messages m
    JOIN messages a ON a.run_id = m.run_id AND a.role = 'assistant' AND a.tool_calls IS NOT NULL
    JOIN json_each(a.tool_calls) j ON json_extract(j.value, '$.id') = m.tool_call_id
    WHERE m.role = 'tool' AND m.tool_name = 'use_skill' AND json_valid(json_extract(j.value, '$.function.arguments'))
    GROUP BY name`, `-${Math.max(1, Math.round(days))} days`);
  return new Map(rows.filter(r => r.name).map(r => [String(r.name), { count: r.n || 0, lastUsedAt: r.last ? new Date(`${r.last.replace(' ', 'T')}Z`).toISOString() : null }]));
}

// ---- Review (#121): what changed since approval, and what the review assistant found ---------------------------------
/** Line diff between the approved SKILL.md and the current one, plus supporting files added/removed/changed.
 *  { available, reason?, approvedAt, added, removed, hunks: [{ oldStart, oldLines, newStart, newLines, lines: ['+…','-…',' …'] }], files } */
export function changesSinceApproval(s) {
  if (s.approvedBody == null) {
    return { available: false, reason: s.approvedAt ? 'approved-before-copies' : 'never-approved', approvedAt: s.approvedAt, added: 0, removed: 0, hunks: [], files: [] };
  }
  const patch = structuredPatch('SKILL.md', 'SKILL.md', s.approvedBody.replace(/\r\n/g, '\n'), s.raw.replace(/\r\n/g, '\n'), '', '', { context: 3 });
  const lines = patch.hunks.flatMap(h => h.lines);
  const files = [];
  if (s.approvedFiles) {
    const now = s.fileHashes;
    for (const [f, h] of Object.entries(now)) if (f !== 'SKILL.md' && s.approvedFiles[f] !== h) files.push({ name: f, change: f in s.approvedFiles ? 'changed' : 'added' });
    for (const f of Object.keys(s.approvedFiles)) if (!(f in now)) files.push({ name: f, change: 'removed' });
  }
  return { available: true, approvedAt: s.approvedAt, added: lines.filter(l => l[0] === '+').length, removed: lines.filter(l => l[0] === '-').length,
    hunks: patch.hunks.map(h => ({ oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines: h.lines })),
    files: files.sort((a, b) => a.name.localeCompare(b.name)) };
}

/** Everything the admin's review screen needs for one skill. */
export function skillReview(name, viewer = null) {
  const list = allSkills();
  const s = list.find(x => x.name === String(name));
  if (!s) throw notFound('No such skill.');
  const findings = lintOf(s, list);
  return { skill: skillView(s), raw: s.raw, findings, summary: lintSummary(findings), changes: changesSinceApproval(s),
    usage: skillUsage().get(s.name) || { count: 0, lastUsedAt: null }, proposal: proposalView(s, viewer), examples: s.examples,
    triggerQueries: triggerQueriesOf(s) };
}

/** The requests the trigger test runs when the admin types none: the proposal's tests and near-misses, else the skill's
 *  own `examples:`. → [{ text, expect: 'use'|'skip' }] */
export function triggerQueriesOf(s) {
  const p = s.proposal;
  const use = p ? JSON.parse(p.tests || '[]') : s.examples?.positive || [];
  const skip = p ? JSON.parse(p.near_misses || '[]') : s.examples?.negative || [];
  return [...use.map(text => ({ text, expect: 'use' })), ...skip.map(text => ({ text, expect: 'skip' }))];
}

export const skillView = s => ({ name: s.name, description: s.description, toolsets: s.toolsets, origin: s.origin, status: s.status,
  problems: s.problems, license: s.license, approvedAt: s.approvedAt, files: s.files, lines: s.body.split('\n').length,
  proposed: !!s.proposal && s.proposal.checksum === s.checksum,
  // Phase 25 (#195): its category (the list's filter) and whether it's in the recommended core set.
  category: s.origin === 'yours' ? 'yours' : categoryOf(s.name), recommended: s.origin === 'built-in' && RECOMMENDED.includes(s.name) });

// ---- The review screen (Phase 25, decision #195) ------------------------------------------------------------------------
// A step that uses tools outside the skill's toolsets works for people who have them: shown as "Optional tools", not as a
// warning. Everything else keeps the review assistant's level.
const OPTIONAL_CODES = new Set(['undeclared-toolset']);
export const findingGroup = f => (OPTIONAL_CODES.has(f.code) ? 'optional' : f.level);
/** Counts for the screens: { bad, warn, optional, info } (a warning that is only an optional tool isn't counted as one). */
export const reviewSummary = findings => findings.reduce((s, f) => ({ ...s, [findingGroup(f)]: s[findingGroup(f)] + 1 }), { bad: 0, warn: 0, optional: 0, info: 0 });
export const categoryLabel = key => (key === 'yours' ? 'Yours' : CATEGORIES.find(c => c.key === key)?.label || 'Other');

/** The review page's model: skillReview plus the findings grouped for reading and the labels the page shows. */
export function reviewPage(name, viewer = null) {
  const r = skillReview(name, viewer);
  const groups = [['bad', 'Serious', 'Read these before approving: approving needs "Approve anyway".'],
    ['warn', 'Worth a look', 'Things that can make the skill fail or pick the wrong moment.'],
    ['optional', 'Optional tools', 'Steps that use tools some people may not have. They still work for everyone who has them.'],
    ['info', 'Notes', 'Small things, nothing that stops it working.']]
    .map(([key, label, hint]) => ({ key, label, hint, items: r.findings.filter(f => findingGroup(f) === key) })).filter(g => g.items.length);
  return { ...r, groups, summary: reviewSummary(r.findings), categoryLabel: categoryLabel(r.skill.category) };
}
export const skillsNeedingReview = () => allSkills().filter(s => s.status === 'review').length;
export const brokenSkills = () => allSkills().filter(s => s.status === 'broken');
/** Active skills whose review finds something serious: [{ name, bad: [finding] }] (the doctor warns about them). */
export function riskyActiveSkills() {
  const list = allSkills();
  return list.filter(s => s.status === 'active').map(s => ({ name: s.name, bad: lintOf(s, list).filter(f => f.level === 'bad') })).filter(x => x.bad.length);
}
