// Phase 19 part A (decisions #128–#130, #148–#150): runs that finish and tell the truth. An approved call a restart cut
// off is an "outcome unknown" (never redone, never stuck waiting); Retry never redoes what an earlier attempt did; a new
// message closes a pending approval (deciding it later says so); unattended runs record their real outcome, get one retry
// after a passing failure and reach the person when they finally fail; a missed task is "skipped", not "ok"; a restart
// re-queues unattended work that changed nothing yet; watches check quietly (NOTE memo, NOTHING silent, failures counted,
// end date, unchanged page = no model call); and a scheduled task may end with one question (#83 as amended).
// Run: npm test (throwaway data dir; model calls go to a local fake OpenAI-compatible server, never the network).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { listen } from './helpers/listen.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-unit-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env'); // keys the code makes (secrets, VAPID) never land in the real .env
process.env.JESSBOT_EMBED_OFF = '1'; // no embedding calls from unit tests
process.env.JESSBOT_DECIDE_OFF = '1'; // no decision-model calls either: every use takes its fallback
process.env.OPENROUTER_KEY = 'sk-or-v1-unit-test-model-key-p19a-0123456789';

const { openDb, closeDb, run, get, all, settings } = await import('../src/db/index.js');
const { ensureDirs } = await import('../src/config/index.js');
ensureDirs();
await openDb();

const { createUser } = await import('../src/services/users.js');
const { registerTool, getTool: registryTool } = await import('../src/agent/tools/registry.js');
const { createApp } = await import('../src/app.js'); // registers the tools and configures the fragment renderer
createApp();
const policy = await import('../src/services/policy.js');
const approvals = await import('../src/services/approvals.js');
const schedules = await import('../src/services/schedules.js');
const threads = await import('../src/services/threads.js');
const runs = await import('../src/services/runs.js');
const { addMessage } = await import('../src/services/messages.js');
const { __test: promptTest, INTERRUPTED_UNKNOWN } = await import('../src/agent/prompt.js');
const loop = await import('../src/agent/loop.js');
const proactive = await import('../src/agent/proactive.js');

// ---- A local stand-in for the model ------------------------------------------------------------------------------------
// Every streamed call takes the next `script` item: { tool, args } (a tool call), { text } (a reply) or { error: status }
// (a provider error inside the stream, so the SDK doesn't retry it), optionally { delay: ms } before it answers; an empty
// script answers "Done.". Each call is recorded
// (its messages and the tool names it was offered).
const calls = [];
let script = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const j = JSON.parse(body || '{}');
    if (!j.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: 'fake', choices: [{ index: 0, finish_reason: 'stop',
        message: { role: 'assistant', content: '{}' } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
      return;
    }
    calls.push({ messages: j.messages, tools: (j.tools || []).map(t => t.function.name) });
    const next = script.shift() || { text: 'Done.' };
    if (next.delay) setTimeout(() => respond(res, next), next.delay);
    else respond(res, next);
  });
});
function respond(res, next) {
  const chunk = delta => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (next.error) res.write(`data: ${JSON.stringify({ error: { message: 'Provider returned error', code: next.error } })}\n\n`);
  else if (next.tool) res.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${calls.length}_${Math.random().toString(36).slice(2, 7)}`, type: 'function', function: { name: next.tool, arguments: JSON.stringify(next.args || {}) } }] }));
  else res.write(chunk({ role: 'assistant', content: next.text }));
  res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake', choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
  res.end('data: [DONE]\n\n');
}

// Test tools: an outward send (asks first) and a private note (runs at once), each counting real executions.
const executed = { send: 0, note: 0 };
registerTool({ name: 'test_send', toolset: 'core', risk: 'external', description: 'Send a test message out.', label: a => `Sent “${a.text || ''}”`,
  parameters: { type: 'object', properties: { text: { type: 'string' } } }, run: args => { executed.send++; return `Sent: ${args.text}`; } });
registerTool({ name: 'test_note', toolset: 'core', risk: 'write', description: 'Save a private test note.', label: a => `Saved the note “${a.text || ''}”`,
  parameters: { type: 'object', properties: { text: { type: 'string' } } }, run: args => { executed.note++; return `Saved note: ${args.text}`; } });
registerTool({ name: 'test_look', toolset: 'core', risk: 'read', description: 'Look something up.', label: () => 'Looked it up',
  parameters: { type: 'object', properties: {} }, run: () => 'Found: 3 flights.' });

let alice, bob;
before(async () => {
  alice = await createUser({ name: 'Alice Owner', email: 'alice@p19a.dev', password: 'correct horse battery', role: 'admin' });
  bob = await createUser({ name: 'Bob Member', email: 'bob@p19a.dev', password: 'correct horse battery' });
  // No quiet hours (start = end is an empty window) and no budget: nothing here may depend on the wall clock.
  for (const u of [alice, bob]) {
    policy.setPolicy('user', u.id, { toolsets: { core: 'allow', memory: 'allow', web: 'allow', schedule: 'allow' },
      quietStart: '12:00', quietEnd: '12:00', weeklyBudget: 0 }, alice.id);
  }
  await listen(fake);
  settings.set('llm', { baseUrl: `http://127.0.0.1:${fake.address().port}/v1`, model: 'fake/model' });
});
after(() => { proactive.__test.setWatchReader(null); fake.close(); closeDb(); fs.rmSync(HOME, { recursive: true, force: true }); });

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Wait for a run to reach one of `statuses`, then for every thread queue to drain: what follows a status change (the
// bubble render, pushes, the schedule's status) is written by then, however slow the machine is.
async function settle(runId, { statuses = ['done', 'error', 'cancelled', 'waiting'], ms = 15000 } = {}) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    await loop.drainRuns();
    const r = runs.getRun(runId);
    if (statuses.includes(r.status)) return r;
    await sleep(20);
  }
  throw new Error(`run ${runId} stuck in ${runs.getRun(runId).status}`);
}
// A fresh run in a fresh side chat, triggered by the person's message (or a hidden system text for unattended ones).
function newRun(user, text = 'Please help me with this.', { origin = 'chat', originLabel = null, scheduleId = null, role = 'user' } = {}) {
  const t = threads.createSideThread(user.id, 'Test chat');
  const m = addMessage({ threadId: t.id, role, content: text });
  return runs.createRun({ threadId: t.id, userId: user.id, triggerMessageId: m.id, model: 'fake/model', origin, originLabel, scheduleId });
}
const toolRows = runId => all(`SELECT tool_name, content FROM messages WHERE run_id = ? AND role = 'tool' ORDER BY id`, runId);
const notifies = user => all(`SELECT data FROM events WHERE user_id = ? AND type = 'notify' ORDER BY id`, user.id).map(e => JSON.parse(e.data));
const active = user => all(`SELECT id, status FROM runs WHERE user_id = ? AND status IN ('queued', 'running', 'waiting')`, user.id);
const reply = runId => { const r = runs.getRun(runId); return r.reply_message_id ? get('SELECT content FROM messages WHERE id = ?', r.reply_message_id).content : null; };
// A schedule whose next run is due now (or `lateMs` ago). Its daily time is 12 hours from now in the schedule's own time zone,
// so the tests that jump the clock ahead by minutes never also reach its next occurrence, whatever time they run (#57).
// cronAt(tz, date): the daily cron for that wall-clock minute in tz.
const cronAt = (tz, date) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(date).map(x => [x.type, x.value]));
  return `${Number(p.minute)} ${Number(p.hour)} * * *`;
};
function dueSchedule(user, fields = {}, lateMs = 60000) {
  const t = threads.createSideThread(user.id, 'Schedules');
  const s = schedules.createSchedule({ user, title: 'Morning brief', prompt: 'Brief me.', cron: '0 7 * * *', threadId: t.id, ...fields });
  const cron = fields.cron || cronAt(s.timezone, new Date(Date.now() + 12 * 3600e3));
  run('UPDATE schedules SET cron = ?, next_run_at = ? WHERE id = ?', cron, new Date(Date.now() - lateMs).toISOString(), s.id);
  return schedules.getSchedule(s.id);
}
const runOf = s => runs.getRun(schedules.getSchedule(s.id).last_run_id);
// runDue fires every due schedule of everyone: each schedule test starts from none (and nothing left running).
const clearUser = () => { run(`UPDATE runs SET status = 'done' WHERE status IN ('queued', 'running', 'waiting')`); run(`DELETE FROM schedules WHERE kind = 'task'`); };

