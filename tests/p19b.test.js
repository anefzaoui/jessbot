// Phase 19 part B (decisions #176–#181): replies that are checked before they count (the reply audit, requirements, figures),
// long runs that notice dead ends and keep the task in view, breakers on spend and repeated reads, budget and admin alerts,
// scheduled tasks that pause after 3 failures, the model fallback chain and the model that answered, the background model
// for JSON jobs, the OpenRouter balance, routing from the message sense (skill, effort, careful topics), sources per run with
// the citation check, and the wish log.
// Run: npm test (throwaway data dir; OpenRouter is a stand-in fetch: chat, decisions, models, credits and key — never the network).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-unit-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env'); // keys the code makes (secrets, VAPID) never land in the real .env
process.env.JESSBOT_EMBED_OFF = '1'; // no embedding calls from unit tests
process.env.JESSBOT_DECIDE_OFF = '1'; // no decision-model calls either, except where a test switches it on (withJev)
process.env.OPENROUTER_KEY = 'sk-or-v1-unit-test-p19b-0123456789abcdef';

// ---- A stand-in for OpenRouter ----------------------------------------------------------------------------------------
// Streamed chat calls take the next `llm.script` item: { tool, args } | { text } | { error: status }, with optional `model`
// (the model that answered, default fake/model) and `cost`. Non-streamed calls (JSON jobs, connection tests) take the next
// `llm.json` item: { content, model } | { status }. The decision model answers with `jev.answer(body)`. /models, /credits and
// /key answer from `or`.
const realFetch = globalThis.fetch;
const llm = { script: [], streamed: [], json: [], jsonCalls: [] };
const jev = { calls: [], answer: null };
const or = { models: [], credits: null, key: null, creditsStatus: 200 };
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!/openrouter\.ai/.test(url)) return realFetch(input, init);
  const body = init.body ? JSON.parse(init.body) : {};
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/alpha/decisions')) {
    jev.calls.push(body);
    return jev.answer ? json({ answers: jev.answer(body), usage: {} }) : json({ error: { message: 'no answer scripted' } }, 400);
  }
  if (url.endsWith('/models')) return json({ data: or.models });
  if (url.endsWith('/credits')) return or.creditsStatus === 200 ? json({ data: or.credits }) : json({ error: { message: 'Only management keys' } }, or.creditsStatus);
  if (url.endsWith('/key')) return or.key ? json({ data: or.key }) : json({ error: { message: 'no' } }, 401);
  if (url.endsWith('/chat/completions') && body.stream) {
    llm.streamed.push(body);
    const next = llm.script.shift() || { text: 'Done.' };
    const model = next.model || 'fake/model';
    const chunk = delta => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
    let sse;
    if (next.error) sse = `data: ${JSON.stringify({ error: { message: 'Provider returned error', code: next.error } })}\n\n`;
    else if (next.tool) sse = chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${llm.streamed.length}_${Math.random().toString(36).slice(2, 7)}`, type: 'function', function: { name: next.tool, arguments: JSON.stringify(next.args || {}) } }] });
    else sse = chunk({ role: 'assistant', content: next.text });
    sse += `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: next.cost ?? 0 } })}\n\n`;
    return new Response(`${sse}data: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  if (url.endsWith('/chat/completions')) {
    llm.jsonCalls.push(body);
    const next = llm.json.shift() || { content: '{}' };
    if (next.status) return json({ error: { message: `scripted ${next.status}` } }, next.status);
    return json({ id: 'x', object: 'chat.completion', created: 0, model: next.model || body.model, choices: [{ index: 0, finish_reason: 'stop',
      message: { role: 'assistant', content: next.content } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost: next.cost ?? 0 } });
  }
  return json({ error: { message: `unexpected ${url}` } }, 500);
};

// Server-side requests go through lib/outbound.js (decision #221), not globalThis.fetch: send them to the stand-in too.
(await import('../src/lib/outbound.js')).setTransport((input, init) => globalThis.fetch(input, init));
const { openDb, closeDb, run, get, all, settings } = await import('../src/db/index.js');
const { ensureDirs } = await import('../src/config/index.js');
ensureDirs();
await openDb();

const { createUser } = await import('../src/services/users.js');
const { registerTool } = await import('../src/agent/tools/registry.js');
const { createApp } = await import('../src/app.js'); // registers the tools and configures the fragment renderer
createApp();
const policy = await import('../src/services/policy.js');
const threads = await import('../src/services/threads.js');
const runs = await import('../src/services/runs.js');
const schedules = await import('../src/services/schedules.js');
const { addMessage } = await import('../src/services/messages.js');
const loop = await import('../src/agent/loop.js');
await import('../src/agent/proactive.js'); // registers the schedule-pause hook
const sense = await import('../src/agent/sense.js');
const { buildPrompt } = await import('../src/agent/prompt.js');
const audit = await import('../src/agent/reply-audit.js');
const dead = await import('../src/agent/dead-ends.js');
const sources = await import('../src/services/sources.js');
const spend = await import('../src/services/spend-watch.js');
const wishes = await import('../src/services/wishes.js');
const llmSvc = await import('../src/services/llm.js');
const usage = await import('../src/services/usage.js');
const { markRunTaint } = await import('../src/agent/taint.js');
const { saveSkill } = await import('../src/services/skills.js');
const { resetPrices } = await import('../src/services/model-price.js');
const ocr = await import('../src/services/ocr.js');
const library = await import('../src/services/library.js');
const { spendSpikeCheck } = await import('../src/services/system.js');

// ---- Test tools -----------------------------------------------------------------------------------------------------------
const PAGE = 'Fares to London. Economy 1,180 EUR per person. Departs 15:30 on 2026-10-03, flight EK748. Details: https://fares.example/list';
registerTool({ name: 'test_look', toolset: 'core', risk: 'read', description: 'Look something up.', label: () => 'Looked it up',
  parameters: { type: 'object', properties: {} }, run: () => 'Found: 3 flights.' });
registerTool({ name: 'test_page', toolset: 'core', risk: 'read', description: 'Read a fares page.', label: () => 'Read the fares page',
  parameters: { type: 'object', properties: {} },
  run: (args, ctx) => { markRunTaint(ctx.run.id, 'low', { tool: 'test_page', label: 'page on fares.example' }); return { content: PAGE, step: { href: 'https://fares.example/list', detail: 'Fares' } }; } });
registerTool({ name: 'test_fail', toolset: 'core', risk: 'read', description: 'Always fails.', label: () => 'Tried the booking site',
  parameters: { type: 'object', properties: {} }, run: () => { throw new Error('the site did not answer'); } });
registerTool({ name: 'test_bad', toolset: 'core', risk: 'read', description: 'Finds nothing.', label: () => 'Searched the shop', target: () => 'shop.example',
  parameters: { type: 'object', properties: {} }, run: () => ({ content: 'Nothing found on this page.', step: { status: 'bad', detail: 'Nothing found' } }) });
