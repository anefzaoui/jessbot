// npm run reset-link -- <email>   a one-time password reset link for that account (decision #225).
// For the person who runs Jessbot when they are the one locked out: being able to run commands on the server is the proof.
// The link works once, for 24 hours, and is built from PUBLIC_URL (else this machine's address). Nothing is printed to the
// server log; it is shown here only. Works while Jessbot is running (the database is shared safely).
import { ensureDirs, config } from '../src/config/index.js';
import { openDb, closeDb, get } from '../src/db/index.js';

const email = process.argv.slice(2).find(a => !a.startsWith('-'));
if (!email) {
  console.error('Usage: npm run reset-link -- <email>');
  process.exit(2);
}
ensureDirs();
await openDb();
const { createResetLink } = await import('../src/services/password-reset.js');
const user = get('SELECT id, name, status FROM users WHERE email = ?', email.trim());
if (!user) {
  console.error(`No account with the email ${email}.`);
  process.exitCode = 1;
} else if (user.status !== 'active') {
  console.error(`${user.name}'s account is disabled: re-enable it first (Admin → People), or ask another admin.`);
  process.exitCode = 1;
} else {
  const { url, expiresAt } = createResetLink(user.id, { base: config.publicUrl });
  console.log(`Reset link for ${user.name} (works once, until ${expiresAt} UTC):\n\n  ${url}\n`);
  if (!process.argv.includes('--2fa-off')) {
    console.log('Two-step sign-in, if on, stays on. Lost the phone too? Another admin can turn it off, or run: npm run reset-link -- <email> --2fa-off');
  } else {
    const { disableTwoFactor } = await import('../src/services/twofactor.js');
    disableTwoFactor(user.id, { actorId: null });
    console.log('Two-step sign-in is now off for this account.');
  }
}
closeDb();
