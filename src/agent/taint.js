// Run taint (Phase 18, decision #119): a record, per run, of the outside content it read — so approvals can tell a task
// that only talked with the person from one that read a stranger's page or email first.
//   low  = read outside content (web, browser, email, calendar, files)
//   high = some of it was caught addressing AI assistants (src/agent/injection.js)
// Stored in run_taint (migration 030), so it survives a restart while a run waits for an approval.
import { all, run } from '../db/index.js';

export const TAINT_LEVELS = ['none', 'low', 'high'];
const rank = level => Math.max(0, TAINT_LEVELS.indexOf(level));

/**
 * Note that run `runId` read outside content. source: { tool, label }. Returns true the first time this (level, tool,
 * label) is recorded for the run — callers use that to write one audit event, not one per step.
 */
export function markRunTaint(runId, level, { tool, label } = {}) {
  if (!runId || !['low', 'high'].includes(level)) return false;
  const res = run('INSERT OR IGNORE INTO run_taint (run_id, level, tool, label) VALUES (?, ?, ?, ?)',
    Number(runId), level, String(tool || 'unknown').slice(0, 60), String(label || 'outside content').slice(0, 200));
  return res.changes > 0;
}

/** { level: 'none'|'low'|'high', sources: [{ tool, label, level, at }] } for a run (oldest first). */
export function taintOf(runId) {
  const sources = runId ? all('SELECT tool, label, level, at FROM run_taint WHERE run_id = ? ORDER BY id', Number(runId)).map(r => ({ ...r })) : [];
  const level = sources.reduce((max, s) => (rank(s.level) > rank(max) ? s.level : max), 'none');
  return { level, sources };
}

/** Is the run at least this tainted? isTainted(id) → read anything outside; isTainted(id, 'high') → suspected injection. */
export const isTainted = (runId, level = 'low') => rank(taintOf(runId).level) >= rank(level);

// Tools whose results are outside content. Most go through guardOutside (agent/injection.js), which marks the run with
// a precise label ("email from … · “subject”"); the loop marks the rest here after they run (agent/loop.js), so a stored
// result reopened, an image looked at, a PDF's fields or a project's file list count too (the rule the project-soul guard
// used before, #93, minus the tools that only send: email_send and calendar changes bring nothing in). Only a tool with no
// row yet in this run gets the generic label.
export const OUTSIDE_TOOLS = /^(?!email_send$|calendar_(?:create|update)_event$)(web_|browser_|email_|calendar_|library_read|read_offloaded|pdf_|project_files|project_search|view_image)/;
const GENERIC = [[/^read_offloaded$/, 'a stored result'], [/^view_image$/, 'an image'], [/^pdf_/, 'a PDF'], [/^project_files$/, 'a project’s file list'],
  [/^email_/, 'email'], [/^calendar_/, 'their calendar'], [/^(web_|browser_)/, 'a web page'], [/./, 'outside content']];

/** After a tool ran in run `runId`: mark it as having read outside content when the tool is one that reads it. */
export function noteToolRead(runId, toolName) {
  if (!runId || !OUTSIDE_TOOLS.test(toolName || '')) return false;
  if (taintOf(runId).sources.some(s => s.tool === toolName)) return false;
  return markRunTaint(runId, 'low', { tool: toolName, label: GENERIC.find(([re]) => re.test(toolName))[1] });
}

/** "Suggested after reading: email from Ann <a@x> · “Invoice” · page on example.com" — or null for an untainted run. */
export function provenanceOf(runId, { max = 3 } = {}) {
  const labels = [...new Set(taintOf(runId).sources.map(s => s.label))];
  if (!labels.length) return null;
  const more = labels.length > max ? ` and ${labels.length - max} more` : '';
  return `Suggested after reading: ${labels.slice(0, max).join(' · ')}${more}`;
}
