# Troubleshooting

Most problems with a new install come down to a handful of settings: the setup code, the model key, the browser, and
the address other devices use. This page lists the common ones with what you'll see and how to fix it. When something
isn't on this list, start with the health check and the log.

## Run the health check

Admin → System starts with a health check, and the Overview page shows its summary. From a terminal on the server (with
or without Jessbot running), the same checks run with:

```bash
npm run doctor
```

It checks the database (its integrity and whether updates are applied), free disk space, the model key (and the
OpenRouter balance), the browser, whether LibreOffice previews are available, tasks stuck for over 30 minutes, failing
feed sources, how old the last backup is, skills waiting for review, the security settings (local network,
always-allowed actions, the password key, skill warnings, hidden instructions found in pages or email, spending), the
network address it listens on, and the Node.js version. Each problem comes with what to do about it. It ends with
"Everything looks healthy", "Working, with things to look at" or "Something needs fixing".

## Where the logs are

- **Admin → System → Server log** shows the log live, with **Errors**, **Warnings** and **Everything**, and a filter.
- On disk: `data/logs/jessbot-<date>.log`, one file a day, kept 14 days. They're also downloadable under the live log.
- With Docker: `docker compose logs jessbot`. With the systemd service: `journalctl -u jessbot`.

Jessbot removes API keys, passwords and sign-in cookies from log lines before writing them, so a log is safe to share
when you ask for help. Read it through anyway before you post it publicly.

## I lost the setup code

The setup code is printed in the server's log each time Jessbot starts, until the admin account exists. Look for the
line `setup code (asked when you create the admin account)`:

- Started with `npm start`: it's in that terminal, and in today's file in `data/logs/`.
- Docker: `docker compose logs jessbot | grep "setup code"`.
- systemd: `journalctl -u jessbot | grep "setup code"`.

## The setup page keeps refusing the code

"That code doesn't match the one printed in the server console" usually means the code is from an earlier start. Each
start prints a new code, so use the one from the latest start. Upper or lower case doesn't matter.

To choose your own code instead, set `JESSBOT_SETUP_CODE` in `.env` to something of 8 or more characters and restart.
`JESSBOT_SETUP_CODE=off` turns the code off, but only do that if nobody else can reach the server before you finish
setting it up.

## The model test fails

The **Test the connection** button on the setup page (and saving in Admin → Models) says what went wrong:

- **"No API key yet."** Paste your key in the key field.
- **"The API key was rejected."** The key is wrong or was revoked. Make a new one with your provider.
- **"The account is out of credits."** Top up your account with the provider.
- **"The model … wasn't found on this endpoint."** The model id is misspelled, or this provider doesn't offer it. Copy
  the id exactly from the provider's model list (on OpenRouter it looks like `openai/gpt-6-luna`).
- **It can't reach the endpoint.** Check the provider's address (the **Address** field under the provider you picked),
  and that the machine is online. OpenRouter's is `https://openrouter.ai/api/v1`, Ollama's on this computer
  `http://127.0.0.1:11434/v1`.
- **It was rate limited.** Wait a minute and press the button again.
- **"Check the context window" or "The context window is too small"** (Ollama, under "Connected"). The connection works,
  but Ollama gives the model less context than Jessbot's instructions need, so real messages would be cut. Set
  `OLLAMA_CONTEXT_LENGTH=32768` on the Ollama server and restart it: see
  [Models and costs](providers.md#give-ollama-a-context-of-32768-tokens).

Ollama needs no key, and neither does a model server on your own network (LM Studio, say): the key field is hidden or
can stay empty. More in [Models and costs](providers.md).

## Local models call tools at random or answer "…"

With Ollama's default context the model only sees the end of Jessbot's prompt (`truncating input prompt` in Ollama's
log). Jessbot stops such a task with "The model only read … of the about … tokens I sent", or before it starts with "The
model's context window is too small", and says what to set; the fix is the same as above.

## Web lookups, the Feed or weather don't work

The assistant needs a browser for everything on the web. Without one, chat, files, the Library, reminders, lists and
mail still work, but web lookups, the Feed, weather and places, and exporting pages to PDF or PNG don't.

- If Google Chrome is installed on the machine, Jessbot uses it.
- Otherwise press **Install browser** in **Admin → Browser** (or on the setup page), or run `npm run browser:install` on
  the server. It downloads open-source Chromium once into `tools/ms-playwright`, about 200 MB.
- The Docker image already includes Chromium.

Admin → Browser shows which browser is in use and whether it works, and **Try it** runs a search or a screenshot the
same way the assistant would.

## A site refuses the assistant's browser

A few sites (some airlines and shops) block automated browsers. For those, Admin → Browser can switch the **Browser
engine** to **CloakBrowser**, a Chromium build with stealth patches. It's optional and downloaded separately (about 500
MB into `tools/cloakbrowser`). Know what you're agreeing to: its browser build is proprietary, free to use but not to
redistribute, and its terms allow use for your own household or team only. Offering Jessbot to outside customers with
it needs CloakHQ's commercial licence.

