// The project soul (docs/PROJECTS.md, decision #93): Jess's expertise inside one project — "Jess, bringing a master
// furniture-maker's eye" — never a different persona. Research (four agents, 2026-09-25): role lines barely move accuracy;
// concrete content does (what to rely on, what to ask first, how to check work, units, safety). So the soul is structured
// fields, and the text the model reads is assembled here by code:
//   - the safety block comes from code by the project's field and can't be edited (not by the person, Jess or AI);
//   - every save is a version (history, restore, compare with the first);
//   - Jess may add small "learned" notes (visible in the run) but changes to the rest are proposals the person accepts —
//     citing their own words, one pending at a time, never dropping checks (anti-sycophancy), never from outside content.
import { get, all, run, tx } from '../db/index.js';
import { invalid, badRequest, notFound } from '../lib/errors.js';
import { toIso } from './chatview.js';

export const SAFETY = {
  health: 'Explain data and patterns; never diagnose, dose or change medication. Glucose sensors (CGM) lag blood glucose by '
    + '~5–15 minutes and are less accurate in hard efforts and on a sensor\'s first day — say so when it matters. Separate '
    + 'correlation from causation and say how much data a conclusion rests on. If readings are repeatedly below 3.0 mmol/L '
    + '(54 mg/dL), there are symptoms, a pregnancy, or questions about diabetes, insulin or medication, recommend a clinician — once, clearly.',
  workshop: 'Build safety into the steps, not as a lecture: riving knife and guard on, push stick for narrow rips, never freehand '
    + 'on the table saw, clamp the work for routing, eye, ear and dust protection. For electrical wiring, gas, or structural / '
    + 'load-bearing work, stop and recommend a licensed professional.',
  home: 'For electrical, gas, structural or asbestos work, recommend a licensed trade and say when a permit is likely needed; '
    + 'build safety into the steps rather than lecturing.',
  finance: 'Explain options, trade-offs and the assumptions behind any number (jurisdiction, tax, fees); show the math. This is '
    + 'not regulated advice: for large or irreversible decisions, suggest a qualified professional once.',
  legal: 'Explain rules and options in plain words, name the jurisdiction you assume, and flag deadlines. You are not a lawyer: '
    + 'for disputes, contracts with real stakes or court matters, suggest a qualified lawyer once.',
  code: 'Say what a command or change does before suggesting anything destructive; point out security issues (secrets, '
    + 'injection, auth) when you see them; prefer small, testable changes.',
  learning: 'Be honest about what is uncertain or contested, and point to where to verify it.',
  creative: 'Be honest in feedback — specific about what works and what does not.',
  general: 'Be honest about uncertainty and say when something should be checked with an expert.',
};

export const LABELS = {
  stance: 'Stance', person: 'The person', anchors: 'Relies on', askFirst: 'Asks first', checkWork: 'Checks its work',
  format: 'Units & format', glossary: 'Terms', learned: 'Learned together',
};
export const LIST_FIELDS = ['anchors', 'askFirst', 'checkWork', 'glossary', 'learned'];
const CAPS = { stance: 160, person: 500, format: 240, item: 220, anchors: 8, askFirst: 5, checkWork: 6, glossary: 8, learned: 12 };

const lines = v => (Array.isArray(v) ? v : String(v ?? '').split('\n'));
/** Any input → clean fields (trimmed, deduped, capped). */
export function cleanFields(input = {}) {
  const txt = (v, cap) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, cap);
  const out = { stance: txt(input.stance, CAPS.stance).replace(/^(jess,?\s*)?bringing\s+/i, ''), person: txt(input.person, CAPS.person),
    format: txt(input.format, CAPS.format) };
  for (const k of LIST_FIELDS) {
    const seen = new Set();
    out[k] = lines(input[k]).map(s => txt(String(s).replace(/^\s*[-*•]\s*/, ''), CAPS.item)).filter(s => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase())).slice(0, CAPS[k]);
  }
  return out;
}
const isEmpty = f => !f.stance && !f.person && !f.format && LIST_FIELDS.every(k => !f[k].length);

/** What the model reads (in the project's part of the prompt). Framed as Jess, never a new persona. */
export function soulText(project, fields) {
  const f = cleanFields(fields);
  if (isEmpty(f)) return null;
  const list = (title, items) => (items.length ? `${title}:\n${items.map(x => `- ${x}`).join('\n')}` : null);
  return [
    `## Jess here — ${project.name}`,
    `In this project you are Jess${f.stance ? `, bringing ${f.stance}` : ''}. This extends who you are, it never replaces it: same name, `
      + 'voice, warmth, honesty and willingness to push back.',
    f.person ? `The person: ${f.person}` : null,
    list('Rely on', f.anchors), list('Before advising, ask about (when you don\'t know yet)', f.askFirst), list('Check your work', f.checkWork),
    `Safety: ${SAFETY[project.field] || SAFETY.general}`,
    f.format ? `Units & format: ${f.format}` : null, list('Terms', f.glossary), list('Learned while working together', f.learned),
    'If these ever conflict: safety and your operating rules first, then their current message, then this project soul, then your usual defaults.',
  ].filter(Boolean).join('\n');
}