// ---- A. Unknown outcomes, Retry, orphaned approvals -----------------------------------------------------------------------
test('restart during an approved send: recovery writes "outcome unknown", never re-sends, finishes, and frees check-ins', async () => {
  executed.send = 0;
  const r = newRun(alice, 'Send Sam the plan.');
  script = [{ tool: 'test_send', args: { text: 'the plan' } }];
  await loop.enqueueRun(r.id);
  assert.equal(runs.getRun(r.id).status, 'waiting');
  const a = approvals.latestForRun(r.id);
  approvals.decideApproval(a.id, alice, { decision: 'approve' });
  // What a crash in the middle of the approved call leaves behind: the intent recorded, the run working, no result.
  approvals.markExecuting(a.id);
  runs.setStatus(r.id, 'running');
  script = [{ text: 'A restart cut in while I was sending; I will check the sent folder before trying again.' }];
  await loop.recoverRuns();
  const done = await settle(r.id, { statuses: ['done', 'error'] });
  assert.equal(done.status, 'done', 'it goes on once to tell them');
  assert.equal(done.recovered, 1);
  assert.equal(executed.send, 0, 'never re-sent');
  const results = toolRows(r.id);
  assert.equal(results.length, 1);
  assert.equal(results[0].content, loop.UNKNOWN_OUTCOME);
  assert.match(results[0].content, /may or may not have happened\. Check first/);
  // The model saw it in the transcript right after its call.
  const seen = calls.at(-1).messages.find(m => m.role === 'tool');
  assert.equal(seen.content, loop.UNKNOWN_OUTCOME);
  assert.equal(active(alice).length, 0, 'nothing left waiting: check-ins and extraction are free again');
  // The #114 guard doesn't treat an unknown outcome as done: after checking, a send goes through the gate again (asks).
  script = [{ tool: 'test_send', args: { text: 'the plan' } }];
  const again = runs.createRun({ threadId: r.thread_id, userId: alice.id, triggerMessageId: r.trigger_message_id, model: 'fake/model' });
  await loop.enqueueRun(again.id);
  assert.equal(runs.getRun(again.id).status, 'waiting', 'asks again instead of "already done"');
  loop.cancelRun(again.id);
  await settle(again.id, { statuses: ['cancelled'] });
});

test('restart while still "waiting" with an approved call that had started: same unknown outcome', async () => {
  executed.send = 0;
  const r = newRun(alice, 'Send it.');
  script = [{ tool: 'test_send', args: { text: 'x' } }];
  await loop.enqueueRun(r.id);
  const a = approvals.latestForRun(r.id);
  approvals.decideApproval(a.id, alice, { decision: 'approve' });
  approvals.markExecuting(a.id); // the older path: executing while the run still said "waiting"
  script = [{ text: 'Not sure it went out.' }];
  await loop.recoverRuns();
  assert.equal((await settle(r.id, { statuses: ['done', 'error'] })).status, 'done');
  assert.equal(toolRows(r.id)[0].content, loop.UNKNOWN_OUTCOME);
  assert.equal(executed.send, 0);
});

test('approved but the restart came before the call started: recovery resumes it exactly once', async () => {
  executed.send = 0;
  const r = newRun(alice, 'Send Bea the list.');
  script = [{ tool: 'test_send', args: { text: 'the list' } }];
  await loop.enqueueRun(r.id);
  const a = approvals.latestForRun(r.id);
  approvals.decideApproval(a.id, alice, { decision: 'approve' }); // …and then the server stopped before resuming
  script = [{ text: 'Sent Bea the list.' }];
  await loop.recoverRuns();
  assert.equal((await settle(r.id, { statuses: ['done', 'error'] })).status, 'done');
  assert.equal(executed.send, 1, 'resumed once');
  assert.match(toolRows(r.id)[0].content, /^Sent: the list/);
  assert.ok(approvals.getApproval(a.id).executing_at, 'the intent was recorded before the call');
  await loop.recoverRuns(); // a second boot finds nothing to do
  assert.equal(executed.send, 1);
  // Denied while the server was down: the normal declined message, then the run goes on.
  const r2 = newRun(alice, 'Send it anyway.');
  script = [{ tool: 'test_send', args: { text: 'nope' } }];
  await loop.enqueueRun(r2.id);
  const a2 = approvals.latestForRun(r2.id);
  approvals.decideApproval(a2.id, alice, { decision: 'deny', reason: 'not now' });
  script = [{ text: 'OK, I did not send it.' }];
  await loop.recoverRuns();
  assert.equal((await settle(r2.id, { statuses: ['done', 'error'] })).status, 'done');
  assert.match(toolRows(r2.id)[0].content, /^The person declined this action \(reason: not now\)/);
  assert.equal(executed.send, 1);
});

