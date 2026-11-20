import { config, ensureDirs, paths } from './src/config/index.js';
import { installLog } from './src/lib/log.js';
import { openDb, MigrationError } from './src/db/index.js';
import { createApp } from './src/app.js';
import { claimCodeIfNeeded } from './src/services/setup.js';
import { attachWebSocket } from './src/realtime/ws.js';
import { recoverRuns, startApprovalExpiry } from './src/agent/loop.js';
import { closeBrowser } from './src/browser/index.js';
import { startScheduler } from './src/agent/proactive.js';
import { startAutoBackup } from './src/services/system.js';

ensureDirs();
installLog(paths.logs); // Admin → System → Logs + data/logs/*.log
try {
  await openDb();
} catch (err) {
  if (!(err instanceof MigrationError)) throw err;
  console.error(`\n[db] ${err.message}\n`);
  process.exit(1);
}

const app = createApp();
const server = app.listen(config.port, config.host, () => {
  console.log(`[jessbot] listening on http://${config.host}:${config.port}`);
  const code = claimCodeIfNeeded();
  if (code) {
    console.log(`[jessbot] first run — open http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}/setup`);
    console.log(`[jessbot] setup code (asked when you create the admin account): ${code}`);
  }
});
attachWebSocket(server);
recoverRuns(); // runs interrupted by a restart are marked failed (with Retry), never left spinning
startApprovalExpiry(); // unanswered approvals expire → treated as declined
startScheduler();     // alarms, reminders, timers, scheduled tasks, check-ins
startAutoBackup();    // a full backup a day, kept a week (Admin → System)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[jessbot] ${signal} — shutting down`);
    closeBrowser().finally(() => server.close(() => process.exit(0)));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
