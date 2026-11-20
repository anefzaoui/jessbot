<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/brand/wordmark-dark.png">
    <img src="docs/images/brand/wordmark-light.png" alt="Jessbot" width="300">
  </picture>
</p>

<p align="center"><b>A self-hosted AI agent for your household.</b><br>
One assistant the people at home can talk to, that keeps working in the background, and never sends or spends anything
without asking.</p>

<p align="center">
  <a href="https://github.com/anefzaoui/jessbot/actions/workflows/ci.yml"><img src="https://github.com/anefzaoui/jessbot/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-GPL--3.0--or--later-0f6e7a" alt="Licence: GPL-3.0-or-later"></a>
  <img src="https://img.shields.io/badge/status-early%20preview-c98a1a" alt="Status: early preview">
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2024.19-3c4a5c" alt="Node.js 24.19 or newer">
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/chat-desktop-dark.webp">
    <img src="docs/images/chat-desktop-light.webp" alt="Jessbot's chat on a desktop: Jess has booked a table, found cinema seats and asks three quick questions before buying; the activity log on the right" width="880">
  </picture>
</p>

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

[Install](#install) · [What it does](#what-it-does) · [Screenshots](#more-screenshots) · [Safety](#safety-model) ·
[Privacy](#privacy) · [Docs](#documentation)

## See it work

A real run, sped up where it waits: asked to find a hike in the background and email Maya the plan, Jess hands the work
to a side chat, searches the web, writes the email, and stops at an approval card showing the recipient, the exact text
and why it is asking. The email goes out only after Approve.

<p align="center">
  <img src="docs/images/flow-approval.webp" alt="A real run: the request, Jess working in the background, the approval card for the email to Maya, Approve, and the email sent" width="880">
</p>

## What it does

### Chat, and work that carries on in the background

One main conversation per person, plus side chats and projects (a side chat with its own brief and files). Replies
stream; voice notes go both ways; files and photos can be dropped in; "off the record" chats never become memories. Ask
it to do something "in the background" and it opens its own side chat, works there with the same approvals and spending
limits, and posts back when it is done. Runs survive a restart and never repeat a send.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/chat-background-desktop-dark.webp">
    <img src="docs/images/chat-background-desktop-light.webp" alt="A chat where Jess hands research to a background task and later reports back with the result" width="880">
  </picture>
</p>

### Approvals: it asks before it acts

Sending email, changing a calendar, buying, booking, sharing a memory, uploading a file to a website: each stops at a
card showing the exact action and text, what it reaches, whether it can be undone, and why it is asking.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/approvals-desktop-dark.webp">
    <img src="docs/images/approvals-desktop-light.webp" alt="The Approvals page: buying two cinema tickets and emailing Maya the weekend itinerary, each with the exact text and a Why I'm asking line" width="880">
  </picture>
</p>

### A Feed written for you

You say what you want to follow in plain words; Jessbot picks sources (news searches, RSS, your own OPML) and writes short
posts for you. Likes and "less of this" shape the next pick.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/feed-desktop-dark.webp">
    <img src="docs/images/feed-desktop-light.webp" alt="The Feed: an evening greeting with the weather, Jess's evening brief, and topic filters" width="880">
  </picture>
</p>

### Goals and ideas

Goals it noticed you care about, broken into steps with "done when" lines and real numbers; ideas it suggests, each with
a reason, that you can start or turn down.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/goals-desktop-dark.webp">
    <img src="docs/images/goals-desktop-light.webp" alt="Goals: suggested goals to adopt, and goals in progress with their percentage and next step" width="400">
  </picture>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/ideas-desktop-dark.webp">
    <img src="docs/images/ideas-desktop-light.webp" alt="Ideas: things Jess can do, each with the reason it suggests it, and Let's do it or Later" width="400">
  </picture>
</p>

### A Library of everything it makes

Word, Excel and PowerPoint files, PDFs (made, filled, merged), pages, pictures and audio, with versions, previews and
export.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/library-desktop-dark.webp">
    <img src="docs/images/library-desktop-light.webp" alt="The Library: pages, audio and calendar files Jess made, filtered by kind" width="880">
  </picture>
</p>

### Household tools

Shared lists (shopping, chores, wish lists that hide what was bought), birthdays, weather and holidays where you live,
fair random draws and Secret Santa, reminders that nudge until you confirm (the bins, medicine, homework), quiet watches
that only speak when something changed, alarms and timers, and everything coming up across the household.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/lists-desktop-dark.webp">
    <img src="docs/images/lists-desktop-light.webp" alt="Lists: the weekly shop, house to-dos, Keiko's birthday wish list and a packing list" width="400">
  </picture>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/upcoming-desktop-dark.webp">
    <img src="docs/images/upcoming-desktop-light.webp" alt="Upcoming: the week ahead, dates Jess remembers, and alarms, reminders and timers" width="400">
  </picture>
</p>

### Mail, calendar and memory

IMAP/SMTP and CalDAV accounts (optional), each usable only by its owner. Sending mail and changing calendars ask first;
"always allow" can skip that, but not once the task has read outside content (a web page, an email). Memory has private
scopes: what it learns about each person stays theirs unless they share it with a group.

### A real multi-person setup

The admin decides, per person or group, which tools the agent may use for them, how it behaves with them, and how much
it may spend a week.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/admin-people-real-desktop-dark.webp">
    <img src="docs/images/admin-people-real-desktop-light.webp" alt="Admin → People: who uses Jessbot, whether admins may read other people's chats (off by default), and instructions for everyone" width="880">
  </picture>
</p>

### On your phone

A web app that works in your phone's browser, with push notifications, light and dark themes, phone and desktop
layouts, and right-to-left text.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/chat-phone-dark.webp">
    <img src="docs/images/chat-phone-light.webp" alt="The chat on a phone, with Jess's questions" width="210">
  </picture>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/feed-phone-dark.webp">
    <img src="docs/images/feed-phone-light.webp" alt="The Feed on a phone" width="210">
  </picture>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/list-phone-dark.webp">
    <img src="docs/images/list-phone-light.webp" alt="The weekly shopping list on a phone, sorted by aisle" width="210">
  </picture>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/approvals-phone-dark.webp">
    <img src="docs/images/approvals-phone-light.webp" alt="Approvals on a phone" width="210">
  </picture>
</p>

### More screenshots

| | | |
|---|---|---|
| [![Setup: your account](docs/images/setup-account-desktop-light.webp)](docs/images/setup-account-desktop-light.webp) Setup: your account | [![Setup: the model](docs/images/setup-model-desktop-dark.webp)](docs/images/setup-model-desktop-dark.webp) Setup: the model | [![Setup: who your agent is](docs/images/setup-identity-desktop-light.webp)](docs/images/setup-identity-desktop-light.webp) Setup: who your agent is |
| [![Projects](docs/images/projects-desktop-light.webp)](docs/images/projects-desktop-light.webp) Projects | [![A goal](docs/images/goal-desktop-dark.webp)](docs/images/goal-desktop-dark.webp) A goal and its plan | [![Activity](docs/images/activity-desktop-light.webp)](docs/images/activity-desktop-light.webp) Activity |
| [![Admin → Models](docs/images/admin-models-desktop-dark.webp)](docs/images/admin-models-desktop-dark.webp) Admin → Models | [![Admin → Skills](docs/images/admin-skills-desktop-light.webp)](docs/images/admin-skills-desktop-light.webp) Admin → Skills | [![Admin → Usage](docs/images/admin-usage-desktop-dark.webp)](docs/images/admin-usage-desktop-dark.webp) Admin → Usage |
| [![You → Memory](docs/images/you-memory-desktop-light.webp)](docs/images/you-memory-desktop-light.webp) You → Memory | [![A list](docs/images/list-desktop-dark.webp)](docs/images/list-desktop-dark.webp) A shared list | [![Answers with their sources](docs/images/chat-real-desktop-light.webp)](docs/images/chat-real-desktop-light.webp) Answers with their sources |

<sub>The setup wizard, Admin → People, the answers with their sources and the approval run come from a real install
with made-up people. The other screens are the app's own pages filled with its built-in demo household (the dev
styleguide), because a new install has no weeks of history to show. Every image is in [docs/images](docs/images).</sub>

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

**With Docker** (any system):

```bash
git clone https://github.com/anefzaoui/jessbot && cd jessbot
docker compose up -d --build
docker compose logs jessbot | grep "setup code"     # you'll need this code on the setup page
```

**With Node.js**: you need **Node.js 24.19 or newer** and about 1 GB of disk (plus the browser download). It runs on
Windows and Linux; macOS should work but hasn't been tested by a person yet (CI runs the tests there).

```bash
git clone https://github.com/anefzaoui/jessbot
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
`.env` (and read [What's missing](#whats-missing-before-a-10) first). Behind a reverse proxy, set `PUBLIC_URL` to the
address people use (invite links use it, and Jessbot then refuses requests for other host names); the default
`TRUST_PROXY=loopback` is right for a proxy on the same machine. Everything else is in [.env.example](.env.example).

Moving an install: stop it and copy the whole folder (including `data/`). Backups: Jessbot makes a full backup a day
and keeps a week (`npm run restore` lists and restores them); copy `data/backups/` somewhere else too.

[docs/INSTALL.md](docs/INSTALL.md) has the details for each system: the Docker image (non-root, read-only, health
check), a hardened systemd service for Linux, starting it at sign-in on Windows, macOS, and a reverse proxy with HTTPS.

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

Setup's "Give it a brain" step (and Admin → Models) asks where the models come from:

| Feature | OpenRouter | Ollama | Another OpenAI-compatible service |
|---|---|---|---|
| Chat, tools, tasks, goals, the feed, projects | Yes | With a model that calls tools, 7B or larger | Yes, with a model that calls tools |
| Memory search by meaning | Yes | With `nomic-embed-text` pulled | If it serves an embedding model; otherwise by keywords |
| Fallback models | Yes | No: the main model only | No: the main model only |
| Quick decisions | Yes | Off: the full model or plain rules decide | Off |
| Voice notes (speaking and listening) | Yes | Off: text only | Off |
| Making pictures | Yes | Off | Off |
| Reading scans and photos of text | Yes | Off | Off |
| Spending caps in dollars | Yes | Free, nothing to count | The service doesn't report costs, so budgets can't count spending |
| Low-balance warning | Yes | n/a | Off |

Features a provider can't serve are switched off and say so (Admin → Models marks them), instead of failing each time.
A key is only ever sent to the service it was entered for, and Ollama never gets one. Small local models connect but get
lost in Jessbot's long instructions: use 7B or larger. The weekly budget per person caps what each person can spend
where the provider reports costs. Details: [docs/guide/providers.md](docs/guide/providers.md).

## What's missing before a 1.0

Honest list, roughly in order:

- **Time in real use before internet exposure**: two-step sign-in, password resets and rate limits that survive a
  restart are in, but Jessbot is new and needs more use and outside review; prompt injection is mitigated, not solved
  (see [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md)).
- **Install options**: a published image per release (the Dockerfile and compose file are here), a Windows installer.
- **Providers**: prices for services other than OpenRouter (so their budgets can count spending), and local voice and
  pictures.
- **Interface languages**: the interface is English only for now (the agent itself reads and writes in many languages,
  including right-to-left ones).
- Later: messaging channels (Telegram first), MCP tools, a mobile app.

## Documentation

- [docs/guide](docs/guide/README.md): the user guide: setup, models and costs, the assistant's name and look,
  approvals and safety, mail and calendar, the Feed, the Library, people and admin, backups, FAQ, troubleshooting
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it's built, and the build history
- [docs/FEATURES.md](docs/FEATURES.md): every feature and its status
- [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md): the security model: who is trusted, every untrusted input, what isn't defended
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