test('Stop while an approved call waits its turn behind another run in the chat: the call never goes out', async () => {
  executed.send = 0;
  const r = newRun(alice, 'Send the invite.');
  script = [{ tool: 'test_send', args: { text: 'invite' } }];
  await loop.enqueueRun(r.id);
  const a = approvals.latestForRun(r.id);
  // Another run in the same chat is busy (a slow model answer) when the OK arrives.
  const m = addMessage({ threadId: r.thread_id, role: 'system', content: '[Scheduled task “Busy”]' });
  const busy = runs.createRun({ threadId: r.thread_id, userId: alice.id, triggerMessageId: m.id, model: 'fake/model', origin: 'schedule', originLabel: 'Busy' });
  script = [{ text: 'Slow answer.', delay: 400 }];
  const busyDone = loop.enqueueRun(busy.id);
  approvals.decideApproval(a.id, alice, { decision: 'approve' });
  const resumed = loop.resumeAfterApproval(a.id);
  assert.equal(runs.getRun(r.id).status, 'running', 'working again: a new message would queue behind it, not close it');
  assert.equal(loop.cancelRun(r.id), true);
  await Promise.all([busyDone, resumed]);
  await loop.drainRuns();
  assert.equal(runs.getRun(r.id).status, 'cancelled');
  assert.equal(executed.send, 0, 'the approved call never went out');
  assert.equal(runs.getRun(busy.id).status, 'done');
});

