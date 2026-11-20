// ask_user (decision #20): structured questions that pause a run until answered. Stored → survive refresh.
import { get, all, run } from '../db/index.js';
import { invalid, notFound } from '../lib/errors.js';

const KINDS = new Set(['single', 'multi', 'yesno', 'text', 'longtext']);
const slug = (s, i) => String(s || `q${i + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || `q${i + 1}`;

// Normalize what the model proposed into the ask-dock contract (defensive: never trust tool args' shape).
export function normalizeQuestions(input) {
  const qs = (Array.isArray(input) ? input : []).slice(0, 4).map((q, i) => {
    const kind = KINDS.has(q?.kind) ? q.kind : (q?.options?.length ? 'single' : 'text');
    let options = (Array.isArray(q?.options) ? q.options : []).slice(0, 9).map((o, j) => ({
      value: slug(o?.value || o?.label, j), label: String(o?.label || o?.value || `Option ${j + 1}`).slice(0, 80),
      description: o?.description ? String(o.description).slice(0, 160) : undefined,
      recommended: !!o?.recommended, preview: o?.preview ? String(o.preview).slice(0, 2000) : undefined,
    }));
    if (kind === 'yesno' && !options.length) options = [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];
    return {
      id: slug(q?.id || q?.header, i), header: String(q?.header || `Question ${i + 1}`).slice(0, 18),
      question: String(q?.question || '').slice(0, 300) || 'Could you tell me more?',
      kind, options, allowOther: kind === 'single' || kind === 'multi' ? q?.allowOther !== false : false,
      placeholder: q?.placeholder ? String(q.placeholder).slice(0, 80) : undefined,
    };
  });
  // Unique ids
  const seen = new Set();
  for (const q of qs) { let id = q.id, n = 2; while (seen.has(id)) id = `${q.id}-${n++}`; q.id = id; seen.add(id); }
  return qs;
}

/** image: a screenshot path set by the server (never by the model) — what Jess is looking at while she asks. */
export function createQuestion({ runId, threadId, userId, toolCallId, questions, image = null }) {
  const qs = normalizeQuestions(questions);
  if (!qs.length) throw invalid({ questions: 'No questions to ask.' });
  if (image && /^\/shots\/[\w.-]+$/.test(image)) qs[0].image = image;
  const { lastInsertRowid } = run(`INSERT INTO questions (run_id, thread_id, user_id, tool_call_id, questions) VALUES (?, ?, ?, ?, ?)`,
    runId, threadId, userId, toolCallId, JSON.stringify(qs));
  return getQuestion(Number(lastInsertRowid));
}

export function getQuestion(id) {
  const q = get('SELECT * FROM questions WHERE id = ?', id);
  return q ? { ...q, questions: JSON.parse(q.questions), answers: q.answers ? JSON.parse(q.answers) : null } : null;
}

export const pendingForRun = runId => get(`SELECT id FROM questions WHERE run_id = ? AND status = 'pending'`, runId)?.id;
export const questionsOfRun = runId => all('SELECT id FROM questions WHERE run_id = ? ORDER BY id', runId).map(r => getQuestion(r.id));

// Validate answers against the stored questions; returns the normalized answers + a readable text for the model.
export function validateAnswers(q, answers) {
  const byId = new Map((Array.isArray(answers) ? answers : []).map(a => [a?.questionId, a]));
  const out = [];
  for (const item of q.questions) {
    const a = byId.get(item.id);
    const values = [].concat(a?.value ?? []).map(String).filter(Boolean);
    const allowed = new Set([...item.options.map(o => o.value), ...(item.allowOther ? ['__other__'] : [])]);
    if (item.kind === 'text' || item.kind === 'longtext') {
      const v = String(a?.value ?? '').trim();
      if (!v) throw invalid({ [item.id]: 'Please answer this one.' });
      out.push({ questionId: item.id, value: v.slice(0, 2000) });
      continue;
    }
    if (!values.length || values.some(v => !allowed.has(v))) throw invalid({ [item.id]: 'Please pick an option.' });
    if (item.kind !== 'multi' && values.length > 1) throw invalid({ [item.id]: 'Pick just one.' });
    const other = values.includes('__other__') ? String(a?.other || '').trim().slice(0, 500) : undefined;
    if (values.includes('__other__') && !other) throw invalid({ [item.id]: 'Type your own answer.' });
    out.push({ questionId: item.id, value: item.kind === 'multi' ? values : values[0], ...(other ? { other } : {}) });
  }
  return out;
}

// Human-readable answers (history card) and the text the model receives as the tool result.
export function describeAnswers(q) {
  const byId = new Map((q.answers || []).map(a => [a.questionId, a]));
  return q.questions.map(item => {
    const a = byId.get(item.id);
    const label = v => (v === '__other__' ? a.other : item.options.find(o => o.value === v)?.label || v);
    const display = !a ? '—' : Array.isArray(a.value) ? a.value.map(label).join(', ') : item.options.length ? label(a.value) : a.value;
    return { header: item.header, question: item.question, display };
  });
}

export function saveAnswers(id, answers) {
  run(`UPDATE questions SET answers = ?, status = 'answered', answered_at = datetime('now') WHERE id = ?`, JSON.stringify(answers), id);
  return getQuestion(id);
}

export const expireQuestion = id => run(`UPDATE questions SET status = 'expired' WHERE id = ? AND status = 'pending'`, id);

// Card/dock view (partials/chat/question-card + ask-dock contract).
export function questionView(q) {
  if (!q) return null;
  return {
    id: q.id, status: q.status, askedAt: q.created_at, answerUrl: `/api/v1/questions/${q.id}/answer`,
    questions: q.questions, answers: q.status === 'answered' ? describeAnswers(q) : null,
  };
}

export function questionForUser(id, user) {
  const q = getQuestion(Number(id));
  if (!q || q.user_id !== user.id) throw notFound('That question is no longer open.');
  return q;
}