// Stands in for web_read's side of the source list (the real one needs the browser).
registerTool({ name: 'test_web_read', toolset: 'core', risk: 'read', description: 'Read a page (stand-in).', label: () => 'Read a page',
  parameters: { type: 'object', properties: { url: { type: 'string' } } },
  run: (args, ctx) => {
    const content = `# News A\npublished 24 Sep 2026 (2 days ago)\n\nThe council approved the plan.`;
    sources.noteSources(ctx.run.id, 'web_read', args, content, { href: args.url, detail: 'News A' });
    return { content, step: { href: args.url, detail: 'News A' } };
  } });

let alice, bob, carol;
before(async () => {
  alice = await createUser({ name: 'Alice Owner', email: 'alice@p19b.dev', password: 'correct horse battery', role: 'admin', timezone: 'UTC' });
  bob = await createUser({ name: 'Bob Member', email: 'bob@p19b.dev', password: 'correct horse battery', timezone: 'UTC' });
  carol = await createUser({ name: 'Carol Budget', email: 'carol@p19b.dev', password: 'correct horse battery', timezone: 'UTC' });
  for (const u of [alice, bob, carol]) {
    policy.setPolicy('user', u.id, { toolsets: { core: 'allow', memory: 'allow', web: 'allow', schedule: 'allow', library: 'allow' },
      quietStart: '12:00', quietEnd: '12:00', weeklyBudget: 0 }, alice.id);
  }
  settings.set('llm', { baseUrl: 'https://openrouter.ai/api/v1', model: 'fake/model' });
});
after(() => { globalThis.fetch = realFetch; closeDb(); fs.rmSync(HOME, { recursive: true, force: true }); });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function settle(runId, { statuses = ['done', 'error', 'cancelled', 'waiting'], ms = 20000 } = {}) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    await loop.drainRuns();
    const r = runs.getRun(runId);
    if (statuses.includes(r.status)) return r;
    await sleep(20);
  }
  throw new Error(`run ${runId} stuck in ${runs.getRun(runId).status}`);
}
function newRun(user, text = 'Please help me with this.', { origin = 'chat', originLabel = null, scheduleId = null, role = 'user', thread = null } = {}) {
  const t = thread || threads.createSideThread(user.id, 'Test chat');
  const m = addMessage({ threadId: t.id, role, content: text });
  return { thread: t, message: m, run: runs.createRun({ threadId: t.id, userId: user.id, triggerMessageId: m.id, model: 'fake/model', origin, originLabel, scheduleId }) };
}
async function go(user, text, script, opts) {
  llm.script = [...script];
  const start = llm.streamed.length;
  const x = newRun(user, text, opts);
  await loop.enqueueRun(x.run.id);
  const r = await settle(x.run.id);
  return { ...x, r, calls: llm.streamed.length - start, bodies: llm.streamed.slice(start) };
}
const reply = runId => { const r = runs.getRun(runId); return r.reply_message_id ? get('SELECT content FROM messages WHERE id = ?', r.reply_message_id).content : null; };
const systemOf = runId => all(`SELECT content FROM messages WHERE run_id = ? AND role = 'system' ORDER BY id`, runId).map(m => m.content);
const labels = runId => JSON.parse(runs.getRun(runId).steps || '[]').map(s => s.label);
const notifies = user => all(`SELECT data FROM events WHERE user_id = ? AND type = 'notify' ORDER BY id`, user.id).map(e => JSON.parse(e.data));
const tailOf = body => body.messages.at(-1).content;
// Answers for whatever the decision model is asked: spec[key] = p (noul) or [choice, p] / 'choice' (choice); a function(key, q, body).
const jevAnswers = spec => body => Object.fromEntries(Object.entries(body.questions).map(([k, q]) => {
  const v = typeof spec === 'function' ? spec(k, q, body) : spec[k];
  if (v == null) return [k, q.type === 'noul' ? { noul: 0.5 } : { choice: Object.keys(q.criteria)[0], probabilities: {}, confidence: 0 }];
  if (q.type === 'noul') return [k, { noul: v }];
  const [pick, p] = Array.isArray(v) ? v : [v, 0.9];
  return [k, { choice: pick, probabilities: { [pick]: p }, confidence: p }];
}));
async function withJev(spec, fn) {
  delete process.env.JESSBOT_DECIDE_OFF;
  jev.answer = jevAnswers(spec);
  try { return await fn(); } finally { process.env.JESSBOT_DECIDE_OFF = '1'; jev.answer = null; }
}

// ---- 1. The reply audit ------------------------------------------------------------------------------------------------
test('reply audit (code): claims, denials and promises the task does not back are found; honest and backed ones pass', () => {
  const ts = new Set(['web', 'email', 'schedule', 'memory', 'calendar']);
  const a = (text, done = []) => audit.auditReply(text, { succeeded: new Set(done), toolsets: ts });
  assert.equal(a("I've set a reminder for 7pm tomorrow.").claims[0].family, 'schedule');
  assert.equal(a("I've set a reminder for 7pm tomorrow.", ['set_reminder']).claims.length, 0);
  assert.equal(a('Done! Your email has been sent to Sam.').claims[0].family, 'email');
  assert.equal(a("I've booked your table for 8pm.").claims[0].family, 'booking');
  assert.equal(a("J'ai bien ajouté l'événement à votre agenda.").claims[0].family, 'calendar');
  assert.equal(a('لقد أرسلت البريد إلى سامي.').claims[0].family, 'email');
  assert.equal(a("I'll remember that you like tea.").claims[0].family, 'memory');
  assert.equal(a("I can't browse the web, but here is what I know.").denials[0].toolset, 'web');
  assert.equal(a('Je ne peux pas consulter vos e-mails.').denials[0].toolset, 'email');
  assert.equal(audit.auditReply("I can't check your email.", { toolsets: new Set(['web']) }).denials.length, 0, 'email is off for them: not a false denial');
  assert.equal(a("I'll let you know when the price drops.").promises.length, 1);
  assert.equal(a("I'll let you know when the price drops.", ['schedule_task']).promises.length, 0);
  assert.equal(a('سأخبرك عندما ينخفض السعر.').promises.length, 1);
  // Honest, negated, a question, a draft in quotes: nothing.
  for (const t of ['Here are three options. I haven’t booked anything yet.', 'Shall I send the email now?', 'I won’t let you know unless you ask.',
    'Here is a draft: “Hi Sam, I have booked the venue for Saturday and sent the invites to everyone.” Want changes?']) {
    const x = a(t);
    assert.equal(audit.auditHits(x), 0, t);
  }
  assert.equal(a('تم الأمر بنجاح وكل شيء جاهز الآن.').nonLatin, true);
  assert.match(audit.unmetAsk("I can't order food for you.", ts), /order food/);
  assert.equal(audit.unmetAsk("I can't browse the web.", ts), null, 'a denial of a tool they have is not a wish');
});

