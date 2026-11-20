// Decision #219: admin oversight of other people's chats becomes a setting, off for new installs. An install that already
// has accounts keeps the behaviour it had (admins could read chats, and members were told so), until the admin changes it.
export async function up({ get, run }) {
  const users = get('SELECT COUNT(*) AS n FROM users')?.n || 0;
  const existing = get(`SELECT value FROM settings WHERE key = 'oversight'`);
  if (users > 0 && !existing) {
    run(`INSERT INTO settings (key, value, updated_at) VALUES ('oversight', ?, datetime('now'))`,
      JSON.stringify({ readChats: true, changedAt: new Date().toISOString(), changedBy: null, keptFromBefore: true }));
  }
}
