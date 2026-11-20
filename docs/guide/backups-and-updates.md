# Backups and updates

Everything your household keeps in Jessbot (chats, memories, the Library, goals, the feed, settings) lives in one
folder on your machine. Jessbot backs that up on its own every day, applies its own database changes safely when you
update, and moves to a new machine as a folder copy. This page covers all three, and what to copy so you never lose the
lot to one broken disk.

## Daily backups

Jessbot makes a full backup once a day and keeps the last 7. It checks when it starts and then every hour, so a machine
that is off at night still gets one when it's back on. Each backup is a single `.tar.gz` file in `data/backups/` (in
Docker, inside the `jessbot-data` volume).

A backup holds the database, the assistant's workspace files, each person's files and memories, the Library, uploads,
feed pictures, screenshots, voice notes and the assistant's pictures. It leaves out on purpose:

- **Browser sign-ins** (the cookies of sites the assistant is signed in to), so a backup file can't be used to sign in
  as you.
- **The install key** (`JESSBOT_SECRET` in `.env`, or the key file `JESSBOT_SECRET_FILE` names), which encrypts saved
  mail and calendar passwords, two-step sign-in codes and the model key. Those are in the backup, but only encrypted.
  Keep a copy of `.env` (or the key file) somewhere safe yourself: without it, a restored install can't open them, and
  you'd have to reconnect the mail and calendar accounts and enter the model key again.
- Logs and caches.

You can see the backups in **Admin → System → Backups**, make one straight away with **Back up now**, and **Download**
any of them. Backups made by hand are kept too (up to 20).

## Keep a copy somewhere else

A backup on the same disk doesn't help if that disk dies. Every so often, copy the newest file from `data/backups/`
(or download it from Admin → System) to another drive, a NAS or cloud storage, together with your `.env`. Treat both
like private documents: the backup contains everyone's chats.

## Restoring a backup

1. Stop Jessbot. The restore refuses to run while something is listening on Jessbot's port.
2. In the Jessbot folder, list the backups, newest first:

   ```bash
   npm run restore
   ```

3. Restore the one you want by its name (or the path to a file you copied back):

   ```bash
   npm run restore -- jessbot-auto-2026-11-19T03-00-00.tar.gz
   ```

4. Start Jessbot again.

The restore unpacks the backup and checks its database before it touches anything. Only then does it move your current
data aside to `data/backups/before-restore-<time>/` and put the backup in its place. Nothing is deleted, so to undo a
restore, move those folders back.

These steps are for a Node.js install. Restoring inside the Docker container isn't documented yet; until it is, keep
downloaded copies of your backups so nothing is lost.

## Updating

Updates come from the git repository. With Node.js, in the Jessbot folder:

```bash
git pull
npm ci && npm run build
```

Then restart Jessbot: stop it (Ctrl+C in its terminal) and run `npm start` again, or `sudo systemctl restart jessbot`
if you use the systemd service from [INSTALL.md](../INSTALL.md).

With Docker, there's no published image yet, so you rebuild it from the updated code:

```bash
git pull
docker compose up -d --build
```

Admin → System → About this Jessbot shows the version you're running.

### Database changes on start

Some updates change the database. Jessbot applies those changes itself the next time it starts, and before it does,
it saves a copy of the database to `data/backups/pre-migrate-<time>.sqlite` (the last 10 are kept). Each change either
applies completely or not at all. If one fails, Jessbot leaves the database exactly as it was and refuses to start,
with a message naming the change and the backup. Copy that message when you ask for help.

Jessbot also refuses to start on a database from a newer version than its code, rather than damage it. To go back to
an older version after an update, check out the older code and restore the snapshot taken before the update (with
Jessbot stopped):

```bash
npm run restore -- pre-migrate-<time>.sqlite
```

That restores the database only; your files stay as they are.

## Moving to another machine

1. Stop Jessbot.
2. Copy the whole Jessbot folder, including `data/` and `.env`. With Docker, copy the `jessbot-data` volume, which
   holds the data and the `.env` with the install key (or, if you keep the key in a Docker secret, bring that too).
3. On the new machine, install Node.js 24.19 or newer (or Docker) and start Jessbot from the copied folder.

If the new machine runs a different operating system, run `npm ci && npm run build` there before the first start, since
some packages are built for each system. Running `npm run doctor` afterwards checks that the database, the model key,
the browser and the password key are all in order (see [Troubleshooting](troubleshooting.md#run-the-health-check)).

To keep the data on a bigger disk than the code, set `JESSBOT_HOME` in `.env` to that folder.

Related: [Guide index](README.md) · [Getting started](getting-started.md) · [People and admin](people-and-admin.md) ·
[Troubleshooting](troubleshooting.md) · [FAQ](faq.md)