test('an interrupted call without a result reads "outcome unknown" when it changes things, neutral for a read', () => {
  const t = threads.createSideThread(alice.id, 'Transcript');
  const rows = [
    { role: 'user', content: 'Send and look.', id: 1 },
    { role: 'assistant', content: '', tool_calls: JSON.stringify([{ id: 'c1', type: 'function', function: { name: 'test_send', arguments: '{"text":"hi"}' } }]), id: 2 },
    { role: 'assistant', content: '', tool_calls: JSON.stringify([{ id: 'c2', type: 'function', function: { name: 'test_look', arguments: '{}' } }]), id: 3 },
  ];
  const out = promptTest.toChat(rows, { user: alice });
  const results = out.filter(m => m.role === 'tool');
  assert.equal(results[0].content, INTERRUPTED_UNKNOWN);
  assert.match(results[0].content, /outcome unknown.*Check first/);
  assert.match(results[1].content, /^\(no result — this step was interrupted/);
  assert.ok(t.id);
});

test('Retry never redoes an identical change the earlier attempt already made (#114 across attempts)', async () => {
  executed.note = 0;
  const r = newRun(alice, 'Note the plan, then summarise.');
  script = [{ tool: 'test_note', args: { text: 'plan A' } }, { error: 502 }];
  await loop.enqueueRun(r.id);
  const failed = runs.getRun(r.id);
  assert.equal(failed.status, 'error');
  assert.equal(failed.error_kind, 'transient');
  assert.equal(failed.retry_at, null, 'a chat run gets no automatic retry (they are there: Retry)');
  assert.equal(executed.note, 1);
  script = [{ tool: 'test_note', args: { text: 'plan A' } }, { text: 'Saved and summarised.' }];
  const { run: retried } = await loop.retryRun(r.id);
  await settle(retried.id, { statuses: ['done', 'error'] });
  assert.equal(executed.note, 1, 'not saved twice');
  assert.equal(retried.retry_of, r.id);
  assert.equal(runs.getRun(r.id).hidden, 1, 'the failed bubble is replaced');
  const results = toolRows(retried.id);
  assert.match(results[0].content, /^Already done in the earlier attempt — not repeated: Saved note: plan A/);
  // A different change still runs.
  script = [{ tool: 'test_note', args: { text: 'plan B' } }, { text: 'ok' }];
  const third = runs.createRun({ threadId: r.thread_id, userId: alice.id, triggerMessageId: r.trigger_message_id, model: 'fake/model' });
  await loop.enqueueRun(third.id);
  assert.equal(executed.note, 2);
});

test('a new message closes a pending approval ("you moved on"); deciding it then says so; the run is closed cleanly', async () => {
  executed.send = 0;
  const r = newRun(alice, 'Email the landlord.');
  script = [{ tool: 'test_send', args: { text: 'to the landlord' } }];
  await loop.enqueueRun(r.id);
  const a = approvals.latestForRun(r.id);
  assert.equal(a.status, 'pending');
  const thread = get('SELECT * FROM threads WHERE id = ?', r.thread_id);
  script = [{ text: 'Sure, here is the weather.' }];
  const { run: next } = loop.startTurn({ user: alice, thread, text: 'Actually, what is the weather?' });
  await settle(next.id, { statuses: ['done', 'error'] });
  const closed = approvals.getApproval(a.id);
  assert.equal(closed.status, 'expired');
  assert.equal(closed.closed_reason, 'moved_on');
  assert.equal(runs.getRun(r.id).status, 'done');
  assert.match(toolRows(r.id)[0].content, /^Not done: the person moved on/);
  const view = approvals.approvalView(closed, alice);
  assert.equal(view.closedReason, 'moved_on');
  assert.equal(view.resultLabel, 'Expired: you moved on, so it was not done');
  assert.doesNotMatch(view.resultLabel, /—/, 'UI copy has no em-dashes (#116)');
  // The old card, decided late: a clear 409, nothing runs.
  assert.throws(() => approvals.decideApproval(a.id, alice, { decision: 'approve' }), err => err.status === 409 && err.code === 'approval_closed'
    && /closed when you sent a new message, so nothing was done/.test(err.message));
  assert.equal(executed.send, 0);
  // The announcement carries the reason and the line for open cards.
  const ev = all(`SELECT data FROM events WHERE user_id = ? AND type = 'approval.updated' ORDER BY id DESC LIMIT 5`, alice.id).map(e => JSON.parse(e.data)).find(d => d.approvalId === a.id);
  assert.equal(ev.closedReason, 'moved_on');
  assert.match(ev.label, /you moved on/);
  // A pending approval whose run already ended (older data): closed on decide, with a clear error.
  const r2 = newRun(alice, 'Send.');
  script = [{ tool: 'test_send', args: { text: 'orphan' } }];
  await loop.enqueueRun(r2.id);
  const a2 = approvals.latestForRun(r2.id);
  run(`UPDATE runs SET status = 'done' WHERE id = ?`, r2.id);
  assert.throws(() => approvals.decideApproval(a2.id, alice, { decision: 'approve' }), err => err.status === 409 && /already ended/.test(err.message));
  assert.equal(approvals.getApproval(a2.id).closed_reason, 'run_closed');
  // Stopping a run that waits for an OK closes the request too.
  const r3 = newRun(alice, 'Send.');
  script = [{ tool: 'test_send', args: { text: 'stop me' } }];
  await loop.enqueueRun(r3.id);
  const a3 = approvals.latestForRun(r3.id);
  loop.cancelRun(r3.id);
  await settle(r3.id, { statuses: ['cancelled'] });
  assert.equal(approvals.getApproval(a3.id).closed_reason, 'run_closed');
  assert.match(toolRows(r3.id)[0].content, /^Not done: this request closed because the task ended/);
});

test('approval previews and titles get the requester (ctx.user), so a preview can check what is theirs', () => {
  const seen = [];
  registerTool({ name: 'test_attach_send', toolset: 'core', risk: 'external', description: 'Send with a file.', label: () => 'Sent a file',
    parameters: { type: 'object', properties: { file: { type: 'string' } } }, run: () => 'sent',
    approvalTitle: (args, ctx) => { seen.push(['title', ctx?.user?.id, ctx?.runId]); return 'Send a file'; },
    // What a real tool does with it: only the requester's own items are named on the card.
    approvalPreview: (args, ctx) => { seen.push(['preview', ctx?.user?.id, ctx?.runId]); return ctx?.user?.id === alice.id ? `File: ${args.file}` : 'File: (not yours)'; } });
  const r = newRun(alice, 'Send the file.');
  const a = approvals.createApproval({ run: r, user: alice, tool: registryTool('test_attach_send'), args: { file: 'Lease.pdf' }, toolCallId: 'x1' });
  assert.equal(a.preview, 'File: Lease.pdf');
  assert.deepEqual(seen, [['title', alice.id, r.id], ['preview', alice.id, r.id]]);
  const rb = newRun(bob, 'Send the file.');
  assert.equal(approvals.createApproval({ run: rb, user: bob, tool: registryTool('test_attach_send'), args: { file: 'Lease.pdf' }, toolCallId: 'x2' }).preview, 'File: (not yours)');
});

// ---- B. Unattended reliability ------------------------------------------------------------------------------------------
test('a scheduled run records its status when it FINISHES (running → ok), and a failure reads "bad"', async () => {
  clearUser(alice);
  const s = dueSchedule(alice);
  script = [{ text: 'Your brief: sunny, two meetings.' }];
  await proactive.runDue(new Date());
  const fired = schedules.getSchedule(s.id);
  assert.equal(fired.last_status, null, 'not "ok" at creation');
  const r = runOf(s);
  assert.equal(r.schedule_id, s.id);
  assert.ok(['running', 'ok'].includes(schedules.jobView(fired).lastStatus));
  await settle(r.id, { statuses: ['done', 'error'] });
  assert.equal(schedules.getSchedule(s.id).last_status, 'ok');
  assert.equal(schedules.jobView(schedules.getSchedule(s.id)).lastStatus, 'ok');
  // A permanent failure: bad, no retry, and it reaches them.
  const s2 = dueSchedule(alice, { title: 'Budget check' });
  const before = notifies(alice).length;
  script = [{ error: 401 }];
  await proactive.runDue(new Date());
  const r2 = await settle(runOf(s2).id, { statuses: ['error'] });
  assert.equal(r2.error_kind, 'permanent');
  assert.equal(r2.retry_at, null);
  assert.equal(schedules.getSchedule(s2.id).last_status, 'bad');
  const pushed = notifies(alice).slice(before);
  assert.ok(pushed.some(n => n.title === 'Couldn’t do “Budget check”'), JSON.stringify(pushed));
});

test('a transient failure gets ONE automatic retry ~10 min later; a second failure is final and notifies', async () => {
  clearUser(alice);
  const s = dueSchedule(alice, { title: 'Train news' });
  const before = notifies(alice).length;
  script = [{ error: 502 }];
  await proactive.runDue(new Date());
  const first = await settle(runOf(s).id, { statuses: ['error'] });
  assert.equal(first.error_kind, 'transient');
  assert.ok(first.retry_at, 'a retry is planned');
  const wait = new Date(first.retry_at) - Date.now();
  assert.ok(wait > 9 * 60000 && wait <= 10 * 60000 + 1000, `about 10 minutes (${wait} ms)`);
  assert.match(first.error, /I’ll try again by myself at \d\d:\d\d\./);
  assert.equal(schedules.jobView(schedules.getSchedule(s.id)).lastStatus, 'retrying');
  assert.equal(notifies(alice).slice(before).filter(n => /Couldn’t do/.test(n.title)).length, 0, 'no push while a retry is coming');
  assert.equal(runs.runView(first).retryAt, new Date(first.retry_at).toISOString());
  // Not yet due: nothing happens.
  assert.equal(await loop.runDueRetries(new Date()), 0);
  // Due: the retry replaces the failed run in place and fails again → final.
  script = [{ error: 503 }];
  await proactive.runDue(new Date(Date.now() + 11 * 60000));
  const second = runOf(s);
  assert.notEqual(second.id, first.id);
  assert.equal(second.retry_of, first.id);
  assert.equal(runs.getRun(first.id).hidden, 1);
  assert.equal(runs.getRun(first.id).retry_at, null);
  const final = await settle(second.id, { statuses: ['error'] });
  assert.equal(final.retry_at, null, 'only one automatic retry');
  assert.doesNotMatch(final.error, /try again by myself/);
  const pushed = notifies(alice).slice(before).filter(n => n.title === 'Couldn’t do “Train news”');
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].href, `/chat/${final.thread_id}`);
  assert.equal(schedules.getSchedule(s.id).last_status, 'bad');
  // A retry that succeeds: ok.
  const s2 = dueSchedule(alice, { title: 'Weather' });
  script = [{ error: 429 }];
  await proactive.runDue(new Date());
  const f2 = await settle(runOf(s2).id, { statuses: ['error'] });
  script = [{ text: 'Sunny.' }];
  await proactive.runDue(new Date(Date.now() + 11 * 60000));
  await settle(runOf(s2).id, { statuses: ['done'] });
  assert.notEqual(runOf(s2).id, f2.id);
  assert.equal(schedules.getSchedule(s2.id).last_status, 'ok');
  // Errors are classified: network and 5xx/429/408 pass, 401/402/bugs don't.
  assert.equal(loop.errorKind({ status: 500 }), 'transient');
  assert.equal(loop.errorKind({ cause: { code: 'ECONNRESET' } }), 'transient');
  assert.equal(loop.errorKind({ status: 402 }), 'permanent');
  assert.equal(loop.errorKind(new Error('bug')), 'permanent');
});

