# Jessbot

**A self-hosted AI agent for your household: one assistant the people at home can talk to, that keeps working in the
background, and never sends or spends anything without asking.**

> **Early preview.** Jessbot works, but it is young, it was built quickly, and installing it still takes some comfort
> with a terminal. Run it on your own computer or home network (or behind a VPN such as Tailscale or WireGuard).
> **Don't expose it to the open internet yet**: see [What's missing](#whats-missing-before-a-10) below.

You run Jessbot on your own PC or server and invite the people you live or work with. Each person gets a private chat
with the agent ("Jess" by default; you can rename it and pick how it looks). The agent has its own headless browser, so
it can look things up, compare prices, read pages and fill in searches for you, and it carries on while nobody has the
app open: reminders that follow up until you say done, scheduled checks ("tell me when the fare drops"), a morning feed
written for you, and goals it works on step by step. Everything it makes lands in a Library. Anything that sends,
spends, books or shares stops at an approval card with the exact text first.

You bring the AI model: Jessbot talks to [OpenRouter](https://openrouter.ai) by default, or to any OpenAI-compatible
endpoint (see [Providers](#providers)).

## What it does

- **Chat, one main conversation per person**, plus side chats and projects (a side chat with its own brief and files).
  Replies stream; voice notes go both ways; files and photos can be dropped in. "Off the record" chats never become
  memories.
- **Works in the background.** Ask it to research something "in the background" and it opens its own side chat,
  works there with the same approvals and spending limits, and posts back when it is done. Runs survive a restart and
  never repeat a send.
- **Reminders, alarms, timers and scheduled tasks**, including reminders that nudge until you confirm (the bins,
  medicine, homework) and quiet watches that only speak when something changed.
- **A personal Feed**: you say what you want to follow in plain words; Jessbot picks sources (news searches, RSS, your
  own OPML) and writes short posts for you. Likes and "less of this" shape the next pick.
- **Goals and ideas**: goals it noticed you care about, broken into steps with "done when" lines and real numbers;
  ideas it suggests, with a reason you can turn down.
- **A Library of everything it makes**: Word, Excel and PowerPoint files, PDFs (made, filled, merged), pages,
  pictures and audio, with versions, previews and export.
- **Household tools**: shared lists (shopping, chores, wish lists that hide what was bought), birthdays, weather and
  holidays where you live, fair random draws and Secret Santa, upcoming events across the household.
- **Mail and calendar (optional)**: IMAP/SMTP and CalDAV accounts, each usable only by its owner. Sending mail and
  changing calendars always asks first.
- **Memory with private scopes**: what it learns about each person stays theirs unless they share it with a group.
- **A real multi-person setup**: the admin decides, per person or group, which tools the agent may use for them, how it
  behaves with them, and how much it may spend a week.
- **An installable web app (PWA)** with push notifications, light and dark themes, phone and desktop layouts, and
  right-to-left text.

## Safety model

The agent is useful because it can act, so what it may do is decided in code, not only in its instructions:

- **Approvals.** Sending email, changing a calendar, buying, booking, sharing a memory, uploading a file to a website:
  each stops at a card showing the exact action and text. After the agent has read outside content (a web page, an
  email, a feed), "always allow" no longer covers anything that sends or spends, and lasting changes (a schedule, a
  memory) ask too.
- **Untrusted content is fenced.** Web pages, emails, feeds, files and tool results reach the model inside marked
  fences, with hidden text pruned and injection patterns flagged. A page can't start background work or grant the
  agent tools.
- **No shell, no code execution.** The agent has no tool to run commands on your machine. Pages it builds run in a
  sandboxed frame with no network.
- **Network guard.** Its browser and fetches can't reach your local network (routers, NAS, admin panels) unless the
  admin allows it.
- **Spending limits** per task and per person per week, with alerts as a budget fills up.
- **Secrets** (mail passwords) are sealed with a per-install key; an outbound guard stops the agent from pasting an API
  key or password into an email or a web form.
- **An activity log** of everything it did, and an audit log of admin actions.

The details, and the known limits (prompt injection is mitigated, not solved), are in
[docs/SECURITY.md](docs/SECURITY.md). Found a hole? Please see [SECURITY.md](SECURITY.md).

## Privacy

Jessbot is self-hosted: your chats, memories, files and settings stay in its `data/` folder on your machine. There is
no telemetry and no account with us. What leaves your machine:

- what you and the agent send to **your model provider** (the conversation, and the pages or files it is working on);
- **web traffic from the agent's browser** when it looks things up (search engines, the sites it visits, weather and
  map services), and feed polling;
- **your mail and calendar servers**, if you connect them, and **Web Push** through your browser's push service.

Each person's chats, projects, Library and voice notes are theirs. An admin can read them only if "Let admins read other
people's chats" is turned on (Admin → People, off for a new install); then it is read-only, every chat view is logged, and
everyone sees a line saying so in their chat and on their You page.

## Install

You need **Node.js 24.19 or newer** and about 1 GB of disk (plus the browser download). It runs on Windows and Linux;
macOS should work but hasn't been tested yet.

```bash
git clone <this repository> jessbot
cd jessbot
npm install
cp .env.example .env      # optional: put your model key here, or paste it in the setup page later
npm run build             # fonts, icons, CSS
npm start                 # http://127.0.0.1:3737
```

Open http://127.0.0.1:3737. The setup wizard walks you through:

1. **Your admin account.** It asks for the **setup code** printed in the server's log when it starts, so that nobody
   else who reaches the page first can claim your install.
2. **The model** ("Brain"): your provider key and the model to use, with a live test.
3. **Internet access** for the agent's browser (see below).
4. **Its name and look.**
5. **People**: invite links for the others in your household (they choose their own passwords).

By default Jessbot listens on 127.0.0.1 only. To use it from your phone on the same network, set `HOST=0.0.0.0` in
`.env` (and read [What's missing](#whats-missing-before-a-10) first); behind a reverse proxy on the same machine, the
default `TRUST_PROXY=loopback` is right. Everything else is in [.env.example](.env.example).

Moving an install: stop it and copy the whole folder (including `data/`). Backups: Jessbot makes a full backup a day
and keeps a week (`npm run restore` lists and restores them); copy `data/backups/` somewhere else too.

A Docker image and a Linux service file are on the way (see below).

### Web access (the agent's browser)

If **Google Chrome** is installed on the machine, the agent uses it, driven by
[Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) (Playwright without its automation traces), so sites
don't see an obviously automated browser. Nothing is downloaded and Jessbot never ships Chrome. Without Chrome (a
server, Docker), it uses **open-source Chromium** through Playwright: the setup page (or `npm run browser:install`)
downloads it once into `tools/ms-playwright`, about 200 MB, or set `JESSBOT_CHROMIUM_PATH` to a Chromium that is already
installed. Admin → Browser switches between them. Until a browser is there, chat, files, the Library, reminders, lists
and mail work, but web lookups, the Feed, weather and places, and exporting pages to PDF or PNG don't.

Some sites (a few airlines and shops) refuse automated browsers. For those, Admin → Browser can switch to
**CloakBrowser**, a Chromium build with stealth patches. It is optional and you install it yourself: its binary is
proprietary, its terms allow internal use (yourself, your family, your company) but not offering Jessbot as a service to
others, and it is never included in this repository.

## Providers

| Feature | OpenRouter | Other OpenAI-compatible endpoints (OpenAI, a local server…) |
|---|---|---|
| Chat, tools, memory, Library, everything else | Yes | Yes (with a model that supports tool calls) |
| Memory search by meaning (embeddings) | Yes | Falls back to keyword search |
| Voice replies (spoken audio) | Yes | No |
| Making pictures (`make_image`) | Yes | No |
| Quick decisions (a small second-opinion model) | Yes | No, the code falls back to its own rules |
| Model prices, spending budgets, balance alerts | Yes | Prices only from what was used; budgets may not count everything |

Set `LLM_BASE_URL` and the key in `.env` (or on the setup page) for another endpoint. The default model is a cheap,
capable one picked for everyday household use; change it in the setup page or Admin → Models. The weekly budget per
person caps what each person can spend.

## What's missing before a 1.0

Honest list, roughly in order:

- **Account hardening for internet exposure**: optional two-factor sign-in for admins, rate limits that survive a
  restart, a password reset flow, an origin check against `PUBLIC_URL`.
- **Install options**: a Docker image (non-root, data volume, healthcheck), a systemd unit, documented Windows and
  macOS service setups, and CI for every pull request.
- **Providers**: a provider picker with prices for non-OpenRouter endpoints, and tested local models (Ollama, LM Studio).
- **Renaming everything**: the agent's name and look can be changed, but some interface text still says "Jess" and
  "she"; uploading your own avatar and backgrounds.
- **Interface languages**: the interface is English only for now (the agent itself reads and writes in many languages,
  including right-to-left ones).
- Later: messaging channels (Telegram first), MCP tools, a mobile app.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it's built, and the build history
- [docs/FEATURES.md](docs/FEATURES.md): every feature and its status
- [docs/SECURITY.md](docs/SECURITY.md): the safety controls in detail
- [docs/DECISIONS.md](docs/DECISIONS.md): why things are the way they are
- [docs/API.md](docs/API.md): the HTTP and WebSocket API (the web app and a future mobile app share it)
- [docs/DATABASE.md](docs/DATABASE.md): the database and safe upgrades
- [docs/UI.md](docs/UI.md) and [docs/DESIGN.md](docs/DESIGN.md): the interface rules and visual system

## Contributing

Bug reports, ideas and pull requests are welcome; please read [CONTRIBUTING.md](CONTRIBUTING.md) first. Security
reports go through [SECURITY.md](SECURITY.md).

Most of Jessbot's code is written with AI, from the maintainer's design and decisions;
[AI-DECLARATION.md](AI-DECLARATION.md) says exactly how.

## Licence

Jessbot is free software: you can redistribute it and/or modify it under the terms of the
[GNU General Public License](LICENSE), version 3 or (at your option) any later version. Third-party work it uses is
credited in [NOTICE.md](NOTICE.md).
