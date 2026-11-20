# Jessbot

A self-hosted, portable personal AI agent for you and the people you invite. One always-on agent with a
single main chat, a live activity log, approvals, scheduled tasks, a personal feed, proactive ideas, goals and
a library of everything it creates. The admin decides how Jessbot behaves toward each person and which tools
it may use for them.

Runs the same on a Windows PC or a Linux VPS. All data stays inside this folder.

## Quick start

```bash
npm install
cp .env.example .env      # add your OPENROUTER_KEY
npm run build             # fonts, icons, CSS
npm start                 # http://127.0.0.1:3737
```

Development: `npm run dev` and, in a second terminal, `npm run css:watch`.

## Docs

- [Architecture & build plan](docs/ARCHITECTURE.md)
- [Feature checklist](docs/FEATURES.md)
- [Decision log](docs/DECISIONS.md)
- [Database & safe upgrades](docs/DATABASE.md)
- [UI design system](docs/UI.md)

## Data & portability

| Folder | Contents | In git |
|---|---|---|
| `data/` | database, SOUL/AGENTS/MEMORY.md, per-user files, artifacts, uploads, browser profiles, logs, backups | no |
| `tools/` | downloaded binaries (CloakBrowser) | no |

Copy the whole folder (including `data/`) to move an install. Do not redistribute `tools/` — the CloakBrowser
binary's licence forbids it; each install downloads its own copy.
