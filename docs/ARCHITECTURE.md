# Jessbot — Architecture

Self-hosted, portable personal AI agent for one owner and the people they invite (family, company).
One bot, many users; the admin decides how the bot behaves toward each person and what it may do for them.
Product scope: `docs/FEATURES.md`. Why things are the way they are: `docs/DECISIONS.md`. UI system: `docs/UI.md`.

## Runtime overview

```
 Browser (Handlebars pages + in-house JS)      Android app (future)
        │  cookie session                           │  Bearer token
        ▼                                           ▼
 ┌──────────────────── Express 5 ─────────────────────────────┐
 │ routes/web/*  (one route per page, server-rendered)         │
 │ routes/api/v1/* (JSON + SSE, same services)                 │
 │        │                                                    │
 │ services/*  ── policy ── approvals ── usage ── activity      │
 │        │                                                    │
 │ agent/loop  ── prompt layers ── tools/registry ── skills     │
 │        │              │                    │                │
 │   OpenRouter (LLM)  data/workspace/*.md   Chromium (./tools)     │
 │        │                                                    │
 │ scheduler (croner) · background runs · run_events log       │
 └──────────────── node:sqlite  data/jessbot.sqlite ───────────┘
```

- **Runs are server-side jobs.** A chat message creates a run; the agent loop executes it independently of
  the HTTP request and appends every step to `run_events`. Clients (any tab, any device) subscribe via SSE
  and can re-attach after refresh with `Last-Event-ID` (decision #19).
- **Prompt layers** (snapshotted per session for prompt caching):
  `SOUL.md` → `AGENTS.md` → group instructions → user instructions → speaker identity (server-set) →
  `users/<id>/USER.md` → memory the user's policy permits.
- **Policy** resolves global → group → user; tools the user may not use never reach the model.

## Directory layout

```
server.js            boot: dirs → db/migrations → app → listen
src/config/          env + every path (portable; JESSBOT_HOME / JESSBOT_TOOLS)
src/db/              node:sqlite wrapper + migrations/NNN_*.sql
src/middleware/      security headers (CSP nonce), template locals, auth (P2)
src/routes/web/      one file per page group, each page = one route
src/routes/api/v1/   JSON API for web JS + Android
src/services/        domain logic (no HTTP) — shared by web + API
src/agent/           loop, prompt builder, tool registry, tools/*
src/browser/         shared headless browser (engines/: Chromium, optional CloakBrowser), network guard, search / read / screenshot (P5)
src/agent/proactive.js  the scheduler: alarms, reminders, timers, scheduled tasks, check-ins (P7)
src/views/           layouts/ (base, app) · partials/ (components) · pages/
src/styles/input.css Tailwind v4 design system → public/css/app.css
public/js/           in-house client modules (no libraries)
scripts/             build-assets.js (fonts + tree-shaken icon sprite)
skills/              SKILL.md folders (admin-reviewed)
docs/                this file, DECISIONS, FEATURES, UI, API, SKILLS, WEB, EVAL, PLAN-SKILLS (+ topic docs)
data/   (ignored)    jessbot.sqlite, workspace/, users/, artifacts/, uploads/, assistant/ (the admin's pictures), browser-profiles/, logs/, backups/
tools/  (ignored)    cloakbrowser/ binary (downloaded per install — never committed, see decision #15)
```

## Build plan

Each phase ends runnable, verified end to end, committed, docs updated.

| Phase | Scope | Status |
|---|---|---|
| 0 | Foundation: git, config/paths, sqlite + migrations, Express/Handlebars/Tailwind build, security headers, docs | ✅ |
| 1 | Design system + app shell + in-house JS components + `/styleguide` — **owner reviews UI** | ✅ approved |
| 2 | Setup wizard, auth (argon2, sessions/tokens), invites, basic user admin (+ onboarding identity) | ✅ |
| 1b | Living presence: portrait assets pipeline, presence.js (breathing/blink/glance/crossfade/mood), scenes (time × weather) + CSS weather FX, Discover-style Feed redesign | ✅ |
| 3 | Chat core: runs + events log, agent loop, **WebSocket** (refresh-proof), prompt layers, memory, context mgmt, usage | ✅ |
| 4 | Tool registry, policy/permission matrix, approvals queue, activity timeline | ✅ |
| 5 | CloakBrowser: installer, search/read/screenshot tools, `/admin/browser` | ✅ |
| 6 | Library + artifacts (sandboxed viewer) | ✅ |
| 7 | Scheduler, Upcoming, Places & weather, Feed (projects/tasks model moves to P8 with Goals) | ✅ |
| 8 | Goals (question wizard, timeline, projects/tasks model) + Ideas (reflection job) | ✅ |
| 9 | Admin completion: usage, logs, SOUL versions, backup/doctor, API docs | ✅ (+ RTL content, #68) |
| 10 | File uploads, email (IMAP/SMTP), calendar (CalDAV) | ✅ |
| 11 | Office documents (Univer or alternative — evaluate first) + PDF | ✅ (server-made files; Univer not adopted, #81) |
| 12 | Skills system polish, hardening, Android API review | ✅ (#84–#87) |
| 13a | Projects — core: created by talking, own chat + brief + files, Main knows each one (docs/PROJECTS.md) | ✅ (#91–#92) |
| 13b | Projects — the project soul (Jess's expertise per project; proposals you approve) | ✅ (#93) |
| 13c | Projects — deep files (page-aware search with citations, image captions) | ✅ (#94) |
| 13d | Projects — hybrid search, weekly tidy, small-project full view (sharing deferred by the owner) | ✅ (#95) |
| 14 | Voice — voice notes in (recorder + transcription), spoken replies out (asked / Listen / voice note in), her voice matched to her identity (docs/VOICE.md) | ✅ (#99–#100) |
| 15 | Markdown editors — coloured markdown and Edit / Preview on every editor (docs/UI.md) | ✅ (#103) |
| 16 | Quick decisions with Jev — gates, per-message sense, browser page state / risk / fast steps / autopilot, feed relevance (docs/JEV.md) | ✅ (#106–#111) |
| 17 | UI redesign with the impeccable + taste-skill design skills: Harbor palette, Geist, Phosphor, template tells removed (docs/DESIGN.md) | ✅ (#116) |
| 18 | Safety: downloads to Library, untrusted-content fences, hidden text removed, injection warnings, taint-aware approvals, outbound guard, full-text approval cards, sealed sign-ins, skill review assistant, doctor security checks, off the record (docs/PLAN-SKILLS.md, docs/SECURITY.md) | ✅ (#117–#127) |
| 19 | Runs that finish and tell the truth: restart recovery (unknown outcomes), unattended retries, watches, one closing question (#83 amended), reply audit, dead-end detector, figure and requirement checks, spend caps and alerts, model fallback chain, skill routing, careful topics, link checks, wish log | ✅ (#128–#130, #148–#150, #176–#181) |
| 20 | Memory as documented: hybrid multilingual recall, dedupe, decay by kind, dated memories, episodes, date-scoped history, import, lessons, weekly tidy (docs/CONTEXT-AND-MEMORY.md) | ✅ (#151–#156, #186–#189) |
| 21 | Research and the web: site readers (PDF/feeds/YouTube/X/Reddit), escalation ladder, search by intent, SearXNG, open_search deep links, learned recipes, browser_upload, trust warnings, ad blocking; OpenWeb evaluated: no-go (docs/WEB.md, docs/OPENWEB-EVALUATION.md) | ✅ (#135–#138, #164–#168) |
| 22 | Household tools: office/PDF quality and forms, Library edits/export/self-check, OCR and previews, lists, weather/holidays, fair draws, transcripts, read-aloud, email attachments, calendar slots and .ics, make_image, goals, follow-up reminders, Feed in chat, delegate, overnight prep, model copies of pictures, prompt caching | ✅ (#131–#134, #139–#147, #157–#163, #169–#170, #182–#185, #190–#193, #197–#202) |
| 23 | Prompts and self-improvement: one short operating manual, tool descriptions as contracts, skill_propose + trigger test, agent eval (docs/EVAL.md), weekly self-review, What's new | ✅ (#171–#173, #206–#210) |
| 24 | Skills: 90 new household skills + the 4 built-ins upgraded, checked against the tool contracts, 26 recommended with routing examples (docs/SKILLS.md) | ✅ (#214–#216) |
| 25 | Screens for everything above: Lists, You, Library, approvals, skills review, Upcoming, goals, admin, feed, reminders, background work, self-review, What's new (docs/UI.md) | ✅ (#174–#175, #194–#196, #203–#205, #211–#213); released 2026-09-26 with #217 |

## Commands

```
npm install          # dependencies
npm run build        # icons + fonts + Tailwind CSS
npm run dev          # dev server on :3738 (data/dev); restarts when src/ changes — run `npm run css:watch` alongside
npm start            # the server on :3737 (data/)
npm run doctor       # health checks from the command line (works with Jessbot stopped)
npm run restore      # list backups; `npm run restore -- <name>` restores one (Jessbot stopped)
npm run browser:install   # download the browser (Chromium into tools/ms-playwright; also from setup or Admin → Browser)
npm test             # unit tests (node --test, throwaway data dir)
npm run test:e2e     # setup/auth/invites end-to-end (own server, throwaway data)
npm run test:chat    # chat core against the REAL model (a few cheap calls)
npm run ui:flows     # UI interaction tests (dev server running)
npm run ui:check     # screenshots + console-error sweep (dev server running)
npm start            # production
```
