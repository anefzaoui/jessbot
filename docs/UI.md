# Jessbot UI system

Live reference: **`/styleguide`** (dev only). It shows every component in every state, plus every page rendered with demo data against a simulated API (`/styleguide/screens/*`).
Visual system (colour, type, icons, bans): **`docs/DESIGN.md`**; product context: `docs/PRODUCT.md`; design skills: `.claude/skills/`.
Checks: `npm run ui:check` (screenshots at 1440 and 390 px, light and dark; fails on any console error or 4xx/5xx, and on a page wider than the screen) and `npm run ui:flows` (interaction regression tests). Run both with the dev server up.

## Rules
- **Work in progress looks alive and specific** (decision #67): the run card acts out what Jess is doing (a glyph per activity — the search glass circles, a scan line passes over the page, the pen writes, the pointer clicks), says it as a headline, stacks the sites she used, shows her browser tab live, and lists steps on a timeline. Loaders for a result use `loader`, never a bare spinner with text.
- **Content can be right-to-left** (decision #68): never hard-code left/right for content — use logical utilities (`ps-`, `pe-`, `ms-`, `border-s`, `text-start`); generated HTML gets its direction from `bidi.js`; wrap other user/model text in a `p`/heading/`.truncate` or add `.bidi`.
- **Nothing is fire-and-forget.** Every action shows pending → success or error, with Retry or Undo where it makes sense. Runs, drafts and question answers survive a refresh (decision #19).
- **Always say what Jessbot is doing.** Use the activity vocabulary in `public/js/activities.js` and never invent labels. It drives the avatar, the status strip, the panel, the tab title and the screen-reader announcements (#22).
- **One source of markup.** The server renders partials. The API returns rendered HTML fragments (`messageHtml`, `cardHtml`) through the same partials. The client only builds optimistic placeholders.
- **Contracts live at the top of each partial.** Services must produce exactly those shapes. The fixtures in `src/dev/fixtures.js` follow them, so the styleguide breaks visibly when a contract drifts.
- **In-house JS only.** Build on native `<dialog>`, `popover`, `fetch` streams and `:has()`.

## Tokens (`src/styles/input.css`)
Semantic CSS variables `--jb-*` on `:root` and `.dark`, exposed to Tailwind via `@theme inline` (`bg-canvas`, `bg-chrome`,
`text-ink-2`, `bg-accent-soft`, `text-run`…). What each one means, and the Harbor palette: `docs/DESIGN.md`.

## Layout
- **Desktop:**
  - The rail is 264 px, or 68 px collapsed (`Ctrl+[`).
  - The main column is `max-w-3xl` for chat and reading, `max-w-5xl` for grids.
  - The right panel is 360 px on xl+ (`Ctrl+.`) and holds Activity / Approvals / Upcoming / Identity.
- **Below xl:** the panel becomes a sheet, opened from the avatar or the status strip.
- **Below md:** a bottom tab bar replaces the rail.
- Shell state (theme, rail, panel) is restored before first paint by the inline script in `partials/shell/head.hbs`.

## Living presence (decision #33)

`{{> avatar size=… activity=…}}` renders the layered presence when a portrait set exists (else the CSS orb):
sky scene → weather FX → portrait → ring → badge, clipped round. `public/js/presence.js` owns idle life (breathing,
blinks, glances), listening while typing, activity → expression (`activities.js` `emotion`), moments (`MOMENTS`),
scene by the viewer's clock (`data-pinned` freezes it for demos), and `jb:variant` character switching.
Sizes xs–xl use 256 px frames with face zoom; `2xl`/`hero` use 1024 px full head-and-shoulders.
Demo any combination: `/styleguide?variant=male&time=dusk&weather=storm`.

## Components (partials → JS module)
| Partial | Purpose | JS |
|---|---|---|
| `avatar` | living presence (portrait + sky + ring + badge), orb fallback | `presence.js`, `status.js` |
| `chat/status-strip` | live "what I'm doing · target · elapsed · done/next" | `status.js` |
| `chat/message`, `chat/run-steps`, `chat/run-step` | messages, run lineage (queued/running/waiting/done/error/cancelled) | `composer.js` (+ `run.js`, Phase 3) |
| `loader` | work in progress where a result will land: activity glyph + shimmer label + placeholder lines (`loader()` in core.js mirrors it) | — |
| `chat/ask-dock`, `chat/question-card` | structured questions docked above the composer; history card | `ask.js` |
| `chat/composer` | drafts per thread, Enter to send, optimistic bubble, Stop; the mic records a voice note (recorder bar) | `composer.js`, `voice.js` |
| hand-over viewer (`[data-handover]` → full-screen dialog) | the tab as live video (MJPEG stream, snapshot fallback) + a sidebar mirroring the chat card's live timeline (steps, headline, elapsed, Stop) | `handover.js` |
| `chat/voice-player` | a voice note (theirs in their bubble, hers above her reply) or "Recording…"; waveform progress, seek, speed | `voice.js` |
| `<textarea data-md-editor="Label">` | markdown editor: coloured markdown under the text + Edit / Preview (server-rendered) | `md-editor.js`, `md-highlight.js` |
| `approval-card` | what it does and who it reaches (a risk tile, the tool's facts: To, files, a picture's shape), can it be undone, why it asks (a suspected injection said plainly in the waiting colour), secret flags, the exact text folded when long ("Show all 1,240 characters"), a stamp per state (Needs your OK / Approved / Denied / Not done); the JS sets only `data-status` and the result line (#194) | `approvals.js`, `live.js` |
| `pages/admin/skills`, `pages/admin/skill-review` | Admin → Skills: find by words / status / origin / category, "Recommended to switch on" with one Approve these (each approved on its own, review-gated), and one skill's review page: findings grouped (Serious / Worth a look / Optional tools / Notes) with file, line and excerpt, the diff since approval, "Drafted by Jess", the trigger test (the cost first, a bar per request, a suggested description that is never applied; a reload mid-test picks it up) (#195) | `admin-skills.js` |
| `feed/card` (hero · compact · tile), `feed/brief`, `feed/source`, `feed/actions` | Discover-style feed + reading sheet | `feed.js` |
| `activity-item`, `job-card`, `idea-card`, `goal-card`, `library-card`, `progress-bar`, `empty-state`, `page-header`, `person` | content cards | `ideas.js`, `library.js`, `memory.js` |
| `job-card` | a scheduled task: one line for how its last run went (fine, nothing to tell, failed, skipped, running now, "Trying again at 14:05"), Run it now (shows Running now at once), a watch's "Watching · last: … · checked 14:00" (#196) | `alarms.js` |
| `goal-measure` | a goal's number: latest and target, the `{{sparkline points}}` helper (inline SVG, a hover title per reading), "4 of 3 this week", progress, Log it (swapped for the server's card) (#196) | `goals.js` |
| library viewer tasks (`.lib-task`, `data-state`) | Read this scan (offer → estimate → reading → reload) and Listen (estimate → "Recording part 2 of 5" → ready to play); both survive a refresh; audio cards play in place (#196) | `library.js` |
| reply actions (`chat/message`) | "Simpler" (a visible turn; the server adds the plain-words note) and follow-up chips from "A few things worth a second look:" (#196) | `run.js`, `composer.js` (`composer:send`) |
| `admin/browser-extras` | Admin → Browser's second half: search links, learned results pages (Forget), sites with ad blocking off (Turn it on now), office previews (#195) | `browser-admin.js` |
| `lists/card`, `lists/index-body`, `lists/items`, `lists/item` | Lists (`/lists`, `/lists/:id`): cards, aisle groups, optimistic tick / add, change form from a `<template>`, live re-render from `GET /api/v1/lists…?fragment=1` | `lists.js` |
| `admin/fallback-row`, `admin/balance-card`, `admin/wishes`, `admin/security`, `admin/lesson-card`, `admin/personality-nav` | Admin screens (Phase 25 part C): fallback rows with their test state (every state's words in the markup, `data-state` picks one), the balance card re-rendered by Read it now, the wish log, security grouped by source (metadata only), household lessons | `admin-models.js`, `admin-usage.js`, `admin-wishes.js`, `admin-lessons.js` |
| `me/lessons`, `me/tidy`, `feed/mutes`, `feed/opml-result`, `feed/topic-list`, `feed/diet`, `chat/reminder-card` | How I work with you, the weekly tidy with Undo, muted words, the OPML summary, the reading diet, a reminder's Done and a consent request's Yes / No (re-rendered from `?fragment=1`; the reminder card follows `alarm.updated` / `reminder.consent`) | `me-lessons.js`, `feed-tools.js`, `reminder-card.js` |
| `chat/noted-chip`, the chat's `fb-note` template | a thumbs-down asks "What was off?" under the reply (saved at once; Send or Skip starts the lesson), then "Noted: …" with Keep / No, or Remove for a rule from their words; every state's words in the markup, `data-state` picks one (#211) | `run.js` |
| `chat/background-brief`, `chat/trust-chip`, `chat/whats-new` | a background task's side chat: what it was asked (folded), from where, how it went; overnight prep's idea and draft. The trust chip under a finished reply. What's new, once, above the main chat's composer (#212, #213) | `run.js` (`#run-<id>` anchors), `whats-new.js` |
| `me/prep`, `me/note-row`, `idea-ready`, `admin/self-review`, `admin/review-proposal`, `admin/how-im-doing`, `admin/whats-new` | overnight prep's switch and notes for later (You → Notifications), "Ready for you" (Ideas), the weekly self-review with a diff per proposal, How I'm doing (stat tiles), the What's new editor with a live preview; the admin parts re-render from `GET /admin/system/…` (#212, #213) | `prep.js`, `admin-review.js` |
| `shell/*` | head, rail, tab bar, panel, user menu, command palette | `shell.js`, `menu.js`, `tabs.js`, `cmdk.js`, `theme.js` |

Generic behaviour:
- `forms.js`: `<form data-ajax>` sends JSON with a busy button and shows inline field errors from `{errors:{field:msg}}`.
- `modal.js`: dialogs and `confirmDialog()`.
- `toast.js`: toasts with actions.
- `tooltip.js`: `data-tooltip` / `data-tooltip-kbd`.
- `core.js`: `api()`, `withBusy()`, clocks (`<time data-relative>`, `[data-elapsed-since]`) and storage.

## Icons
Use `{{icon "name" class="size-4"}}` with a Jessbot icon name; `scripts/icon-map.js` maps each name to a Phosphor glyph (see `docs/DESIGN.md`). The sprite is tree-shaken at build time, and names missing from the map fail `npm run assets`. For icons set from data, use `iconName: 'x'` in JS or `iconName="x"` in partial hashes so the scanner finds them.

## Keyboard
| Key | Action |
|---|---|
| `Ctrl/⌘+K` | Palette (Tab sends the query to chat as a draft) |
| `/` | Focus the composer |
| `Ctrl+[` | Toggle the rail |
| `Ctrl+.` | Toggle the panel |
| `1`–`9` | Pick an option in the question dock |
| `Enter` | Next question / send |
| `Esc` | Minimize the dock |
| `Ctrl/⌘+Shift+P` | Markdown editor: switch Edit / Preview (the one you are in, else the first on the page) |
| `Esc` / `Enter` while recording | Discard / send the voice note |