## I can't reach Jessbot from my phone

By default Jessbot only answers on the computer it runs on (`127.0.0.1`). To reach it from other devices:

- **On your home network:** set `HOST=0.0.0.0` in `.env`, restart, and open `http://<the computer's address>:3737` on
  the phone. Read the warnings in the [README](../../README.md#whats-missing-before-a-10) first, and keep it off the
  open internet. Your computer's firewall may also need to allow the port.
- **Through a VPN or a reverse proxy with HTTPS:** see [INSTALL.md](../INSTALL.md#behind-a-reverse-proxy).
- **Docker** publishes the port on the host machine only. Reach it through a reverse proxy or a VPN.

If the page says "This Jessbot does not answer to that host name", Jessbot refused the address you typed. Whenever
`PUBLIC_URL` is set, or Jessbot listens on `127.0.0.1` (as it does behind a reverse proxy), it only answers to the
computer's own names (`localhost`, `127.0.0.1`), the `PUBLIC_URL` address, and the names in `ALLOWED_HOSTS`. Either
use one of those, or add the other names to `ALLOWED_HOSTS` in `.env`, separated by commas
(`ALLOWED_HOSTS=jessbot.lan,192.168.1.20`), and restart.

## Invite links point to localhost

Invite links and password reset links use `PUBLIC_URL` when it's set, and otherwise the address you opened Jessbot with
when you made the link. A link made from `http://localhost:3737` only works on that computer. Set `PUBLIC_URL` in
`.env` to the address people use (for example `https://jessbot.example.com`) and restart, or make the link while you
open Jessbot by that address. Then make a new link: old ones keep their address.

## Notifications don't arrive

Turn them on per device in **You → Notifications** with **Turn on**, then press **Send a test**.

- "Blocked": the browser was told not to allow them. Allow notifications for the site in the browser's settings.
- "While Jessbot is open. (When it's closed needs HTTPS.)": notifications only arrive while the page is open, because
  the address isn't HTTPS. Use a reverse proxy with HTTPS (or `localhost` on the same computer).
- "Not supported in this browser": try another browser on that device.

## A mail account is refused

The message on **Check and connect** in You → Connections says why:

- "That server is on this computer or the local network": Jessbot only connects to servers on the internet unless an
  admin turns on **Allow the local network** in Admin → Browser. Turn it on only if your mail server really is at home:
  it lets the assistant reach any device on your network.
- "The mail server refused the username or password": check them, and note that many providers need an app password
  made in your account's security settings rather than your normal password.
- "The mail server's certificate isn't trusted": for your own server with a self-signed certificate, tick **Trust a
  self-signed certificate (your own server)**.

More in [Mail and calendar](mail-and-calendar.md).

## The port is already in use

If something else uses port 3737, Jessbot stops at start with `EADDRINUSE: address already in use`. Set `PORT` in
`.env` to another port (for example `PORT=3800`) and restart. With Docker, start it with
`JESSBOT_PORT=3800 docker compose up -d`.

## Saved mail passwords stopped working after a move

The health check says "Password key" needs fixing when the install key didn't come along: saved mail and calendar
passwords, two-step sign-in codes and the model key are sealed with a key kept in `.env` (or a key file), never in the
database or the backups. Put back the `.env` from the old install (or set its key as `JESSBOT_SECRET_PREVIOUS`), or
reconnect the accounts and enter the model key again. See [Backups and updates](backups-and-updates.md#moving-to-another-machine).

Related: [Guide index](README.md) · [Getting started](getting-started.md) · [Models and costs](providers.md) ·
[People and admin](people-and-admin.md) · [Mail and calendar](mail-and-calendar.md) ·
[Backups and updates](backups-and-updates.md) · [FAQ](faq.md)
