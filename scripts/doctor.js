// The health check from a terminal (a server without a browser, or before starting): `npm run doctor`.
// Same checks as Admin → System, minus the ones only the running server knows (scheduler heartbeat, its error log).
// Exit code 0 = healthy or warnings, 1 = something needs fixing.
// A data folder that was never set up is refused with a message (scripts/lib/instance.js, #82).
import { openInstance } from './lib/instance.js';

await openInstance();
await import('../src/agent/tools/index.js'); // the tool registry: security checks name tools and read their risk
const { doctor, aboutSystem } = await import('../src/services/system.js');
const h = doctor({ cli: true });
const a = aboutSystem();
const mark = { ok: '✓', warn: '!', bad: '✗' };
console.log(`\nJessbot ${a.version || ''}${a.commit ? ` (${a.commit})` : ''} · data: ${a.dataDir}\n`);
for (const c of h.checks) {
  console.log(`  ${mark[c.status]} ${c.label.padEnd(16)} ${c.detail}`);
  if (c.fix && c.status !== 'ok') console.log(`    ${''.padEnd(16)} → ${c.fix}`);
}
console.log(`\n${h.summary}.\n`);
process.exit(h.status === 'bad' ? 1 : 0);