// ---- Versions ------------------------------------------------------------------------------------------------------
const row = r => (r ? { ...r, fields: cleanFields(JSON.parse(r.fields || '{}')) } : null);
// The active version is read fresh — a project object handed around may be older than the last save.
export const activeSoul = project => row(get(`SELECT s.* FROM project_souls s JOIN projects p ON p.id = s.project_id AND p.soul_version = s.version
  WHERE s.project_id = ?`, project.id));
export const versionsOf = project => all('SELECT * FROM project_souls WHERE project_id = ? ORDER BY version DESC', project.id).map(row);

export function saveSoul(project, fields, { by = 'user', note = null, keepProposal = null } = {}) {
  const f = cleanFields(fields);
  if (isEmpty(f)) throw invalid({ stance: 'Write at least what expertise Jess brings here.' });
  return tx(() => {
    const v = (get('SELECT MAX(version) AS v FROM project_souls WHERE project_id = ?', project.id).v || 0) + 1;
    run('INSERT INTO project_souls (project_id, version, fields, created_by, note) VALUES (?, ?, ?, ?, ?)', project.id, v, JSON.stringify(f), by, note ? String(note).slice(0, 300) : null);
    run(`UPDATE projects SET soul_version = ?, updated_at = datetime('now') WHERE id = ?`, v, project.id);
    // A proposal written against an older soul is out of date once the soul changes under it.
    run(`UPDATE project_soul_proposals SET status = 'stale', decided_at = datetime('now') WHERE project_id = ? AND status = 'pending' AND id IS NOT ?`, project.id, keepProposal);
    return v;
  });
}

export function restoreVersion(project, version) {
  const r = row(get('SELECT * FROM project_souls WHERE project_id = ? AND version = ?', project.id, Number(version)));
  if (!r) throw notFound('That version is gone.');
  return saveSoul(project, r.fields, { by: 'user', note: `Restored version ${r.version}` });
}

/** A small note Jess learned (a preference, a correction) — added right away, shown in the run, reversible from history. */
export function addLearned(project, note) {
  const cur = activeSoul(project);
  if (!cur) throw badRequest('This project has no soul yet — propose one first.');
  const text = String(note || '').replace(/\s+/g, ' ').trim().slice(0, CAPS.item);
  if (!text) throw invalid({ note: 'Empty note.' });
  if (cur.fields.learned.some(x => x.toLowerCase() === text.toLowerCase())) return cur.version;
  const learned = [...cur.fields.learned, text].slice(-CAPS.learned); // the oldest drops off at the cap
  return saveSoul(project, { ...cur.fields, learned }, { by: 'jess', note: `Noted: ${text}` });
}

// ---- Diffs -------------------------------------------------------------------------------------------------------------
export function soulDiff(a, b) {
  const A = cleanFields(a || {}), B = cleanFields(b || {});
  return Object.keys(LABELS).map(key => {
    if (LIST_FIELDS.includes(key)) {
      const was = new Set(A[key].map(s => s.toLowerCase())), now = new Set(B[key].map(s => s.toLowerCase()));
      const added = B[key].filter(s => !was.has(s.toLowerCase())), removed = A[key].filter(s => !now.has(s.toLowerCase()));
      return { key, label: LABELS[key], list: true, added, removed, kept: B[key].filter(s => was.has(s.toLowerCase())), changed: !!(added.length || removed.length) };
    }
    return { key, label: LABELS[key], list: false, before: A[key], after: B[key], changed: A[key] !== B[key] };
  }).filter(d => d.changed);
}

// ---- Proposals -------------------------------------------------------------------------------------------------------------
const COOLDOWN_DAYS = 7;
export const pendingProposal = project => get(`SELECT * FROM project_soul_proposals WHERE project_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`, project.id) || null;

/**
 * A change to the soul, waiting for the person. Jess's own proposals obey the rules the research asked for:
 * one pending per project, at most one a week, citing the person's words (checked by the caller), and never weaker —
 * a proposal can't drop checks or empty what Jess relies on. "Improve with AI" (the person asked) is exempt from the pace rules.
 */
