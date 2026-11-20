// DEV: agent evaluation (Phase 23, decision #173; the mcp-builder evaluation method). Seeds a THROWAWAY data dir with
// household fixtures (three PDFs, a budget spreadsheet, alarms, a reminder, a shopping list and a to-do list), then asks
// the REAL agent loop, with the REAL model, ~10 read-only questions whose answers are known, each in a fresh side chat.
// Answers are checked by string match. Every question also asks the model for a <feedback> block about tool names,
// parameters and results that confused it: that feedback is the input for tool-description hygiene.
//   npm run eval:agent                       prints the plan and the estimated cost, runs nothing
//   npm run eval:agent -- --yes              runs every question once
//   npm run eval:agent -- --yes --runs 3     each question 3 times (1–3)
//   npm run eval:agent -- --yes --only pdf-most-pages,budget-march   some questions only
//   --model <id>  another chat model · --out <file.json>  also write the results as JSON
// Needs OPENROUTER_KEY in .env (copied into the throwaway dir). Nothing touches data/ or the running servers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const RUNS = Number(opt('runs') || 1);
if (!Number.isInteger(RUNS) || RUNS < 1 || RUNS > 3) { console.error('--runs takes 1, 2 or 3.'); process.exit(2); }
const ONLY = opt('only') ? new Set(opt('only').split(',').map(s => s.trim())) : null;

// ---- A throwaway install (set up before any app module loads: config reads these at import) --------------------------
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-eval-'));
if (fs.existsSync(path.join(ROOT, '.env'))) fs.copyFileSync(path.join(ROOT, '.env'), path.join(HOME, '.env'));
Object.assign(process.env, { JESSBOT_HOME: HOME, JESSBOT_ENV_FILE: path.join(HOME, '.env'), JESSBOT_EMBED_OFF: '1', JESSBOT_EXTRACT_DELAY_MS: '86400000' });
const cleanup = () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* a file still open on Windows: the OS temp cleaner takes it */ } };

const { ensureDirs } = await import('../src/config/index.js');
const { openDb, closeDb, settings, run: sql, get, all } = await import('../src/db/index.js');
ensureDirs();
await openDb();
const { createUser, getUser } = await import('../src/services/users.js');
const { setPolicy, enabledToolsets } = await import('../src/services/policy.js');
const { writeIdentity } = await import('../src/services/workspace.js');
const { completeSetup } = await import('../src/services/setup.js');
const { storeFile } = await import('../src/services/uploads.js');
const { makeWorkbook } = await import('../src/services/office.js');
const { createAlarm } = await import('../src/services/alarms.js');
const { createList, addItems, checkItems } = await import('../src/services/lists.js');
const { createSideThread } = await import('../src/services/threads.js');
const { llmSettings } = await import('../src/services/llm.js');
const { modelPrice, estimateCost, dollars } = await import('../src/services/model-price.js');
const { countMessages, countTokens } = await import('../src/lib/tokens.js');
const { buildPrompt } = await import('../src/agent/prompt.js');
const { toolSchemasFor } = await import('../src/agent/tools/registry.js');
await import('../src/agent/tools/index.js');
const loop = await import('../src/agent/loop.js');
const { PDFDocument, StandardFonts } = await import('@cantoo/pdf-lib');

if (!llmSettings().apiKey) { console.error('No OPENROUTER_KEY in .env: the evaluation needs the real model.'); cleanup(); process.exit(2); }
if (opt('model')) settings.set('llm', { model: opt('model') });
const MODEL = llmSettings().model;

// ---- Fixtures ----------------------------------------------------------------------------------------------------------
const TZ = 'Europe/London';
writeIdentity({ name: 'Jess', variant: 'female', tone: 'warm', description: '' });
completeSetup();
const owner = await createUser({ name: 'Sam Eval', email: 'sam@eval.test', password: 'correct horse battery staple', role: 'admin' });
sql('UPDATE users SET timezone = ? WHERE id = ?', TZ, owner.id);
setPolicy('user', owner.id, { toolsets: { core: 'allow', memory: 'allow', library: 'allow', files: 'allow', office: 'allow', schedule: 'allow', lists: 'allow', goals: 'off', web: 'off', email: 'off', calendar: 'off', projects: 'off' },
  quietStart: '12:00', quietEnd: '12:00', weeklyBudget: 0 }, owner.id);
const user = getUser(owner.id);