test('reply audit (loop): a false “done” is pushed once, visibly; the next honest reply finishes', async () => {
  const x = await go(alice, 'Remind me at 7pm tomorrow to call mum', [{ text: "I've set a reminder for 7pm tomorrow." },
    { text: 'Sorry, nothing is set yet. Shall I set it now?' }]);
  assert.equal(x.r.status, 'done');
  assert.equal(x.calls, 2);
  const sys = systemOf(x.run.id);
  assert.equal(sys.length, 1);
  assert.match(sys[0], /^\[Check what you said before it counts\]/);
  assert.match(sys[0], /- What you said: Your reply says the reminder or scheduled task is done \(“I've set a reminder for 7pm tomorrow\.”\), but no step in this task did it/);
  assert.ok(labels(x.run.id).includes('Checking what I said I did'));
  assert.equal(reply(x.run.id), 'Sorry, nothing is set yet. Shall I set it now?');
});

test('reply audit (loop): a denial of an enabled tool and a promise with nothing scheduled are pushed; the audit pushes once per run', async () => {
  const d = await go(alice, 'What does a flight to Rome cost?', [{ text: "I can't browse the web, so I can't check live prices." }, { text: 'Here is what I found.' }]);
  assert.equal(d.calls, 2);
  assert.match(systemOf(d.run.id)[0], /you can’t use browsing or searching the web .* but you can: it is switched on for them/);
  const p = await go(alice, 'Watch this fare for me', [{ text: "I'll let you know when the price drops." }, { text: 'Nothing watches it yet. Want me to set up a watch?' }]);
  assert.equal(p.calls, 2);
  assert.match(systemOf(p.run.id)[0], /promises a follow-up .* nothing is scheduled/);
  const once = await go(alice, 'Add milk', [{ text: "I've added milk to your shopping list." }, { text: "I've added milk to your shopping list." }]);
  assert.equal(once.calls, 2, 'the audit pushed once; the repeat finishes (it counts against MAX_PUSHES like the rest)');
  assert.equal(systemOf(once.run.id).length, 1);
});

test('reply audit (loop): a claim a successful call backs, and a plain answer after real work, finish without a push', async () => {
  const t = await go(alice, 'Set a pasta timer for 10 minutes', [{ tool: 'set_timer', args: { minutes: 10, label: 'Pasta' } },
    { text: "I've set a timer for 10 minutes. I'll let you know when it rings." }]);
  assert.equal(t.r.status, 'done');
  assert.equal(t.calls, 2);
  assert.deepEqual(systemOf(t.run.id), []);
  const h = await go(alice, 'Find flights', [{ tool: 'test_look' }, { text: 'I found 3 flights; the cheapest leaves in the morning.' }]);
  assert.equal(h.calls, 2);
  assert.deepEqual(systemOf(h.run.id), []);
});

test('reply audit with the decision model: a clear “nothing was done” clears a code hit; a non-Latin claim it confirms is pushed', async () => {
  await withJev({ claimed: ['none', 0.95], denied: ['none', 0.95], promise: 0.05 }, async () => {
    const x = await go(alice, 'Ideas for dinner?', [{ text: "Your list is ready: I've added three ideas to the plan below." }]);
    assert.equal(x.calls, 1, 'cleared: finished on the first reply');
  });
  await withJev({ claimed: ['email', 0.9], denied: ['none', 0.9], promise: 0.1 }, async () => {
    const x = await go(alice, 'أرسل الرسالة إلى سامي', [{ text: 'تمت العملية بنجاح، وصلته الرسالة.' }, { text: 'لم أرسل شيئا بعد. هل أرسلها الآن؟' }]);
    assert.equal(x.calls, 2);
    assert.match(systemOf(x.run.id)[0], /Your reply says sending the email is done, but no step/);
  });
});

// ---- 2. Requirements and figures ------------------------------------------------------------------------------------------
test('figures (code): reformatted amounts, times, dates and flight numbers match; sums count; the rest are left with evidence', () => {
  const ev = ['Price 1,180 EUR per person. Dep 15:30 2026-10-03 EK748. Discount 15 percent. Economy 1,225 € each'];
  assert.deepEqual(audit.unmatchedFigures('The fare is €1.2k for both legs, departing 3:30 pm on 3 October on flight EK 748. That is about 15% cheaper. '
    + 'Total €2,450 for two.', ev), []);
  assert.deepEqual(audit.unmatchedFigures('It is €1,200 per person.', ['It costs 1.200,00 EUR']), [], 'European separators');
  const left = audit.unmatchedFigures('It costs $999 and leaves at 09:10 on 5 Nov, flight LH 400.', ['price $450 leaves 08:00 2026-11-06 LH401']);
  assert.deepEqual(left.map(f => f.kind), ['money', 'time', 'date', 'code']);
  assert.equal(left[0].figure, '$999');
  assert.match(left[0].sentence, /It costs \$999/);
  assert.match(left[0].evidence, /price \$450/);
  assert.deepEqual(audit.unmatchedFigures('Use A4 paper and print 2 copies.', ['nothing here']), [], 'no travel words: A4 is not a flight');
  assert.deepEqual(audit.numberValues('1,200'), [1200]);
  assert.deepEqual(audit.numberValues('1.2', 'k'), [1200]);
  assert.deepEqual(audit.numberValues('1 200,50'), [1200.5]);
});

test('figures (loop): after reading a page, matched figures finish; unmatched ones push once with a “Double-checking the numbers” step', async () => {
  const ok = await go(alice, 'Find me fares to London', [{ tool: 'test_page' },
    { text: 'The fare is €1.2k per person, leaving at 3:30 pm on 3 October (flight EK 748). For two: €2,360.' }]);
  assert.equal(ok.calls, 2);
  assert.deepEqual(systemOf(ok.run.id), []);
  const bad = await go(alice, 'Find me fares to London', [{ tool: 'test_page' }, { text: 'The fare is €999, leaving 09:10 on 5 Nov.' },
    { text: 'I checked again: €999, leaving 09:10 on 5 Nov.' }]);
  assert.equal(bad.calls, 3, 'one push only, then it finishes');
  const sys = systemOf(bad.run.id);
  assert.equal(sys.length, 1);
  assert.match(sys[0], /^\[Double-check the numbers\]/);
  assert.match(sys[0], /- Numbers: These figures aren’t in what you read this task: €999, 09:10, 5 Nov\./);
  assert.ok(labels(bad.run.id).includes('Double-checking the numbers'));
  // The decision model saying a leftover figure IS in the evidence (computed from it) clears it.
  await withJev({ f0: 0.9, f1: 0.9, f2: 0.9, claimed: ['none', 0.9], denied: ['none', 0.9], promise: 0.1, delivered: 0.9, theirs: 0.1, question: 0.1,
    constraints_met: 0.9, gap: 0.1 }, async () => {
    const cleared = await go(alice, 'Find me fares to London', [{ tool: 'test_page' }, { text: 'The fare is €999, leaving 09:10 on 5 Nov.' }]);
    assert.equal(cleared.calls, 2);
    const q = jev.calls.at(-1);
    assert.equal(q.state.figures.f0.figure, '€999');
    assert.match(q.state.figures.f0.evidence, /1,180 EUR/);
  });
});

test('requirements: a result that misses one is pushed with “Checking every requirement”; the goal nudge lists what failed', async () => {
  await withJev((k, q, body) => ({ delivered: 0.9, theirs: 0.1, question: 0.1, constraints_met: /for 4 people/.test(body.state.reply) ? 0.95 : 0.1,
    claimed: ['none', 0.9], denied: ['none', 0.9], promise: 0.1, gap: 0.1 })[k], async () => {
    const x = await go(alice, 'Find a table for 4 people on Friday at 8pm', [{ tool: 'test_look' }, { text: 'Chez Anna has a table on Friday at 8pm.' },
      { text: 'Chez Anna has a table for 4 people on Friday at 8pm.' }]);
    assert.equal(x.calls, 3);
    assert.match(systemOf(x.run.id)[0], /^\[Check every requirement\][\s\S]*- Requirements: Check each requirement/);
    assert.ok(labels(x.run.id).includes('Checking every requirement'));
  });
  await withJev({ delivered: 0.1, theirs: 0.1, question: 0.1, constraints_met: 0.2 }, async () => {
    const { run: r } = newRun(alice, 'Book the cheapest fare');
    const v = await sense.goalCheck({ run: runs.getRun(r.id), user: alice, reply: 'I could not find it.', goal: true, failed: ['Tried the booking site (booking.example)'] });
    assert.equal(v.push, true);
    assert.equal(v.kind, 'goal');
    assert.match(v.nudge, /- Result: Giving up is not an option/);
    assert.match(v.nudge, /Already tried and failed \(don’t repeat these\): Tried the booking site \(booking\.example\)\./);
  });
});

// ---- 3. Dead ends, the anchor, checkpoints, the breakers --------------------------------------------------------------------
test('stuck signals: failing steps, the same tool on the same site, the same search three times; a healthy run is not stuck', () => {
  const st = (status, tool = 'web_read', target = 'a.example') => ({ status, tool, target, label: `${tool} ${target}` });
  assert.equal(dead.stuckSignal({ steps: [st('bad'), st('ok'), st('bad'), st('bad'), st('bad')] }).reason, 'failing');
  assert.equal(dead.stuckSignal({ steps: [st('bad', 'browser_click', 'x.example'), st('ok', 'web_search', ''), st('bad', 'browser_click', 'x.example'),
    st('ok', 'web_read', 'y.example'), st('bad', 'browser_click', 'x.example'), st('ok', 'web_read', 'z.example'), st('bad', 'browser_click', 'x.example')] }).reason, 'same-site');
  assert.equal(dead.stuckSignal({ steps: [st('ok', 'web_search', ''), st('ok', 'web_search', ''), st('ok', 'web_search', '')],
    searches: ['cheap flights lisbon london', 'cheap flights london lisbon', 'flights lisbon london cheap'] }).reason, 'same-search');
  assert.equal(dead.stuckSignal({ steps: [st('ok'), st('ok', 'web_read', 'b.example'), st('bad'), st('ok', 'web_search', '')],
    searches: ['weather lisbon', 'best pizza lyon'] }), null);
  assert.equal(dead.overlap('Cheap flights Lisbon London', 'flights london lisbon cheap'), 1);
  assert.equal(dead.readKey('web_search', { query: 'Cheap  Flights!' }), dead.readKey('web_search', { query: 'cheap flights' }));
  assert.equal(dead.readKey('browser_click', { ref: 'e1' }), null, 'page tools are never breaker candidates');
  assert.equal(dead.errorStreak(['ok', 'Error: a', 'Error: b', 'Error: c', 'Error: d']), true);
  assert.equal(dead.errorStreak(['Error: a', 'Error: b', 'Found', 'Error: d']), false);
});

test('dead-end check (loop): after 4 failed steps a “[Dead end check]” message and a visible step; an error streak re-plans once', async () => {
  const d = await go(alice, 'Find the blue mug in the shop', [...Array(4).fill({ tool: 'test_bad' }), { text: 'I could not find it in that shop.' }]);
  const sys = systemOf(d.run.id);
  assert.match(sys[0], /^\[Dead end check\] 4 of the last 4 steps went wrong\. .*name the assumption/);
  assert.ok(labels(d.run.id).includes('Dead end check: trying a different route'));
  assert.equal(sys.filter(s => s.startsWith('[Dead end check]')).length, 1);
  const e = await go(alice, 'Book it', [...Array(6).fill({ tool: 'test_fail' }), { text: 'The site kept failing.' }]);
  const replans = systemOf(e.run.id).filter(s => s.startsWith('[Several steps failed in a row]'));
  assert.equal(replans.length, 1, 'one re-plan per run');
  assert.ok(labels(e.run.id).includes('Several steps failed: re-planning'));
});

test('long runs: the tail carries “The task you’re on” with what failed; a code-built checkpoint every 15 steps', async () => {
  const x = await go(alice, 'Compare the three phone plans and pick the cheapest', [{ tool: 'test_fail' }, ...Array(15).fill({ tool: 'test_look' }), { text: 'Plan B is cheapest.' }]);
  const late = x.bodies.at(-1);
  const tail = tailOf(late);
  assert.match(tail, /## The task you're on\n“Compare the three phone plans and pick the cheapest”/);
  assert.match(tail, /Already tried and failed:\n- Tried the booking site/);
  assert.doesNotMatch(tailOf(x.bodies[2]), /The task you're on/, 'short runs: no anchor');
  const cp = systemOf(x.run.id).filter(s => s.startsWith('[Checkpoint'));
  assert.equal(cp.length, 1);
  assert.match(cp[0], /^\[Checkpoint: 15 steps in\]\nThe request: “Compare the three phone plans/);
  assert.match(cp[0], /Failed: Tried the booking site/);
});

test('repeated-read breaker: the same state-independent read a third time is not made; a different one is', async () => {
  const x = await go(alice, 'What do you know about my tea?', [{ tool: 'recall', args: { query: 'tea' } }, { tool: 'recall', args: { query: 'tea' } },
    { tool: 'recall', args: { query: 'tea' } }, { tool: 'recall', args: { query: 'coffee' } }, { text: 'Nothing about tea yet.' }]);
  const rows = all(`SELECT tool_name, content FROM messages WHERE run_id = ? AND role = 'tool' ORDER BY id`, x.run.id);
  assert.equal(rows.length, 4);
  assert.ok(!rows[1].content.startsWith('Already done'));
  assert.equal(rows[2].content, dead.REPEAT_REFUSAL);
  assert.ok(!rows[3].content.startsWith('Already done'));
  const steps = JSON.parse(runs.getRun(x.run.id).steps);
  assert.equal(steps[2].status, 'bad');
  assert.equal(steps[2].detail, 'Already done twice, not repeated');
});

// ---- 4. Spend: the per-task cap, alerts, provider errors, schedule pause ---------------------------------------------------
test('task cap: over it, an attended task asks whether to keep going and an unattended one stops with a note; paid tools refuse first', async () => {
  policy.setPolicy('user', bob.id, { toolsets: { core: 'allow', memory: 'allow', web: 'allow', schedule: 'allow', library: 'allow' },
    quietStart: '12:00', quietEnd: '12:00', weeklyBudget: 0, taskBudget: 0.01 }, alice.id);
  assert.equal(policy.effectivePolicy(bob).taskBudget, 0.01);
  assert.equal(policy.effectivePolicy(alice).taskBudget, 0.5, 'default: $0.50 with no weekly limit');
  policy.setPolicy('user', carol.id, { toolsets: { core: 'allow' }, weeklyBudget: 1 }, alice.id);
  assert.equal(policy.effectivePolicy(carol).taskBudget, 0.25, 'default: a quarter of the weekly budget when that is less');
  policy.setPolicy('user', carol.id, { toolsets: { core: 'allow' }, weeklyBudget: 0 }, alice.id); // (taskBudget left out: kept)

  const a = await go(bob, 'Research this for me', [{ tool: 'test_look', cost: 0.02 }, { text: 'I found 3 flights; want me to keep going?' }]);
  assert.equal(a.r.status, 'done');
  assert.equal(a.calls, 2);
  const closing = a.bodies[1].messages.at(-1).content;
  assert.match(closing, /spending limit \(\$0\.01 for one task\).*ask whether to keep going/);
  assert.equal(a.bodies[1].tool_choice, 'none');
  assert.ok(labels(a.run.id).includes('Stopped at this task’s spending limit'));

  const u = await go(bob, '[Scheduled task “Research” — running on its own]', [{ tool: 'test_look', cost: 0.02 }, { text: 'Stopped at the limit: 3 flights found.' }],
    { origin: 'schedule', originLabel: 'Research', role: 'system' });
  assert.match(u.bodies[1].messages.at(-1).content, /say it stopped at the limit\. Don’t ask a question\./);

  // Paid tools inside a task check what is left of its cap before spending (a picture, reading a scan).
  const { run: r } = newRun(bob, 'Draw it');
  run(`INSERT INTO usage_events (user_id, run_id, purpose, model, cost) VALUES (?, ?, 'chat', 'fake/model', 0.008)`, bob.id, r.id);
  assert.equal(spend.taskBudgetLeft(r.id, bob).left.toFixed(3), '0.002');
  assert.match(spend.taskCapRefusal(r.id, bob, 0.015, 'this picture'), /^Not done: this picture would cost about \$0\.015, and this task has \$0\.00 left of its \$0\.01 limit/);
  assert.equal(spend.taskCapRefusal(r.id, bob, 0.001, 'this picture'), null);
  assert.equal(spend.taskCapRefusal(null, bob, 5), null, 'outside a task: only the weekly budget applies');
  assert.throws(() => ocr.checkBudget(bob, 0.02, { runId: r.id }), /limit for one task/);
  assert.doesNotThrow(() => ocr.checkBudget(bob, 0.02));
  policy.setPolicy('user', bob.id, { toolsets: { core: 'allow', memory: 'allow', web: 'allow', schedule: 'allow', library: 'allow' },
    quietStart: '12:00', quietEnd: '12:00', weeklyBudget: 0, taskBudget: '' }, alice.id);
  assert.equal(policy.effectivePolicy(bob).taskBudget, 0.5, 'emptied: back to the default');
});

test('budget alerts: 75/90/100% of the weekly budget, each once per week; the unusual-day alert once a day; provider errors after 5', () => {
  policy.setPolicy('user', carol.id, { toolsets: { core: 'allow' }, weeklyBudget: 1 }, alice.id);
  const add = cost => run(`INSERT INTO usage_events (user_id, purpose, model, cost) VALUES (?, 'chat', 'fake/model', ?)`, carol.id, cost);
  const alerts = () => notifies(carol).filter(n => /budget/.test(n.tag || ''));
  add(0.5);
  assert.equal(spend.checkBudgetAlerts(carol), null);
  add(0.3);
  assert.equal(spend.checkBudgetAlerts(carol), 0.75);
  assert.equal(spend.checkBudgetAlerts(carol), null, 'once per level per week');
  add(0.12);
  assert.equal(spend.checkBudgetAlerts(carol), 0.9);
  add(0.2);
  assert.equal(spend.checkBudgetAlerts(carol), 1);
  assert.deepEqual(alerts().map(n => n.title), ['You’ve used 75% of this week’s budget', 'You’ve used 90% of this week’s budget', 'This week’s budget is used up']);
  assert.equal(alerts()[0].href, '/me/usage');
  // Next week it starts over.
  const nextWeek = new Date(Date.now() + 7 * 864e5);
  run(`UPDATE usage_events SET at = datetime(at, '+7 days') WHERE user_id = ?`, carol.id);
  assert.equal(spend.checkBudgetAlerts(carol, nextWeek), 1);
  run('DELETE FROM usage_events WHERE user_id = ?', carol.id);
  policy.setPolicy('user', carol.id, { toolsets: { core: 'allow' }, weeklyBudget: 0 }, alice.id);

  // A day far above the 14-day median, far in the future so nothing else in this file counts: once a day, to the admins.
  const day = n => new Date(Date.UTC(2031, 0, 20) - n * 864e5).toISOString().slice(0, 10);
  for (let i = 1; i <= 14; i++) run(`INSERT INTO usage_events (user_id, purpose, model, cost, at) VALUES (?, 'chat', 'm', 0.05, ?)`, carol.id, `${day(i)} 10:00:00`);
  run(`INSERT INTO usage_events (user_id, purpose, model, cost, at) VALUES (?, 'chat', 'm', 0.9, ?)`, carol.id, `${day(0)} 09:00:00`);
  const now = new Date(Date.UTC(2031, 0, 20, 12));
  const before = notifies(alice).length;
  assert.ok(spend.checkSpendSpike(now));
  assert.equal(spend.checkSpendSpike(now), null);
  const spike = notifies(alice).slice(before);
  assert.equal(spike.length, 1);
  assert.equal(spike[0].title, 'Unusual spending today');
  assert.match(spendSpikeCheck(now).detail, /^Today: \$0\.90, 18\.0× the 14-day median/, 'the doctor reads the same measure');
  run(`DELETE FROM usage_events WHERE at >= '2030-01-01'`);

  spend.__test.resetStreak();
  const b2 = notifies(alice).length;
  for (let i = 0; i < 6; i++) spend.providerOutcome(false, new Error('502 bad gateway'));
  const fails = notifies(alice).slice(b2).filter(n => n.tag === 'provider-errors');
  assert.equal(fails.length, 1);
  assert.match(fails[0].body, /5 calls in a row failed \(last: 502 bad gateway\)/);
  assert.equal(spend.providerOutcome(true), 0);
});

test('scheduled tasks pause after 3 failures in a row (a note and a push); a success resets the count; watches are not paused', async () => {
  const s = schedules.createSchedule({ user: alice, title: 'Daily report', prompt: 'Make the daily report.', cron: '0 7 * * *' });
  const fail = async () => go(alice, '[Scheduled task “Daily report”]', [{ error: 400 }], { origin: 'schedule', originLabel: 'Daily report', scheduleId: s.id, role: 'system' });
  await fail();
  await fail();
  assert.equal(schedules.getSchedule(s.id).fail_streak, 2);
  assert.equal(schedules.getSchedule(s.id).paused, 0);
  const ok = await go(alice, '[Scheduled task “Daily report”]', [{ text: 'The report is ready.' }], { origin: 'schedule', originLabel: 'Daily report', scheduleId: s.id, role: 'system' });
  assert.equal(ok.r.status, 'done');
  assert.equal(schedules.getSchedule(s.id).fail_streak, 0, 'a success resets');
  for (let i = 0; i < 3; i++) await fail();
  const after = schedules.getSchedule(s.id);
  assert.equal(after.paused, 1);
  const note = get(`SELECT * FROM runs WHERE schedule_id = ? AND error_kind = 'paused'`, s.id);
  assert.ok(note, 'a note in its chat');
  assert.match(reply(note.id), /^I’ve paused \*\*Daily report\*\*: it failed 3 times in a row/);
  assert.ok(notifies(alice).some(n => n.title === 'Paused “Daily report”' && n.href === '/upcoming'));
  schedules.pauseSchedule(after, false);
  assert.equal(schedules.getSchedule(s.id).fail_streak, 0, 'resuming starts the count over');
  // A watch keeps its own count of failed checks (and offers another way on the third): never paused by this rule.
  const w = schedules.createSchedule({ user: alice, title: 'Fare watch', prompt: 'Check the fare.', cron: '0 7 * * *', onlyWhen: 'the fare drops below 900' });
  for (let i = 0; i < 3; i++) {
    const t = threads.createSideThread(alice.id, 'Watch');
    const m = addMessage({ threadId: t.id, role: 'system', content: '[Watch “Fare watch”]' });
    const wr = runs.createRun({ threadId: t.id, userId: alice.id, triggerMessageId: m.id, model: 'fake/model', origin: 'schedule', originLabel: 'Fare watch', scheduleId: w.id, watch: true });
    llm.script = [{ error: 400 }];
    await loop.enqueueRun(wr.id);
    await settle(wr.id);
  }
  assert.equal(schedules.getSchedule(w.id).paused, 0);
  assert.equal(schedules.getSchedule(w.id).fail_streak, 3, 'its own count');
});

// ---- 5. The fallback chain, the answering model, the background model, the balance ------------------------------------------
test('fallback chain: `models` is sent on OpenRouter; the answering model is recorded in usage and on the run', async () => {
  settings.set('llm', { baseUrl: 'https://openrouter.ai/api/v1', model: 'fake/model', fallbacks: ['alt/model', 'spare/model'] });
  try {
    const x = await go(alice, 'Hello there', [{ text: 'Hi! How can I help?', model: 'alt/model' }]);
    assert.deepEqual(x.bodies[0].models, ['fake/model', 'alt/model', 'spare/model']);
    assert.equal(x.bodies[0].model, 'fake/model');
    const u = get('SELECT model, fallback FROM usage_events WHERE run_id = ? ORDER BY id DESC LIMIT 1', x.run.id);
    assert.deepEqual({ ...u }, { model: 'alt/model', fallback: 1 });
    assert.equal(runs.getRun(x.run.id).model, 'alt/model', 'the run says which model answered');
    const ov = usage.usageOverview([]);
    assert.ok(ov.fallbacks.count >= 1);
    assert.match(ov.fallbacks.label, /^Answered by a fallback \d+×$/);
    assert.deepEqual(llmSvc.answeredBy('fake/model', 'fake/model-20260901'), { model: 'fake/model', fallback: false }, 'a dated alias is the same model');
    assert.deepEqual(llmSvc.answeredBy('fake/model', 'someone/else'), { model: 'fake/model', fallback: false });
  } finally { settings.set('llm', { baseUrl: 'https://openrouter.ai/api/v1', model: 'fake/model' }); }
  settings.set('llm', { baseUrl: 'http://127.0.0.1:9/v1', model: 'fake/model', fallbacks: ['alt/model'] });
  assert.deepEqual(llmSvc.modelChoice('fake/model'), { model: 'fake/model' }, 'other endpoints: no `models`');
  settings.set('llm', { baseUrl: 'https://openrouter.ai/api/v1', model: 'fake/model' });
});

test('background model: JSON jobs run on it, and an unreadable answer or an error gets one retry on the main model', async () => {
  settings.set('llm', { baseUrl: 'https://openrouter.ai/api/v1', model: 'fake/model', background: 'cheap/model' });
  try {
    llm.jsonCalls.length = 0;
    llm.json = [{ content: 'not json', model: 'cheap/model' }, { content: '{"ok":1}', model: 'fake/model' }];
    assert.deepEqual(await llmSvc.jsonJob({ purpose: 'feed', messages: [{ role: 'user', content: 'x' }] }), { ok: 1 });
    assert.deepEqual(llm.jsonCalls.map(b => b.model), ['cheap/model', 'fake/model']);
    assert.deepEqual(llm.jsonCalls[0].models, ['cheap/model', 'fake/model']);
    const rows = all(`SELECT model, fallback FROM usage_events WHERE purpose = 'feed' ORDER BY id DESC LIMIT 2`).reverse().map(r => ({ ...r }));
    assert.deepEqual(rows, [{ model: 'cheap/model', fallback: 0 }, { model: 'fake/model', fallback: 0 }]);
    llm.json = [{ status: 400 }, { content: '{"ok":2}' }];
    assert.deepEqual(await llmSvc.askJson(alice, 'sys', 'x', { purpose: 'goals' }), { ok: 2 });
    llm.jsonCalls.length = 0;
    llm.json = [{ content: '{"ok":3}' }];
    assert.deepEqual(await llmSvc.askJson(alice, 'sys', 'x', { purpose: 'project', background: false }), { ok: 3 });
    assert.equal(llm.jsonCalls[0].model, 'fake/model', 'something the person waits on stays on the main model');
    llm.json = [{ content: 'nope' }, { content: 'still nope' }];
    await assert.rejects(llmSvc.jsonJob({ purpose: 'feed', messages: [] }), err => err.code === 'bad_json');
  } finally { settings.set('llm', { baseUrl: 'https://openrouter.ai/api/v1', model: 'fake/model' }); llm.json = []; }
});

test('Admin → Models: new fallbacks and a background model are tested before they are saved; a failing one saves neither', async () => {
  llm.json = [{ content: 'Ready.' }, { content: 'Ready.' }];
  const s = await llmSvc.saveModelSettings({ model: 'fake/model', baseUrl: 'https://openrouter.ai/api/v1', fallbacks: 'alt/model, spare/model', background: '' });
  assert.deepEqual(s.fallbacks, ['alt/model', 'spare/model']);
  llm.json = [{ status: 404 }];
  await assert.rejects(llmSvc.saveModelSettings({ model: 'fake/model', baseUrl: 'https://openrouter.ai/api/v1', fallbacks: 'alt/model', background: 'nope/model' }),
    err => err.status === 422 && /nope\/model didn’t answer/.test(err.data?.errors?.background || err.errors?.background || JSON.stringify(err)));
  assert.deepEqual(llmSvc.llmSettings().fallbacks, ['alt/model', 'spare/model'], 'left as they were');
  await assert.rejects(llmSvc.saveModelSettings({ model: 'fake/model', baseUrl: 'https://openrouter.ai/api/v1', fallbacks: 'a/1 b/2 c/3 d/4' }), err => err.status === 422);
  await assert.rejects(llmSvc.saveModelSettings({ model: 'fake/model', baseUrl: 'https://openrouter.ai/api/v1', fallbacks: 'bad model!' }), err => err.status === 422);
  settings.set('llm', { baseUrl: 'https://openrouter.ai/api/v1', model: 'fake/model' });
  llm.json = [];
});

test('balance: credits and the key’s limit give “Balance $X ≈ N days”, a warning under a week, and the provider-vs-recorded gap', async () => {
  run(`INSERT INTO usage_events (user_id, purpose, model, cost, at) VALUES (?, 'chat', 'm', 14, datetime('now', '-1 days'))`, carol.id); // ~$1 a day
  const week = get(`SELECT COALESCE(SUM(cost), 0) AS c FROM usage_events WHERE at >= date('now', '-6 days', 'weekday 1')`).c;
  or.credits = { total_credits: 10, total_usage: 4 };
  or.key = { limit: null, limit_remaining: null, usage: 100, usage_daily: 1, usage_weekly: week, usage_monthly: 30 };
  await spend.refreshBalance({ force: true });
  let b = spend.balanceView();
  assert.equal(b.balance, 6);
  assert.match(b.label, /^Balance \$6\.00 ≈ \d+ days?$/);
  assert.equal(b.warn, b.days < 7);
  assert.equal(b.gap, null);
  // Credits need a management key on some accounts (403): the key's own limit is used; the provider counts far more this week.
  or.creditsStatus = 403;
  or.key = { limit: 50, limit_remaining: 39.2, usage: 10.8, usage_daily: 1, usage_weekly: week + 25, usage_monthly: 40 };
  await spend.refreshBalance({ force: true });
  b = spend.balanceView();
  assert.equal(b.balance, 39.2);
  assert.match(b.gap, /another app or install may use the same key/);
  or.creditsStatus = 200;
  run(`DELETE FROM usage_events WHERE user_id = ? AND cost = 14`, carol.id);
});

// ---- 6. Routing from the message sense ---------------------------------------------------------------------------------------
test('routing: the sense picks a skill (the tail says so), an effort (sent to a model that takes one) and a careful topic', async () => {
  saveSkill({ name: 'aquarium-care', description: 'Looking after the family aquarium: fish tank water tests, feeding the goldfish, cleaning the aquarium filter.',
    body: '1. Test the water.\n2. Clean the filter.' }, alice.id);
  or.models = [{ id: 'fake/model', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools', 'reasoning'] }];
  resetPrices();
  await withJev((k, q) => ({ lang: ['en', 0.9], voice: 0.05, skill: ['aquarium-care', 0.9], effort: ['high', 0.9], field: ['none', 0.9],
    claimed: ['none', 0.9], denied: ['none', 0.9], promise: 0.1, gap: 0.1 })[k], async () => {
    const x = newRun(alice, 'The goldfish tank filter looks dirty, what should I do?');
    sense.senseTurn({ user: alice, run: x.run, message: x.message });
    assert.equal((await sense.awaitSense(x.run.id)).skill, 'aquarium-care');
    const turn = jev.calls.at(-1);
    assert.ok(Object.keys(turn.questions.skill.criteria).includes('aquarium-care'));
    assert.ok(Object.keys(turn.questions.skill.criteria).length <= 13, 'pre-filtered: at most 12 skills + none');
    llm.script = [{ text: 'Clean the filter with tank water.' }];
    const start = llm.streamed.length;
    await loop.enqueueRun(x.run.id);
    await settle(x.run.id);
    const body = llm.streamed[start];
    assert.equal(body.reasoning.effort, 'high');
    assert.match(tailOf(body), /## Skill for this\nThis looks like “aquarium-care” — call use_skill\("aquarium-care"\) first unless it clearly doesn't fit\./);
    assert.match(get(`SELECT outcome FROM decisions WHERE use = 'turn' ORDER BY id DESC LIMIT 1`).outcome, /skill “aquarium-care” \(0\.90\) · effort high/);
  });
  // A model that doesn't take a reasoning effort keeps the default.
  or.models = [{ id: 'fake/model', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }];
  resetPrices();
  await withJev({ lang: ['en', 0.9], effort: ['high', 0.9], field: ['none', 0.9], claimed: ['none', 0.9], denied: ['none', 0.9] }, async () => {
    const x = newRun(alice, 'Plan the week carefully');
    sense.senseTurn({ user: alice, run: x.run, message: x.message });
    await sense.awaitSense(x.run.id);
    llm.script = [{ text: 'Here is a plan.' }];
    const start = llm.streamed.length;
    await loop.enqueueRun(x.run.id);
    await settle(x.run.id);
    assert.equal(llm.streamed[start].reasoning.effort, 'low');
  });
  or.models = [];
  resetPrices();
});

test('routing without the decision model: keywords pick a clear skill and a careful topic (logged); one word is too little', () => {
  const t = threads.createSideThread(bob.id, 'Fish');
  const x = newRun(bob, 'my aquarium filter and the goldfish water tests need cleaning', { thread: t });
  const { messages } = buildPrompt({ user: bob, thread: t, owner: null, run: x.run });
  assert.match(messages.at(-1).content, /This looks like “aquarium-care”/);
  assert.match(get(`SELECT outcome, fallback FROM decisions WHERE use = 'turn' ORDER BY id DESC LIMIT 1`).outcome, /skill “aquarium-care” \(by keywords\)/);
  const h = newRun(bob, 'Can I take ibuprofen with my blood pressure pills?');
  const tail = buildPrompt({ user: bob, thread: h.thread, owner: null, run: h.run }).messages.at(-1).content;
  assert.match(tail, /## Careful topic: health\nExplain data and patterns; never diagnose/);
  assert.match(tail, /Never put their name or their condition into a web search/);
  assert.match(tail, /call their local emergency number now/);
  assert.equal(sense.keywordField('How do I get out of my lease early?'), 'legal');
  assert.equal(sense.keywordField('Should I pay off the loan or invest?'), 'money');
  assert.equal(sense.keywordField('What should we cook tonight?'), null);
  assert.equal(sense.keywordSkill('aquarium', [{ name: 'aquarium-care', description: 'aquarium fish' }]), null, 'one content word: no hint');
  const plain = newRun(bob, 'hi');
  assert.doesNotMatch(buildPrompt({ user: bob, thread: plain.thread, owner: null, run: plain.run }).messages.at(-1).content, /Skill for this|Careful topic/);
});

// ---- 7. Sources, the citation check, the Sources section -------------------------------------------------------------------
test('sources: search results and read pages are collected (normalised, dated); the trust chip summarises them', () => {
  const search = 'Web results for “x” (DuckDuckGo) — today is 26 Sep 2026:\n\n1. Council approves plan [found by 2 engines]\n   https://www.news.example/a?utm_source=x · dated 24 Sep 2026 (2 days ago)\n   snippet\n\n'
    + '2. Other story\n   https://other.example/b · date unknown';
  const found = sources.sourcesFrom('web_search', {}, search);
  assert.deepEqual(found.map(s => [s.url, s.kind, s.date, s.title]), [['https://news.example/a', 'search', '2026-09-24', 'Council approves plan'],
    ['https://other.example/b', 'search', null, 'Other story']]);
  assert.deepEqual(sources.sourcesFrom('web_read', { url: 'https://x.example' }, 'BLOCKED: the site refused'), []);
  const { run: r } = newRun(alice, 'News?');
  sources.noteSources(r.id, 'web_search', {}, search, {});
  sources.noteSources(r.id, 'web_read', { url: 'https://news.example/a' }, '# A\nNews · published 24 Sep 2026 (2 days ago)', { href: 'https://news.example/a', detail: 'Council approves plan' });
  const list = sources.sourcesOf(r.id);
  assert.equal(list.length, 2);
  assert.equal(list.find(s => s.url === 'https://news.example/a').kind, 'read', 'a read upgrades the search hit');
  const chip = sources.trustChip(list, new Date('2026-09-26T12:00:00Z'));
  assert.equal(chip.label, 'Checked 1 source · 1 site · newest 2 days old');
  assert.equal(runs.runView(runs.getRun(r.id)).sources.checked, 1);
  assert.equal(sources.trustChip([]), null);
  assert.match(sources.sourcesSection(list), /^## Sources\n- \[Council approves plan\]\(https:\/\/news\.example\/a\) · news\.example · 2026-09-24$/);
  assert.equal(sources.hasSourcesSection('# Report\n\n## Sources\n- a'), true);
  assert.equal(sources.stripLinks('See [this deal](https://made-up.example/deal) or https://made-up.example/deal now.', [{ raw: 'https://made-up.example/deal' }]),
    'See this deal or now.');
});

test('citation check (loop): links the task never saw get one re-prompt, then are taken out; seen links and theirs stay', async () => {
  const text = 'See [the fares](https://fares.example/list) and [this deal](https://made-up.example/deal).';
  const x = await go(alice, 'Find me fares', [{ tool: 'test_page' }, { text }, { text }]);
  assert.equal(x.calls, 3);
  assert.match(systemOf(x.run.id)[0], /^\[Check your links\] Your reply links to pages you haven’t opened in this task: https:\/\/made-up\.example\/deal\./);
  assert.ok(labels(x.run.id).includes('Checking the links'));
  assert.equal(reply(x.run.id), 'See [the fares](https://fares.example/list) and this deal.');
  const mine = await go(alice, 'Is https://mine.example/page any good?', [{ text: 'Yes, https://mine.example/page looks fine.' }]);
  assert.equal(mine.calls, 1, 'a link the person wrote is fine');
  const app = await go(alice, 'Where is it?', [{ text: 'Here: http://127.0.0.1:3737/library/abc' }]);
  assert.equal(app.calls, 1, 'app links are fine');
});

test('Sources section: a Markdown document written after reading pages gets one, built in code; one that has one keeps its own', async () => {
  const x = await go(alice, 'Write me a report on the council news', [{ tool: 'test_web_read', args: { url: 'https://news.example/a' } },
    { tool: 'library_create', args: { title: 'Council report', type: 'md', content: '# Council report\nThe plan was approved.' } },
    { text: "I've saved the report to your Library." }]);
  assert.equal(x.calls, 3, 'the claim is backed by library_create: no push');
  const item = get(`SELECT * FROM library_items WHERE title = 'Council report' ORDER BY id DESC LIMIT 1`);
  assert.match(library.readText(item), /The plan was approved\.\n\n## Sources\n- \[News A\]\(https:\/\/news\.example\/a\) · news\.example · 2026-09-24/);
  const y = await go(alice, 'And a short one', [{ tool: 'test_web_read', args: { url: 'https://news.example/a' } },
    { tool: 'library_create', args: { title: 'Short report', type: 'md', content: '# Short\nApproved.\n\nSources:\n- the council site' } }, { text: 'Done.' }]);
  assert.equal(y.r.status, 'done');
  const own = get(`SELECT * FROM library_items WHERE title = 'Short report' ORDER BY id DESC LIMIT 1`);
  assert.doesNotMatch(library.readText(own), /## Sources/);
});

// ---- 8. The wish log ---------------------------------------------------------------------------------------------------------
test('wish log: the same ask counts up (by its words), a different one is new; a denial outside the toolsets records one', async () => {
  const a = wishes.recordWish(alice.id, 'Call the pizza place and order a large margherita');
  const b = wishes.recordWish(alice.id, 'order a margherita from the pizza place, call them');
  assert.equal(b.id, a.id);
  assert.equal(b.count, 2);
  const c = wishes.recordWish(alice.id, 'Turn on the living room lights');
  assert.notEqual(c.id, a.id);
  assert.equal(wishes.recordWish(bob.id, 'Call the pizza place and order a large margherita').created, true, 'per person');
  assert.equal(wishes.wishesView()[0].count, 2);
  const x = await go(alice, 'Order me a pizza from Luigi’s', [{ text: "I can't order food for you, but here is Luigi's number." }]);
  const w = get('SELECT * FROM wishes WHERE run_id = ?', x.run.id);
  assert.equal(w.id, a.id, 'ordering pizza again is the same wish (its words), counted');
  assert.equal(w.count, 3);
  const y0 = await go(alice, 'Please book me a taxi to the airport', [{ text: "I can't book taxis for you." }]);
  assert.equal(get('SELECT text FROM wishes WHERE run_id = ?', y0.run.id).text, 'Please book me a taxi to the airport');
  await withJev({ gap: 0.95, claimed: ['none', 0.9], denied: ['none', 0.9], promise: 0.1 }, async () => {
    const y = await go(alice, 'Turn on the living room lights please', [{ text: "I can't control your lights." }]);
    const again = get('SELECT * FROM wishes WHERE run_id = ?', y.run.id);
    assert.equal(again.id, c.id, 'the same wish, counted again');
    assert.equal(again.count, 2);
  });
});

// #217: a tool whose success hands the next step to the person (project_propose's Create card) — a reply asking them to press
// it is the result, even when the decision model reads it as "not delivered" (seen: "Not done yet" after the project card, then
// unrelated browser steps).
registerTool({ name: 'test_card', toolset: 'core', risk: 'write', handsOver: true, description: 'Draft a card they press.',
  label: () => 'Drafted a project', parameters: { type: 'object', properties: {} }, run: () => 'A "New project" card is under your reply.' });
test('goal gate: after a hands-over tool (a card they press) the reply finishes; the same verdict after a plain step pushes', async () => {
  await withJev({ delivered: 0.1, theirs: 0.2, question: 0.1, constraints_met: 0.5, claimed: ['none', 0.9], denied: ['none', 0.9], promise: 0.1, gap: 0.1 }, async () => {
    const card = await go(alice, 'Let’s start a new woodwork project', [{ tool: 'test_card' }, { text: 'Press Create on the project card to start it.' }]);
    assert.equal(card.calls, 2, 'no push after the card');
    assert.ok(!labels(card.run.id).some(l => /Not done yet/.test(l)));
    const plain = await go(alice, 'Find me a flight', [{ tool: 'test_look' }, { text: 'Here is what I found.' }, { text: 'Flight EK748 at 15:30.' }]);
    assert.ok(plain.calls > 2 && labels(plain.run.id).some(l => /Not done yet/.test(l)), 'the same verdict after a plain step is pushed');
  });
});