test('a pending retry is the only run when the task’s next occurrence falls before it (the 07:00 edge, #57)', async () => {
  clearUser(alice);
  // The edge, pinned relative to now: the next occurrence is 5 minutes away, the retry 10 (as at 06:55 for a 07:00 task).
  const probe = dueSchedule(alice, { title: 'Edge news' });
  const s = dueSchedule(alice, { title: 'Edge news', cron: cronAt(probe.timezone, new Date(Date.now() + 5 * 60000)) });
  run('DELETE FROM schedules WHERE id = ?', probe.id);
  script = [{ error: 502 }];
  await proactive.runDue(new Date());
  const first = await settle(runOf(s).id, { statuses: ['error'] });
  assert.ok(first.retry_at, 'a retry is planned');
  assert.ok(new Date(schedules.getSchedule(s.id).next_run_at) < new Date(first.retry_at), 'the next occurrence comes before the retry');
  const before = all('SELECT id FROM runs WHERE schedule_id = ?', s.id).length;
  script = [{ text: 'Trains are running.' }];
  await proactive.runDue(new Date(Date.now() + 11 * 60000)); // both are due now
  const second = runOf(s);
  assert.equal(second.retry_of, first.id, 'the run is the retry');
  const started = all('SELECT id FROM runs WHERE schedule_id = ? AND id > ?', s.id, first.id);
  assert.deepEqual(started.map(r => r.id), [second.id], 'and the only new run: the occurrence was not fired as well');
  assert.equal(all('SELECT id FROM runs WHERE schedule_id = ?', s.id).length, before + 1);
  await settle(second.id, { statuses: ['done'] });
  assert.equal(schedules.getSchedule(s.id).last_status, 'ok');
  assert.ok(new Date(schedules.getSchedule(s.id).next_run_at) > new Date(Date.now() + 11 * 60000), 'moved on to the occurrence after');
});

test('a task missed while offline is "skipped" (not ok) and says so once with a way to run it now; check-ins just move on', async () => {
  clearUser(alice);
  const n = calls.length;
  const s = dueSchedule(alice, { title: 'Morning brief' }, 3 * 3600000);
  await proactive.runDue(new Date());
  const after = schedules.getSchedule(s.id);
  assert.equal(after.last_status, 'skipped');
  assert.equal(schedules.jobView(after).lastStatus, 'skipped', 'kept distinct in the view');
  assert.ok(new Date(after.next_run_at) > new Date(), 'moved to its next occurrence');
  assert.equal(calls.length, n, 'no model call');
  const note = runs.getRun(get(`SELECT id FROM runs WHERE schedule_id = ? ORDER BY id DESC LIMIT 1`, s.id).id);
  assert.equal(note.error_kind, 'missed');
  assert.equal(note.status, 'done');
  assert.match(reply(note.id), /^I was offline when \*\*Morning brief\*\* was due \(.+\), so it didn’t run\. Want it now\? \[Run it now\]\(\/upcoming\)$/);
  assert.doesNotMatch(reply(note.id), /—/);
  assert.equal(runs.runView(note).scheduleId, s.id);
});

test('restart recovery: unattended work that changed nothing is re-queued once; after a change it says what it did; check-ins drop', async () => {
  clearUser(alice);
  executed.note = 0;
  // (1) A scheduled run that only read so far → re-queued, finishes.
  const s = dueSchedule(alice, { title: 'Flight prices' });
  const r1 = newRun(alice, '[Scheduled task “Flight prices”]', { origin: 'schedule', originLabel: 'Flight prices', scheduleId: s.id, role: 'system' });
  runs.setStatus(r1.id, 'running');
  script = [{ text: 'Cheapest is 880 EUR.' }];
  // (2) One that already saved something → an error saying so, plus a push.
  const r2 = newRun(alice, '[Scheduled task “Tidy notes”]', { origin: 'schedule', originLabel: 'Tidy notes', role: 'system' });
  addMessage({ threadId: r2.thread_id, runId: r2.id, role: 'assistant', content: '', toolCalls: [{ id: 'k1', type: 'function', function: { name: 'test_note', arguments: '{"text":"groceries"}' } }] });
  addMessage({ threadId: r2.thread_id, runId: r2.id, role: 'tool', toolCallId: 'k1', toolName: 'test_note', content: 'Saved note: groceries' });
  runs.setStatus(r2.id, 'running');
  // (3) A check-in → dropped silently. (4) A chat run → the usual "Press Retry". (5) Already re-queued once → final error.
  const r3 = newRun(alice, '[Check-in]', { origin: 'checkin', originLabel: 'Check-in', role: 'system' });
  runs.setStatus(r3.id, 'running');
  const r4 = newRun(alice, 'Find me a plumber.');
  runs.setStatus(r4.id, 'running');
  const r5 = newRun(alice, '[Goal step]', { origin: 'goal', originLabel: 'Plan meals', role: 'system' });
  run('UPDATE runs SET recovered = 1 WHERE id = ?', r5.id);
  runs.setStatus(r5.id, 'queued');
  const before = notifies(alice).length;
  await loop.recoverRuns();
  const d1 = await settle(r1.id, { statuses: ['done', 'error'] });
  assert.equal(d1.status, 'done');
  assert.equal(d1.recovered, 1);
  const d2 = runs.getRun(r2.id);
  assert.equal(d2.status, 'error');
  assert.equal(d2.error_kind, 'interrupted');
  assert.match(d2.error, /^I was interrupted by a restart in the middle of “Tidy notes” after Saved the note “groceries”\. Want me to finish\?/);
  assert.ok(notifies(alice).slice(before).some(n => n.title === 'Couldn’t do “Tidy notes”'));
  const d3 = runs.getRun(r3.id);
  assert.equal(d3.status, 'done');
  assert.equal(d3.hidden, 1, 'an interrupted check-in leaves no trace');
  assert.equal(get('SELECT COUNT(*) AS n FROM messages WHERE run_id = ?', r3.id).n, 0);
  assert.match(runs.getRun(r4.id).error, /Press Retry/);
  assert.equal(runs.getRun(r5.id).status, 'error');
  assert.equal(runs.getRun(r5.id).error_kind, 'interrupted');
  assert.equal(executed.note, 0);
});