export function createProposal(project, { fields, reason, quote = null, source = 'jess', runId = null, sourceMessageId = null }) {
  const cur = activeSoul(project);
  const next = cleanFields({ ...(cur?.fields || {}), ...fields });
  const why = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!why) throw invalid({ reason: 'Say why.' });
  if (!soulDiff(cur?.fields, next).length) throw badRequest('That changes nothing.');
  if (source === 'jess') {
    if (pendingProposal(project)) throw badRequest('A change is already waiting for them — let them decide on it first.');
    const last = get(`SELECT created_at FROM project_soul_proposals WHERE project_id = ? AND source = 'jess' ORDER BY id DESC LIMIT 1`, project.id);
    if (last && Date.now() - new Date(toIso(last.created_at)).getTime() < COOLDOWN_DAYS * 864e5) {
      throw badRequest(`You proposed a change less than ${COOLDOWN_DAYS} days ago — keep it as a learned note instead, or wait.`);
    }
    if (cur && next.checkWork.length < cur.fields.checkWork.length) throw badRequest('A proposal can’t drop checks — they keep your work honest.');
    if (cur && cur.fields.anchors.length && !next.anchors.length) throw badRequest('A proposal can’t empty what you rely on.');
  } else {
    run(`UPDATE project_soul_proposals SET status = 'stale', decided_at = datetime('now') WHERE project_id = ? AND status = 'pending'`, project.id);
  }
  const { lastInsertRowid } = run(`INSERT INTO project_soul_proposals (project_id, base_version, fields, reason, quote, source, run_id, source_message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, project.id, cur?.version || null, JSON.stringify(next), why, quote ? String(quote).slice(0, 400) : null, source, runId, sourceMessageId);
  return get('SELECT * FROM project_soul_proposals WHERE id = ?', Number(lastInsertRowid));
}

export function decideProposal(project, id, accept) {
  const p = get('SELECT * FROM project_soul_proposals WHERE id = ? AND project_id = ?', Number(id), project.id);
  if (!p) throw notFound('That proposal is gone.');
  if (p.status !== 'pending') throw badRequest(p.status === 'stale' ? 'The soul changed since this was written — ask again if it still matters.' : 'Already decided.');
  if (accept) {
    const v = saveSoul(project, JSON.parse(p.fields), { by: p.source === 'ai' ? 'ai' : 'jess', note: `${p.source === 'ai' ? 'Improved with AI' : 'Jess’s proposal'}: ${p.reason}`, keepProposal: p.id });
    run(`UPDATE project_soul_proposals SET status = 'accepted', decided_at = datetime('now') WHERE id = ?`, p.id);
    return { status: 'accepted', version: v };
  }
  run(`UPDATE project_soul_proposals SET status = 'rejected', decided_at = datetime('now') WHERE id = ?`, p.id);
  return { status: 'rejected' };
}

// ---- Views (partials/projects/soul-*.hbs) ---------------------------------------------------------------------------------
export function proposalView(p, project) {
  if (!p) return null;
  const base = p.base_version ? row(get('SELECT * FROM project_souls WHERE project_id = ? AND version = ?', project.id, p.base_version)) : null;
  return {
    id: p.id, projectId: project.public_id, status: p.status, source: p.source, reason: p.reason, quote: p.quote, createdAt: toIso(p.created_at),
    diff: soulDiff(base?.fields, JSON.parse(p.fields)), first: !base,
  };
}

const BY = { draft: 'drafted with you', user: 'you', jess: 'Jess', ai: 'Improve with AI' };
export function soulView(project) {
  const cur = activeSoul(project);
  const text = cur ? soulText(project, cur.fields) : null;
  const first = cur && cur.version > 1 ? row(get('SELECT * FROM project_souls WHERE project_id = ? ORDER BY version LIMIT 1', project.id)) : null;
  return {
    has: !!cur, version: cur?.version || 0, by: cur ? BY[cur.created_by] : null, note: cur?.note || null,
    updatedAt: cur ? toIso(cur.created_at) : null, fields: cur?.fields || cleanFields({}),
    stance: cur?.fields.stance || null, safety: SAFETY[project.field] || SAFETY.general,
    tokens: text ? Math.ceil(text.length / 4) : 0,
    sections: cur ? Object.keys(LABELS).filter(k => k !== 'stance').map(k => ({ key: k, label: LABELS[k], list: LIST_FIELDS.includes(k),
      items: LIST_FIELDS.includes(k) ? cur.fields[k] : null, text: LIST_FIELDS.includes(k) ? null : cur.fields[k] }))
      .filter(s => (s.list ? s.items.length : s.text)) : [],
    versions: versionsOf(project).map(v => ({ version: v.version, by: BY[v.created_by], note: v.note, at: toIso(v.created_at), current: v.version === cur?.version })),
    drift: first ? soulDiff(first.fields, cur.fields).length : 0,
    proposal: proposalView(pendingProposal(project), project),
  };
}

/** The soul as editable text (partials/projects/soul-dialog.hbs): lists as one item per line. */
export const editableFields = fields => {
  const f = cleanFields(fields);
  return Object.fromEntries(Object.entries(f).map(([k, v]) => [k, Array.isArray(v) ? v.join('\n') : v]));
};