async function pdf(pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage([595, 842]);
    lines.forEach((l, i) => page.drawText(l, { x: 56, y: 780 - i * 18, size: 12, font }));
  }
  return Buffer.from(await doc.save());
}
const filler = n => Array.from({ length: n }, (_, i) => [`Section ${i + 2}`, 'Keep this manual near the appliance.']);
await storeFile(user, { name: 'Boiler manual.pdf', buffer: await pdf([['Combi boiler: user manual', 'Service it once a year.'], ...filler(6)]) });
await storeFile(user, { name: 'Tenancy agreement.pdf', buffer: await pdf([['Tenancy agreement', 'Flat 2, 14 Mill Lane'], ['Rent: 950 pounds a month, due on the 1st.'],
  ['The tenant pays a deposit of 1,200 pounds, held in a protection scheme.'], ['Signed by both parties.']]) });
await storeFile(user, { name: 'School trip letter.pdf', buffer: await pdf([['Dear parents,', 'Year 4 visits the Science Museum on 14 October.'], ['Please send a packed lunch.']]) });
const budget = await makeWorkbook([{ name: 'Budget', columns: [{ header: 'Month' }, { header: 'Rent', format: 'currency' }, { header: 'Food', format: 'currency' },
  { header: 'Bills', format: 'currency' }, { header: 'Total', format: 'currency' }],
rows: [['January', 950, 390.2, 210, '=SUM(B2:D2)'], ['February', 950, 370, 195.4, '=SUM(B3:D3)'], ['March', 950, 412.35, 180.5, '=SUM(B4:D4)'],
  ['April', 950, 401, 160, '=SUM(B5:D5)']] }], { title: 'Family budget 2026' });
await storeFile(user, { name: 'Family budget 2026.xlsx', buffer: budget.buffer });
// Tomorrow in the person's timezone.
const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + 864e5));
for (const [time, label] of [['06:30', 'Gym'], ['07:45', 'School run'], ['09:15', 'Call the plumber']]) createAlarm({ user, kind: 'alarm', label, at: `${tomorrow}T${time}`, createdBy: 'user' });
createAlarm({ user, kind: 'reminder', label: 'Put the bins out', at: `${tomorrow}T18:00`, createdBy: 'user' });
const { list: shopping } = createList(user, { title: 'Shopping', kind: 'shopping' });
addItems(user, shopping.id, ['milk', 'eggs', 'bread', 'bananas', 'washing-up liquid']);
const { list: todo } = createList(user, { title: 'To-do', kind: 'todo' });
addItems(user, todo.id, ['renew car insurance', 'book dentist', 'fix the fence', 'return library books']);
checkItems(user, todo.id, ['book dentist']);

// ---- Questions (read-only, verifiable) ---------------------------------------------------------------------------------
// expect: every pattern must match the answer (the <feedback> block removed first).
const QUESTIONS = [
  { id: 'pdf-most-pages', q: 'Which PDF in my Library has the most pages?', expect: [/boiler/i] },
  { id: 'pdf-page-count', q: 'How many pages does the boiler manual have?', expect: [/\b7\b|seven/i] },
  { id: 'lease-deposit', q: 'How much is the deposit in the tenancy agreement?', expect: [/1,?200/] },
  { id: 'school-trip-date', q: 'What date is the school trip in the letter from school?', expect: [/14(?:th)? October|October 14/i] },
  { id: 'budget-march', q: 'What total does the budget sheet give for March?', expect: [/1,?542\.85/] },
  { id: 'budget-highest', q: 'Which month has the highest total in the budget sheet?', expect: [/january/i] },
  { id: 'alarm-after-7', q: 'Which alarm fires next after 7 am tomorrow?', expect: [/school run/i] },
  { id: 'alarm-time', q: 'What time is my "Call the plumber" alarm?', expect: [/9[:.]15|09[:.]15/] },
  { id: 'reminder-tomorrow', q: 'Do I have a reminder tomorrow? What is it for?', expect: [/bins/i] },
  { id: 'shopping-list', q: 'What\'s on the shopping list?', expect: [/milk/i, /eggs/i, /bread/i, /banana/i, /washing/i] },
  { id: 'todo-left', q: 'How many things are still left to do on my to-do list?', expect: [/\b3\b|three/i] },
].filter(x => !ONLY || ONLY.has(x.id));
if (!QUESTIONS.length) { console.error(`No question matches --only. Ids: ${QUESTIONS.map(x => x.id).join(', ')}`); cleanup(); process.exit(2); }
const FEEDBACK_ASK = '\n\n(After your answer, add a short <feedback></feedback> block about this task: which of your tools, their names, '
  + 'parameters or results were confusing, missing or slowed you down, and what would have helped. Write "none" inside it if nothing did.)';

// ---- The cost, first -----------------------------------------------------------------------------------------------------
const STEPS_PER_QUESTION = 3; // a tool call or two, then the answer (each step resends the prompt)
const probe = createSideThread(user.id, 'probe');
const promptTokens = countMessages(buildPrompt({ user, thread: probe, owner: user }).messages, MODEL)
  + countTokens(JSON.stringify(toolSchemasFor(user, { toolsets: enabledToolsets(user) })), MODEL);