// ---- C. Watches -------------------------------------------------------------------------------------------------------
test('watch creation: only_when makes a quiet watch; ≥ 2 h apart; at most 10; until must be ahead; bad URLs refused', () => {
  clearUser(bob);
  const t = threads.createSideThread(bob.id, 'Watches');
  const base = { user: bob, title: 'Fare', prompt: 'Check the Lisbon to Paris fare on 3 Oct.', threadId: t.id };
  const w = schedules.createSchedule({ ...base, cron: '0 8,14,20 * * *', onlyWhen: 'the fare is under 900 EUR', until: '2099-12-31' });
  assert.equal(w.notify, 'changes');
  assert.equal(w.only_when, 'the fare is under 900 EUR');
  assert.ok(w.ends_at.startsWith('2099-12-3'));
  const v = schedules.jobView(w);
  assert.equal(v.watch.condition, 'the fare is under 900 EUR');
  assert.equal(v.watch.line, 'Watching · no check yet');
  assert.ok(v.endsLabel);
  const reasons = fn => { try { fn(); return ''; } catch (err) { return Object.values(err.errors || {}).join(' '); } };
  assert.match(reasons(() => schedules.createSchedule({ ...base, cron: '0 * * * *', onlyWhen: 'it changes' })), /at most every 2 hours/);
  assert.equal(reasons(() => schedules.createSchedule({ ...base, title: 'Hourly task', cron: '0 * * * *' })), '', 'ordinary tasks may run hourly');
  assert.match(reasons(() => schedules.createSchedule({ ...base, cron: '0 9 * * *', until: '2001-01-01' })), /YYYY-MM-DD, today or later/);
  assert.match(reasons(() => schedules.createSchedule({ ...base, cron: '0 9 * * *', watchUrl: 'javascript:alert(1)' })), /full address/);
  const url = schedules.createSchedule({ ...base, title: 'Page', cron: '0 9 * * *', watchUrl: 'https://example.com/tickets' });
  assert.equal(url.notify, 'changes', 'a watched page alone makes it a watch');
  for (let i = 0; i < 8; i++) schedules.createSchedule({ ...base, title: `W${i}`, cron: '0 9 * * *', onlyWhen: 'x' });
  assert.match(reasons(() => schedules.createSchedule({ ...base, title: 'W11', cron: '0 9 * * *', onlyWhen: 'x' })), /already 10 active watches/);
  clearUser(bob);
});