const price = await modelPrice(MODEL);
const totalPrompt = promptTokens * STEPS_PER_QUESTION * QUESTIONS.length * RUNS;
const totalCompletion = 700 * QUESTIONS.length * RUNS;
const estimate = estimateCost(price, { promptTokens: totalPrompt, completionTokens: totalCompletion });
console.log(`Agent evaluation: ${QUESTIONS.length} questions × ${RUNS} run${RUNS > 1 ? 's' : ''} with ${MODEL}`);
console.log(`  prompt ≈ ${promptTokens.toLocaleString('en')} tokens a step, ~${STEPS_PER_QUESTION} steps a question`);
console.log(`  estimated cost: ${dollars(estimate)}${price ? '' : ' (no price known for this model)'} (the decision model adds a little; cached prompts cost less)`);
if (!flag('yes')) { console.log('\nNothing ran. Add --yes to run it.'); closeDb(); cleanup(); process.exit(0); }

// ---- Run ----------------------------------------------------------------------------------------------------------------
const results = [];
const started = Date.now();
for (const item of QUESTIONS) {
  for (let r = 1; r <= RUNS; r++) {
    const thread = createSideThread(user.id, item.id);
    const t0 = Date.now();
    const { run: queued } = loop.startTurn({ user, thread, text: item.q + FEEDBACK_ASK });
    await loop.drainRuns();
    const done = get('SELECT * FROM runs WHERE id = ?', queued.id);
    const reply = get(`SELECT content FROM messages WHERE run_id = ? AND role = 'assistant' AND content != '' ORDER BY id DESC LIMIT 1`, queued.id)?.content || '';
    const feedback = [...reply.matchAll(/<feedback>([\s\S]*?)<\/feedback>/gi)].map(m => m[1].trim()).join('\n');
    const answer = reply.replace(/<feedback>[\s\S]*?(?:<\/feedback>|$)/gi, '').trim();
    // Each tool call with its arguments and the start of its result: what a failed answer was built on.
    const results_ = new Map(all(`SELECT tool_call_id, content FROM messages WHERE run_id = ? AND role = 'tool'`, queued.id).map(x => [x.tool_call_id, x.content]));
    const steps = all(`SELECT tool_calls FROM messages WHERE run_id = ? AND role = 'assistant' AND tool_calls IS NOT NULL ORDER BY id`, queued.id)
      .flatMap(x => JSON.parse(x.tool_calls)).map(c => ({ tool: c.function?.name, args: c.function?.arguments, result: String(results_.get(c.id) ?? '').slice(0, 600) }));
    const tools = steps.map(s => s.tool);
    const usage = get('SELECT COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(prompt_tokens), 0) AS p, COUNT(*) AS calls FROM usage_events WHERE run_id = ?', queued.id);
    const pass = done.status === 'done' && item.expect.every(re => re.test(answer));
    results.push({ id: item.id, run: r, question: item.q, pass, status: done.status, error: done.error || null, tools, steps, answer, feedback,
      seconds: Math.round((Date.now() - t0) / 1000), cost: usage.cost, calls: usage.calls, promptTokens: usage.p });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${item.id}${RUNS > 1 ? ` #${r}` : ''}  ${Math.round((Date.now() - t0) / 1000)}s  ${dollars(usage.cost)}  tools: ${tools.join(', ') || 'none'}`);
    if (!pass) console.log(`      ${done.status !== 'done' ? `run ${done.status}${done.error ? `: ${done.error}` : ''} · ` : ''}answer: ${answer.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
}

// ---- Report -------------------------------------------------------------------------------------------------------------
const passed = results.filter(x => x.pass).length;
const spent = results.reduce((s, x) => s + x.cost, 0);
const allUsage = get('SELECT COALESCE(SUM(cost), 0) AS c FROM usage_events').c; // the decision model's calls too
console.log(`\n${passed}/${results.length} passed in ${Math.round((Date.now() - started) / 1000)}s · chat ${dollars(spent)} · all model calls ${dollars(allUsage)}`);
console.log('\nTool feedback from the model:');
for (const x of results) {
  if (x.feedback && !/^none\.?$/i.test(x.feedback)) console.log(`- ${x.id}${RUNS > 1 ? ` #${x.run}` : ''}: ${x.feedback.replace(/\s+/g, ' ')}`);
}
if (opt('out')) {
  fs.writeFileSync(path.resolve(opt('out')), JSON.stringify({ model: MODEL, at: new Date().toISOString(), runs: RUNS, passed, total: results.length, cost: spent, allCost: allUsage, results }, null, 2));
  console.log(`\nResults written to ${path.resolve(opt('out'))}`);
}
closeDb();
cleanup();
process.exit(passed === results.length ? 0 : 1);