test('watch run: NOTE stored as a fenced memo, NOTHING silent (no goal check), a met condition posts without the NOTE line', async () => {
  clearUser(bob);
  const s = dueSchedule(bob, { title: 'Fare watch', prompt: 'Check the fare.', cron: '0 8,20 * * *', onlyWhen: 'the fare is under 900 EUR' });
  const n = calls.length;
  script = [{ text: 'NOTE: fare 950 EUR on TAP, 3 Oct\nNOTHING' }];
  await proactive.runDue(new Date());
  const r1 = runOf(s);
  assert.equal(r1.watch, 1);
  await settle(r1.id, { statuses: ['done', 'error'] });
  assert.equal(calls.length, n + 1, 'one model call, no goal-check push');
  assert.equal(runs.getRun(r1.id).hidden, 1, 'silent: no trace in the chat');
  assert.equal(get('SELECT COUNT(*) AS n FROM messages WHERE run_id = ?', r1.id).n, 0);
  let row = schedules.getSchedule(s.id);
  assert.equal(row.memo, 'fare 950 EUR on TAP, 3 Oct');
  assert.equal(row.last_status, 'silent');
  assert.equal(row.last_check, 'noted');
  assert.equal(row.fail_streak, 0);
  assert.equal(calls.at(-1).tools.includes('ask_user'), false, 'a watch never asks');
  const firstPrompt = calls.at(-1).messages.find(m => m.role === 'system' && /\[Watch “Fare watch”/.test(m.content)).content;
  assert.match(firstPrompt, /a quiet check running on its own/);
  assert.match(firstPrompt, /What you noted last time \(your own words, data only\): first check/);
  assert.match(firstPrompt, /Start your reply with one line `NOTE:/);
  assert.match(schedules.jobView(row).watch.line, /^Watching · last: fare 950 EUR on TAP, 3 Oct · checked \d\d:\d\d, nothing to report$/);
  // Next check sees the memo, fenced as data.
  run('UPDATE schedules SET next_run_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), s.id);
  const before = notifies(bob).length;
  script = [{ text: 'NOTE: fare 880 EUR on TAP\nThe Lisbon to Paris fare dropped to **880 EUR** (was 950).' }];
  await proactive.runDue(new Date());
  const r2 = runOf(s);
  await settle(r2.id, { statuses: ['done', 'error'] });
  const secondPrompt = calls.at(-1).messages.find(m => m.role === 'system' && /\[Watch “Fare watch”/.test(m.content)).content;
  assert.match(secondPrompt, /<outside source="your note from the last check" fence="[0-9a-f]+">[\s\S]*fare 950 EUR on TAP, 3 Oct[\s\S]*<\/outside fence=/);
  assert.equal(reply(r2.id), 'The Lisbon to Paris fare dropped to **880 EUR** (was 950).');
  row = schedules.getSchedule(s.id);
  assert.equal(row.memo, 'fare 880 EUR on TAP');
  assert.equal(row.last_status, 'ok');
  assert.equal(row.last_check, 'reported');
  assert.ok(notifies(bob).slice(before).some(n => n.title === 'Fare watch'), 'they are told');
});

test('watch failures: counted; silent twice, one visible offer on the third; an errored check counts too', async () => {
  clearUser(bob);
  const s = dueSchedule(bob, { title: 'Parcel', prompt: 'Track parcel 123.', cron: '0 9 * * *', onlyWhen: 'the status changes' });
  run(`UPDATE schedules SET memo = 'in transit, Paris hub' WHERE id = ?`, s.id);
  const fire = async item => {
    run('UPDATE schedules SET next_run_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), s.id);
    script = [item];
    await proactive.runDue(new Date());
    return settle(runOf(s).id, { statuses: ['done', 'error'] });
  };
  const a = await fire({ text: 'NOTE: failed — the tracking site timed out\nNOTHING' });
  assert.equal(a.hidden, 1);
  assert.equal(schedules.getSchedule(s.id).fail_streak, 1);
  assert.equal(schedules.getSchedule(s.id).memo, 'in transit, Paris hub', 'a failed check keeps the last good note');
  const b = await fire({ error: 401 }); // an errored check is a failure too, and stays quiet (no error bubble)
  assert.equal(b.hidden, 1);
  assert.equal(schedules.getSchedule(s.id).fail_streak, 2);
  const c = await fire({ text: 'NOTE: failed - blocked by a bot check\nNOTHING' });
  assert.equal(c.hidden, 0);
  assert.match(reply(c.id), /^I couldn’t check “Parcel” 3 times in a row \(last time: blocked by a bot check\)\. Want me to try another site or a different way\?/);
  assert.equal(schedules.getSchedule(s.id).last_check, 'failed');
  const d = await fire({ text: 'NOTE: failed — still blocked\nNOTHING' });
  assert.equal(d.hidden, 1, 'only one visible offer');
  const e = await fire({ text: 'NOTE: delivered today 10:14\nYour parcel was delivered at 10:14.' });
  assert.equal(reply(e.id), 'Your parcel was delivered at 10:14.');
  assert.equal(schedules.getSchedule(s.id).fail_streak, 0);
});

test('watch end date: past ends_at it stops with one closing note and no model call; next runs stop at the end', async () => {
  clearUser(bob);
  const s = dueSchedule(bob, { title: 'Tickets', prompt: 'Check for tickets.', cron: '0 9,18 * * *', onlyWhen: 'tickets go on sale', until: '2099-01-01' });
  run(`UPDATE schedules SET memo = 'not on sale yet', ends_at = ? WHERE id = ?`, new Date(Date.now() - 1000).toISOString(), s.id);
  const n = calls.length;
  await proactive.runDue(new Date());
  assert.equal(calls.length, n);
  const row = schedules.getSchedule(s.id);
  assert.equal(row.next_run_at, null);
  const note = runs.getRun(get(`SELECT id FROM runs WHERE schedule_id = ? ORDER BY id DESC LIMIT 1`, s.id).id);
  assert.match(reply(note.id), /^I’ve stopped watching \*\*Tickets\*\*: it was set to run until .+\. Last thing I saw: not on sale yet$/);
  await proactive.runDue(new Date());
  assert.equal(get('SELECT COUNT(*) AS n FROM runs WHERE schedule_id = ?', s.id).n, 1, 'only once');
  // The last occurrence before the end is followed by the closing note AT the end, not another check after it.
  const w = schedules.createSchedule({ user: bob, title: 'Short watch', prompt: 'x', cron: '0 9 * * *', onlyWhen: 'x', until: new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10) });
  const adv = schedules.advance({ ...w, next_run_at: w.next_run_at }, { runId: null, now: new Date(Date.now() + 3 * 864e5 - 3600000) });
  assert.ok(adv.next_run_at <= w.ends_at);
  const ordinary = schedules.createSchedule({ user: bob, title: 'Short task', prompt: 'x', cron: '0 9 * * *', until: new Date(Date.now() + 864e5).toISOString().slice(0, 10) });
  assert.equal(schedules.advance(ordinary, { now: new Date(Date.now() + 5 * 864e5) }).next_run_at, null, 'an ordinary task just stops');
  clearUser(bob);
});

test('watched page unchanged since the last good check: zero model calls ("checked, no change"); a change runs the model', async () => {
  clearUser(bob);
  let page = 'Tickets: sold out. Next release Friday.';
  proactive.__test.setWatchReader(async (url, opts) => { assert.equal(opts.fresh, true, 'the cache is skipped'); return { markdown: page }; });
  const s = dueSchedule(bob, { title: 'Ticket page', prompt: 'Check the page.', cron: '0 9,18 * * *', watchUrl: 'https://tickets.example.com/show' });
  const fire = async () => { run('UPDATE schedules SET next_run_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), s.id); await proactive.runDue(new Date()); };
  // First check: always the model (no note yet); its good NOTE commits the page's hash.
  script = [{ text: 'NOTE: sold out, next release Friday\nNOTHING' }];
  let n = calls.length;
  await fire();
  await settle(runOf(s).id, { statuses: ['done', 'error'] });
  assert.equal(calls.length, n + 1);
  assert.match(schedules.getSchedule(s.id).watch_hash, /^[0-9a-f]{64}$/);
  // Same text (whitespace aside): no run, no model call.
  page = 'Tickets:   sold out.\nNext release Friday.';
  n = calls.length;
  const runsBefore = get('SELECT COUNT(*) AS n FROM runs WHERE schedule_id = ?', s.id).n;
  await fire();
  assert.equal(calls.length, n, 'no model call');
  assert.equal(get('SELECT COUNT(*) AS n FROM runs WHERE schedule_id = ?', s.id).n, runsBefore, 'no run either');
  let row = schedules.getSchedule(s.id);
  assert.equal(row.last_check, 'unchanged');
  assert.equal(row.last_status, 'silent');
  assert.match(schedules.jobView(row).watch.line, /checked \d\d:\d\d, no change$/);
  // Changed: the model runs; a failed check does NOT commit the new hash (the change isn't lost).
  page = 'Tickets on sale now!';
  script = [{ text: 'NOTE: failed — page did not load\nNOTHING' }];
  n = calls.length;
  await fire();
  await settle(runOf(s).id, { statuses: ['done', 'error'] });
  assert.equal(calls.length, n + 1);
  const oldHash = row.watch_hash;
  assert.equal(schedules.getSchedule(s.id).watch_hash, oldHash);
  script = [{ text: 'NOTE: on sale now\nTickets for the show are on sale now.' }];
  await fire();
  await settle(runOf(s).id, { statuses: ['done', 'error'] });
  assert.equal(calls.length, n + 2, 'still changed vs the last good check → model again');
  row = schedules.getSchedule(s.id);
  assert.notEqual(row.watch_hash, oldHash);
  assert.equal(reply(runOf(s).id), 'Tickets for the show are on sale now.');
  // The page can't be read in code: the model tries (other ways, the browser).
  proactive.__test.setWatchReader(async () => { throw new Error('blocked'); });
  script = [{ text: 'NOTE: on sale now\nNOTHING' }];
  n = calls.length;
  await fire();
  await settle(runOf(s).id, { statuses: ['done', 'error'] });
  assert.equal(calls.length, n + 1);
  proactive.__test.setWatchReader(null);
});

test('a watch run by hand from Upcoming always answers and keeps its NOTE; an ordinary task is unaffected', async () => {
  clearUser(bob);
  const s = dueSchedule(bob, { title: 'Rent listings', prompt: 'Look for 2-bedroom flats under 1200.', cron: '0 9 * * *', onlyWhen: 'a new listing appears' });
  script = [{ text: 'NOTE: 4 listings, none new\nNOTHING' }];
  const r = await proactive.runScheduleNow(s);
  await settle(r.id, { statuses: ['done', 'error'] });
  assert.equal(r.watch, 0);
  assert.equal(runs.getRun(r.id).hidden, 0);
  assert.equal(reply(r.id), 'Checked: 4 listings, none new. Nothing to report.');
  assert.equal(schedules.getSchedule(s.id).memo, '4 listings, none new');
  assert.match(calls.at(-1).messages.find(m => m.role === 'system' && /\[Watch/.test(m.content)).content, /checked now from Upcoming by the person/);
});

// ---- D. #83 as amended: one closing question ------------------------------------------------------------------------------
test('#83: a scheduled task may ask ONE question, only after its work; refused mid-run and a second time; they are notified', async () => {
  clearUser(alice);
  const s = dueSchedule(alice, { title: 'Weekend trip', prompt: 'Find a weekend trip and offer the best two.', cron: '0 9 * * 5' });
  const Q = { questions: [{ header: 'Trip', question: 'Book Lisbon or Porto?', kind: 'single', options: [{ label: 'Lisbon' }, { label: 'Porto' }] }] };
  const before = notifies(alice).length;
  script = [{ tool: 'ask_user', args: Q }, { tool: 'test_look', args: {} }, { tool: 'ask_user', args: Q }];
  await proactive.runDue(new Date());
  const r = await settle(runOf(s).id);
  assert.equal(r.status, 'waiting', 'the closing question pauses it');
  const results = toolRows(r.id);
  assert.match(results[0].content, /^Error: Not yet: a scheduled task may ask ONE question, and only as its very last step/);
  assert.equal(results[1].content, 'Found: 3 flights.');
  assert.ok(calls.at(-3).tools.includes('ask_user'), 'offered to a scheduled task');
  const q = get(`SELECT * FROM questions WHERE run_id = ? AND status = 'pending'`, r.id);
  assert.ok(q);
  assert.ok(notifies(alice).slice(before).some(n => n.title === 'Weekend trip: one question for you' && /Lisbon or Porto/.test(n.body)));
  assert.equal(schedules.jobView(schedules.getSchedule(s.id)).lastStatus, 'running');
  // Answered → it goes on; the tool is no longer offered, and a second ask is refused anyway.
  script = [{ tool: 'ask_user', args: Q }, { text: 'Booked nothing yet: Lisbon it is, here is the link.' }];
  run(`UPDATE questions SET status = 'answered' WHERE id = ?`, q.id);
  await loop.resumeWithAnswer(r.id, q.tool_call_id, 'The person answered: Lisbon');
  const done = await settle(r.id, { statuses: ['done', 'error'] });
  assert.equal(done.status, 'done');
  assert.equal(calls.at(-2).tools.includes('ask_user'), false, 'not offered after asking once');
  assert.match(toolRows(r.id).at(-1).content, /^Error: You already asked your one question/);
  // Check-ins stay question-free; the unattended prompt carries the rule.
  assert.match(proactive.UNATTENDED, /ONE question with ask_user, as your very last step after all the work is done/);
  assert.match(proactive.UNATTENDED, /presented as a brief \(what you prepared, why, a link\), with the options as buttons/);
  const ci = newRun(alice, proactive.CHECKIN_PROMPT, { origin: 'checkin', originLabel: 'Check-in', role: 'system' });
  script = [{ text: 'NOTHING' }];
  await loop.enqueueRun(ci.id);
  assert.equal(calls.at(-1).tools.includes('ask_user'), false);
});

test('#83: the closing question expires when the task runs next (one open checkpoint per schedule) or on a new message', async () => {
  clearUser(alice);
  const s = dueSchedule(alice, { title: 'Grocery order', prompt: 'Prepare the grocery order.', cron: '0 9 * * 1' });
  const Q = { questions: [{ header: 'Order', question: 'Place the order?', kind: 'yesno' }] };
  script = [{ tool: 'test_look', args: {} }, { tool: 'ask_user', args: Q }];
  await proactive.runDue(new Date());
  const r1 = await settle(runOf(s).id);
  assert.equal(r1.status, 'waiting');
  const q1 = get(`SELECT * FROM questions WHERE run_id = ?`, r1.id);
  // The next occurrence fires: the old checkpoint closes, the new run starts.
  run('UPDATE schedules SET next_run_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), s.id);
  script = [{ text: 'This week’s order is ready.' }];
  await proactive.runDue(new Date());
  assert.equal(get('SELECT status FROM questions WHERE id = ?', q1.id).status, 'expired');
  assert.equal(runs.getRun(r1.id).status, 'done');
  assert.match(toolRows(r1.id).at(-1).content, /^Not answered: the next run of this scheduled task started/);
  const r2 = runOf(s);
  assert.notEqual(r2.id, r1.id);
  await settle(r2.id, { statuses: ['done', 'error'] });
  // A new message in that chat closes an open checkpoint too (#97).
  run('UPDATE schedules SET next_run_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), s.id);
  script = [{ tool: 'test_look', args: {} }, { tool: 'ask_user', args: Q }];
  await proactive.runDue(new Date());
  const r3 = await settle(runOf(s).id);
  assert.equal(r3.status, 'waiting');
  script = [{ text: 'Sure.' }];
  const { run: chatRun } = loop.startTurn({ user: alice, thread: get('SELECT * FROM threads WHERE id = ?', r3.thread_id), text: 'Never mind, something else.' });
  await settle(chatRun.id, { statuses: ['done', 'error'] });
  assert.equal(runs.getRun(r3.id).status, 'done');
  assert.equal(get(`SELECT status FROM questions WHERE run_id = ?`, r3.id).status, 'expired');
});

// ---- The message sense gets its whole budget (orchestrator follow-up to Phase 20) ------------------------------------------
test('the first step waits for the message sense up to ITS budget (embedding race + Jev), counted from when it started', async () => {
  const sense = await import('../src/agent/sense.js');
  const { pending } = sense.__test;
  assert.equal(sense.SENSE_MAX_MS, 900 + 3000 + 300);
  const later = (ms, v) => new Promise(r => setTimeout(() => r(v), ms));
  // A sense still inside its budget at 3.7 s (the old fixed 3.5 s wait cut it off): its answer is used.
  pending.set(-1, { job: later(3700, 'sensed'), startedAt: Date.now() });
  assert.equal(await sense.awaitSense(-1), 'sensed');
  // The run queued behind another for a while: only what is left of the budget is waited for.
  pending.set(-2, { job: later(400, 'late'), startedAt: Date.now() - (sense.SENSE_MAX_MS - 100) });
  const t = Date.now();
  assert.equal(await sense.awaitSense(-2), null);
  assert.ok(Date.now() - t < 350, 'waited only the remainder');
  // An explicit wait still wins; no sense for the run: nothing to wait for.
  pending.set(-3, { job: later(300, 'x'), startedAt: Date.now() });
  assert.equal(await sense.awaitSense(-3, 50), null);
  assert.equal(await sense.awaitSense(-99), null);
  for (const id of [-1, -2, -3]) pending.delete(id);
});
