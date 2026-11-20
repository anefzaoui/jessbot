# Jessbot API v1

Base path: `/api/v1`. It's used by the web UI's JavaScript and by the future Android app. It returns JSON.

- **Errors** come back as `{ "error": "Human message", "errors": { "field": "message" } }` with a real HTTP status. `errors` is present on validation failures (422).
- **Status codes:**

| Code | Meaning |
|---|---|
| 401 | Not signed in |
| 403 | Forbidden, or a cross-site cookie request |
| 404 | Not found |
| 410 | Gone (e.g. a used invite) |
| 422 | Validation failed |
| 429 | Rate limited |
| 503 | Setup not finished |

## Authentication
One opaque-token system, carried two ways:

| Client | Carrier | Lifetime | Notes |
|---|---|---|---|
| Web | `jb_session` cookie (HttpOnly, SameSite=Lax, Secure on HTTPS) | 30 days, sliding | Every cookie-authenticated `POST/PUT/PATCH/DELETE` must come from the same origin (the `Origin`/`Referer` host must match) |
| Android / apps | `Authorization: Bearer <token>` | 180 days, sliding | No origin check (can't be CSRF'd) |

Only a SHA-256 of each token is stored. Revoking a session (`/me/sessions/:id/revoke`, a disabled account, or logout) takes effect immediately.

### `POST /auth/login`
Body: `{ "email", "password", "device"?: "Pixel 9" }` → `200 { token, user }`.
Rate limit: 8 attempts per 15 minutes per IP and email. Wrong email and wrong password get the same response and take the same time.

### `POST /auth/logout` (auth)
Revokes the current session. → `{ ok: true }`

## Me
| Method & path | Body | Result |
|---|---|---|
| `GET /me` | — | `{ user, adminsCanRead }` — `adminsCanRead`: admins may read this person's chats and files (decision #219; always false for an admin) |
| `POST /me/profile` | `{ name?, callMe?, email?, timezone?, about? }` | `{ ok, user }` (422 with field errors) |
| `GET /me/sessions` | — | `{ sessions: [{ id, device, kind: web\|app, where, lastSeen, createdAt, current }] }` |
| `POST /me/sessions/:id/revoke` | — | `{ ok }` |

`user` = `{ id, email, name, firstName, callMe, role: admin|member, status, hue, timezone, about, createdAt, lastSeenAt }`

## Chat (Phase 3)
| Method & path | Body | Result |
|---|---|---|
| `GET /threads` | — | `{ threads: [{ id, kind: main|side, title, offRecord, lastActivityAt }] }` — main first, then side chats by activity |
| `GET /threads/:id/messages?limit=80` (≤ 200) | — | `{ threadId, running, pendingQuestion, messages }` — oldest first. User messages: `{ id, messageId, role: 'user', text, html, createdAt, attachments }`; replies: `{ id, messageId, runId, role: 'assistant', markdown, html, createdAt, run: { status, steps… }, question, approval, feedback }`; each has the `day` label it falls under |
| `POST /threads/:id/messages` (`:id` may be `main`) | `{ text, clientId, attachments?: [libraryId] }` (text may be empty when files are attached; ≤ 6 files, the person's own) | `{ messageHtml, runHtml, runId, threadId }`. Idempotent per `clientId`. The reply streams over `/ws` |
| `POST /uploads` | multipart: `file` (1–6 files, ≤ 25 MB each), `threadId?` | `201 { files: [libraryItem], errors: [{ name, error }] }` — each file becomes a Library item (PDF, image, Word, text; the type comes from the bytes); attach them to a message by id. `422` when none could be taken |
| `POST /runs/:id/cancel` | — | `{ ok }` |
| `POST /runs/:id/retry` | — | `{ runId, runHtml }`. Only for error or cancelled runs |
| `POST /questions/:id/answer` | `{ answers: [{ questionId, value, other? }] }` | `{ ok, cardHtml }`. The paused run resumes |
| `POST /threads` | `{ title? }` | `{ threadId, redirect }`. Creates a side chat |
| `POST /threads/:id/rename` | `{ title }` | `{ ok }` |
| `POST /threads/:id/off-record` | `{ on: true|false }` | `{ ok, offRecord }` — off the record (decision #123): while on, nothing from this chat becomes a memory (no extraction, no compaction flush; `remember` only when the person asks in that message), and the stretch stays unread after it's turned off. Side chats only (`422` for main) |
| `POST /threads/:id/delete` | — | `{ ok, redirect }` |
| `POST /threads/:id/compact` | — | `{ compacted, message }` |
| `POST /messages/:id/feedback` | `{ feedback: up/down/null, note?, noteFirst? }` (`note`: "What was off?", with a thumbs-down; `noteFirst`: save it and wait for the note, #211) | `{ ok, lesson, chip, html, waiting? }`: a thumbs-down on a reply gets a post-mortem (Phase 20, below); `lesson`/`chip`/`html` are `null` otherwise |
| `GET /messages/:id/deletion` | — | `{ role, replies, memories: [{ id, text }], messageIds, runIds }` — what deleting would remove |
| `DELETE /messages/:id` | `{ forgetMemories? }` | `{ ok, messageIds, runIds, forgotten }` — permanent (decision #50); 400 while its reply is running |
| `GET /me/memories` | `?fragment=1` (the You page) | `{ memories }`; with `fragment=1` also `html` (`partials/me/memory-list.hbs`) |
| `PATCH /me/memories/:id` | `{ text }` | Edit |
| `DELETE /me/memories/:id` | — | Forget. Hidden immediately, hard-deleted after 60 s |
| `POST /me/memories/:id/restore` | — | Undo a forget within the grace period |
| `POST /me/memories/:id/pin` | `{ pinned }` | Pin or unpin |

## Approvals & activity (Phase 4, decision #39)
| Method & path | Body | Result |
|---|---|---|
| `GET /approvals` | — | `{ pending: [approval], history: [approval] }`. `pending` = requests **you** must decide (your own, or other people's when you're their approver) |
| `POST /approvals/:id` | `{ decision: approve\|deny, scope?: once\|task\|always, reason? }` | `{ status, pendingCount }`. The paused run resumes; `task` allows the same action for the rest of that run, `always` stores a grant (admin can revoke) |
| `GET /activity?days=14` | — | `{ days: [{ label, count, items: [{ id, kind, iconName, title, detail, status: ok|bad|wait, href, at }] }], today: { done, highlights } \| null }` (max 90 days) |

`approval` = `{ id, title, tool, risk: write|spend|external, preview, requestedAt, status: pending|approved|denied|expired, scope, requester: { name } | null, threadHref,
previewChars, provenance, askReason, flags: [{ kind, label, masked }], undo: { possible, note } | null, reach, taskScope }` (Phase 18, #124–#127; the last
seven are additive, and null/empty on older requests):
- `preview` is the full text that would be sent (an email body, a calendar description, a task's instructions) up to
  20,000 characters; longer ends with `(cut at 20,000 of N characters)`. Secret-looking parts are masked in it (a card
  number shows as `••••4242`); `flags` lists them (`kind`: card, password, api_key, aws_key, github_token, slack_token,
  private_key, jwt, totp_seed). The stored call itself is unchanged and runs exactly as approved.
- `provenance`: what the task read before it asked ("Suggested after reading: email from … · page on example.com").
- `askReason`: why it asks where it otherwise wouldn't have (a grant that no longer covers it after outside content, a
  persistent write, a suspected injection, a data-catching or data-carrying URL).
- `undo`: whether it can be undone, with a note ("an email can't be recalled once it's sent"); `reach`: who it reaches
  ("only you", "everyone in the Family group", "sam@example.com", "the website example.com").
- `taskScope: false` means "this task" wouldn't cover what asked (the task read outside content): clients offer once/always only.

Policies are admin-only and edited through the web admin (`/admin/tools`, `/admin/people/:id`, `/admin/groups`);
the effective result is visible to the model only as the set of tools it is offered.

## Library (Phase 6, decision #47)
| Method & path | Body | Result |
|---|---|---|
| `GET /library?query=&type=` | — | `{ items: [item] }` (`type`: pdf, sheet, doc, md, html, image, slides or audio, only filters; with `query`: best matches first, items with all the words, then any of them; a kind of file named in it, "PDF" or "spreadsheet", matches every item of that kind, #207) |
| `GET /library/:id` | — | `{ item, versions: [{ v, current, at, sizeLabel }] }` |
| `PATCH /library/:id` | `{ title }` | `{ item }` — rename (owner only) |
| `DELETE /library/:id` | — | `{ ok, undo }` — soft delete; POST `undo` to restore |
| `POST /library/:id/restore` | — | `{ item }` |
| `POST /library/:id/versions/:v/restore` | — | `{ item, versions }` — copies version `v` as the newest version |

`item` = `{ id, title, type: html|md|…, description, sizeLabel, createdAt, updatedAt, thumbUrl, proactive, sourceLabel, origin: uploaded|downloaded|email|made, version, href, rawUrl, downloadUrl, sourceHref }`. `origin: downloaded` = a file Jess's browser downloaded (decision #117; `sourceLabel` "Downloaded from <host>"); such items arrive over the socket as `library.created` like uploads.
Admins may read anyone's items (audited) but only owners change them.

## Time: alarms, reminders, timers, schedules, check-ins, devices (Phase 7, decisions #32/#48)
| Method & path | Body | Result |
|---|---|---|
| `GET /alarms?all=1` | — | `{ alarms: [alarm] }` (live ones unless `all=1`) — the Android app schedules these locally |
| `POST /alarms` | `{ kind: alarm|reminder|timer, label, time?: "HH:MM", at?: "YYYY-MM-DDTHH:mm" (local), inMinutes?, durationSec?, repeat? }` | `201 { alarm }` |
| `POST /alarms/:id/snooze` | `{ minutes? }` (default 9) | `{ alarm }` — every device stops ringing |
| `POST /alarms/:id/dismiss` | — | `{ alarm }` — repeating alarms move to their next occurrence |
| `POST /alarms/:id/cancel` | — | `{ alarm }` |
| `GET /schedules` | — | `{ schedules: [job] }` |
| `POST /schedules/:id/:action` | `:action` = `pause` · `resume` · `run` · `delete` | `{ schedule }` (pause/resume) · `{ ok, runId, threadId }` (run) · `{ ok }` (delete) |
| `PUT /me/checkins` | `{ checkins: off|light|normal }` | `{ ok, checkins }` |
| `GET /devices` | — | `{ devices: [{ id, platform, name, pushKind, hasPush, lastSeenAt }] }` |
| `POST /devices` | `{ platform: android|ios|web|other, name?, pushKind?: webpush|unifiedpush|ntfy, pushToken? }` | `201 { device }` — webpush: `pushToken` = the browser's PushSubscription as JSON; unifiedpush/ntfy: the endpoint URL (https, public) the app's distributor gave it. Re-registering the same token updates it |
| `DELETE /devices/:id` | — | `{ ok }` |
| `GET /push/key` | — | `{ publicKey }` — this install's VAPID key for `pushManager.subscribe` |
| `POST /push/test` | — | `{ sent, gone, failed }` — a test notification to every device (5 per 10 min) |

Push (decision #85): a `notify` goes to every registered device when the person has no Jessbot page open — and always for
alarms, timers and reminders. Payload (JSON): `{ title, body, href, tag, kind }`. Subscriptions the push service reports
gone (404/410) are removed.

`alarm` = `{ id, kind, iconName, noun, label, status: scheduled|ringing|snoozed|dismissed|missed|cancelled|done, live, fireAt, whenLabel, repeatLabel, durationSec, rangAt, snoozeCount }`
`job` = `{ id, title, kind: task|checkin, scheduleLabel, nextRunAt, nextLabel, paused, lastStatus, lastRunAt, prompt }`

## Places & weather (Phase 7b, decision #49)
| Method & path | Body | Result |
|---|---|---|
| `GET /me/places` | — | `{ places: [place] }` |
| `GET /places/search?q=` | — | `{ results: [{ name, region, country, countryCode, latitude, longitude, timezone, label }] }` |
| `POST /me/places` | `{ query, label? }` or `{ latitude, longitude, label? }` (GPS) | `201 { place, user: { timezone }, weather }` — home becomes primary and sets the person's timezone |
| `DELETE /me/places/:id` | — | `{ ok }` |
| `GET /weather` | — | `{ place, forecast, summary, credit }` for the home place (forecast times are UTC ISO) |

`place` = `{ id, label, name, latitude, longitude, timezone, primary, source: chat|gps|settings|admin }`

## Connections — the person's own mail and calendar (decisions #77–#79)
Private to their owner (not even an admin can use them). Settings are tested against the real server before they are
saved; the password is sealed at rest and never returned.

| Method & path | Body | Result |
|---|---|---|
| `GET /connections` | — | `{ email: [conn], calendar: [conn], presets: { key: { label, email, calendar, help, url? } } }` |
| `POST /connections/:kind` | `:kind` = `email` `{ provider, label?, username, password, address?, imapHost?, imapPort?, imapSecure?, smtpHost?, smtpPort?, smtpSecure?, allowSelfSigned? }` · `calendar` `{ provider, label?, url, username, password }` | `201 { connection, calendars?: [{ url, name }], email, calendar }` — `400` with the server's reason when the test fails |
| `PATCH /connections/:id` | same fields (password optional: kept); calendars `calendars?: [url]` to choose which are read | `{ connection, email, calendar }` |
| `POST /connections/:id/test` | — | `{ ok, connection }` (calendar: also refreshes its events) |
| `DELETE /connections/:id` | — | `{ ok, email, calendar }` |

`conn` = `{ id, kind, label, provider, providerLabel, status: ok|error, error?, lastOkAt, address?, username, url?, imapHost?, imapPort?, smtpHost?, smtpPort?, allowSelfSigned, calendars? }`

## Feed (decisions #54, #63)
Cards are stories: `id` is `i<itemId>` for a story from their sources, or a post's public id (briefs, older posts). Every
`/feed/posts/:id/…` route takes either.

| Method & path | Body | Result |
|---|---|---|
| `GET /feed` | query: `topic`, `saved=1`, `history=1`, `q`, `page`, `before` | `{ mode: ranked|search|history, prompt, topics: [{ label, when?, active }], filters, brief?, sections: [{ label?, layout: stack|carousel, caughtUp?, posts: [post] }], next, count, status: { state: idle|working|error, note?, lastAt? } }` |
| `GET /feed/page` | same query; `page=<n>` (ranked, search) or `before=<cursor>` (history) | `{ html, next, count, mode }` — rendered cards for "Show more" |
| `POST /feed/events` | `{ events: [{ id, kind: impression|open|read|bounce|share, value? }] }` (≤ 100; value = seconds) | `{ ok, recorded }` — what the page saw and did; teaches the ranking |
| `GET /feed/posts/:id/article` | — | `{ id, status: ok|failed|null, html?, url, source }` — reader mode (read on first open; waits up to a minute) |
| `POST /feed/posts/:id/take` | — | `{ html, title, summary, written }` — Jess reads the story and writes her take (cards not written yet) |
| `POST /feed/topics/follow` | `{ topic, on? }` | `{ ok, topic, following }` — followed topics rank higher and never fade |
| `GET /feed/sources` | — | `{ topics: [{ key, label, query, when, paused, custom, failing, sources: [source] }], limits: { topics, sourcesPerTopic } }` — where stories come from (decision #89). A source: `{ id, title, kind: gnews|rss, kindLabel, host, favicon, url, siteUrl, query, mine, state: ok|failing|new, error, errorCount, fetchedAt, nextFetchAt, items, latestAt }` |
| `POST /feed/topics` | `{ label, query?, when?: any|morning|midday|evening }` | `201 { topic, html }` — a topic of their own (≤ 12); it starts with a Google News search for `query` (default: the label) |
| `POST /feed/topics/:key/edit` | same as above | `{ topic, html }` — the topic keeps the person's words across re-tunes |
| `POST /feed/topics/:key/pause` | `{ paused }` | `{ topic, html }` — a paused topic isn't fetched, and its stories leave the feed and search |
| `DELETE /feed/topics/:key` | — | `{ ok, label }` — its sources go too; re-tuning won't bring it back |
| `POST /feed/topics/:key/sources` | `{ url }` — a site (`theverge.com`) or a feed link | `201 { topic, html, source, how: feed|search, added, message }` — finds the site's feed (up to a minute), else follows the site through Google News; fetched once right away. ≤ 10 per topic; 20 adds per 10 min |
| `DELETE /feed/topics/:key/sources/:id` | — | `{ topic, html, message }` — re-tuning won't bring it back to this topic |
| `POST /feed/sources/:id/check` | `{ topic? }` | `{ source, added, html }` — fetch it now (30 per 10 min) |
| `POST /feed/prompt` | `{ prompt }` (≤ 2,000 chars) | `202 { ok, state: 'working' }` — topics + sources are set up and a digest runs in the background |
| `POST /feed/refresh` | — | `202 { ok, state: 'working' }`; 400 if nothing is tuned yet |
| `POST /feed/posts/:id/feedback` | `{ feedback: up|down|null }` | `{ ok }` |
| `POST /feed/posts/:id/save` | `{ saved }` | `{ ok }` |
| `POST /feed/posts/:id/hide` | `{ what: topic|source, undo? }` | `{ ok }` — mutes (or unmutes) that topic / source |

`post` = `{ id, kind: hero|compact|tile, topic, title, summary, html (empty until written), written, cover?, hue, source: { name, host }, favicon?, sources? (+N outlets), url, createdAt, readMinutes?, saved, feedback?, why?, explore?, hasArticle }`
· `brief` = `{ id, title, at, bullets: [string], html }`

## Goals & ideas (Phase 8, decision #55)
| Method & path | Body | Result |
|---|---|---|
| `GET /goals` | — | `{ active: [card], suggested: [card], longTerm: [card] }` |
| `POST /goals` | `{ title, category? }` | `201 { goal: card, redirect }` — questions are written in the background |
| `GET /goals/:id` | — | `{ goal: detail }` |
| `PATCH /goals/:id` | `{ title?, category?, state?: active|paused|done|archived, horizon?: now|long }` | `{ goal: card, redirect? }` |
| `POST /goals/:id/answers` | `{ answers: [{ questionId, value, other? }] }` | `{ ok }` — the plan is written next |
| `POST /goals/:id/skip` | — | `{ ok }` — plan without answers |
| `POST /goals/:id/tasks/:taskId` | `{ enabled }` | `{ ok, task: { id, enabled, status } }` — once: runs now · recurring: scheduled/paused |
| `POST /goals/:id/checkin` | — | `202 { ok }` — a fresh look at where things stand |
| `POST /goals/:id/retry` | — | `202 { ok }` — redo the step that failed (questions or plan) |
| `POST /goals/:id/adopt` | — | `{ ok, redirect }` — a suggested goal becomes active (questions next) |
| `POST /goals/:id/dismiss` | — | `{ ok }` — never suggested again |
| `POST /goals/:id/restore` | — | `{ ok }` — undo a dismiss |
| `POST /ideas/:id/start` | — | `{ ok, redirect: '/chat' }` — the idea's prompt is sent as the person's message (`:id` may be a starter id) |
| `POST /ideas/:id/snooze` | — | `{ ok }` — back in 3 days |
| `POST /ideas/:id/dismiss` | — | `{ ok }` |
| `POST /ideas/:id/restore` | — | `{ ok }` — undo |
| `POST /ideas/generate` | — | `{ added, itemsHtml, message? }` — reflect now |

`card` = `{ id, title, category, hue, progress, statusLine?, nextStep?, lastCheckIn?, state: active|needs_input|suggested|done, activity? }`
· `detail` = card + `{ summary?, state, horizon, stage, error?, busyNote?, threadHref?, pendingQuestion?, plan: [step], timeline: [event] }`
· `step` = `{ id, title, description?, iconName, enabled, status: todo|doing|done, failed?, when?, href? }`

## Projects (docs/PROJECTS.md, decision #91)
A project is one continuous chat (its `threadId`) with a brief and files. Send messages to it like any chat
(`POST /threads/:threadId/messages`). Projects are proposed by Jess in a chat (a New project card on her reply, `proposal`
on the message view) and exist once the person presses Create.
| Method & path | Body | Result |
|---|---|---|
| `GET /projects` | — | `{ projects: [project], archived: [project], fields: [{ value, label }], icons: [name] }`. A project: `{ id, name, icon, hue, field, fieldLabel, about, status: active|paused|done|archived, href, threadId, running, waiting, fileCount, lastActivityAt, next }` |
| `GET /projects/:id` | — | `{ project, sections: [{ kind, title, items: [{ id, kind, text, mine, state }] }], done, intake: [{ question, answer }], files: [libraryItem], goals, brief }` — `brief` is the plain-text brief |
| `POST /projects/:id/create` | — | `{ project, href, cardHtml }` — Create on a New project card: the draft becomes a project and Jess opens its chat |
| `POST /projects/:id/dismiss` | — | `{ ok, cardHtml }` — Not now (drafts only) |
| `POST /projects/:id/edit` | `{ name?, about?, field?, icon?, hue? (0–359), status? }` | `{ project, cardHtml? }` — works on drafts too ("Edit first") |
| `DELETE /projects/:id` | — | `{ ok, redirect }` — the chat and brief go; files stay in the Library |
| `POST /projects/:id/brief` | `{ kind: goal|status|decision|question|next|constraint|number|note, text }` | `201 { item }` — the person's own row (Jess never changes it) |
| `POST /projects/:id/brief/:itemId` | `{ text?, state?: open|done }` | `{ item }` — editing a row makes it the person's |
| `DELETE /projects/:id/brief/:itemId` | — | `{ ok }` |
| `POST /threads/:id/make-project` | `{ name?, about?, field? }` | `201 { project, redirect }` — a side chat becomes a project, history included |
| `GET /projects/:id/soul` | — | The project soul (decision #93): `{ has, version, by, stance, fields: { stance, person, anchors[], askFirst[], checkWork[], format, glossary[], learned[] }, editable (lists as lines), safety, tokens, sections, versions: [{ version, by, note, at, current }], drift, proposal? }` |
| `POST /projects/:id/soul` | `{ fields }` (lists as arrays or newline text) | `{ version }` — saves a new version (the safety block is set by the app, per field) |
| `POST /projects/:id/soul/improve` | — | `201 { proposal }` — AI drafts or sharpens it; nothing changes until accepted. 8 per 10 min |
| `POST /projects/:id/soul/proposals/:proposalId` | `{ decision: accept|reject }` | `{ status, version?, cardHtml }` — a proposal: `{ id, status: pending|accepted|rejected|stale, source: jess|ai, reason, quote?, diff: [{ key, label, list, before?, after?, added?, removed? }] }` |
| `POST /projects/:id/soul/restore/:version` | — | `{ version }` — the old version becomes the newest |
| `POST /projects/:id/soul/forget` | `{ note }` | `{ version }` — drop a "learned together" note |
| `POST /projects/:id/soul/try` | `{ question, proposalId? }` | `{ answer, html }` — a preview answer with the current soul or a proposal; nothing saved. 20 per 10 min |
| `POST /projects/:id/save-message` | `{ messageId }` | `201 { item }` — one of Jess's replies in the project chat saved as a project file (decision #94). Project files are indexed page by page for Jess's `project_search`; `files[].useCount` says how often she used each |

Live frames: `projects.changed` (the list changed — refresh it) and `project.updated { id }` (a brief or files changed).
Uploads: pass the project's `threadId` to `POST /uploads` and the files join the project; long pastes and code blocks sent
to a project chat are kept as project files automatically (the message shows a pointer and the files are attached).

## Voice (docs/VOICE.md, decisions #99–#100)
| Method & path | Body | Result |
|---|---|---|
| `POST /threads/:id/voice-notes` (`:id` may be `main`) | multipart: `audio` (a 16-bit PCM WAV, 0.5 s–5 min, ≤ 12 MB), `clientId` | Same as sending a message: `{ messageHtml, runHtml, runId, threadId, transcript }`. The note is transcribed, sent as their message (it shows as a player + transcript) and her reply comes back as a voice note (`voice.ready`). Idempotent per `clientId`. `422 { errors: { audio } }` when it's too short, too long or has no words. 30 per 10 min |
| `POST /messages/:id/speak` | — | `{ clip, html }` — Listen: her reply (one of their assistant messages) as a voice note, made once then cached. 40 per 10 min |
| `GET /voice/:id` | — | The audio (`audio/wav`; Range requests work). Only its owner — and admins, read-only |
| `POST /admin/voice` (admin) | `{ model?, fallbackModel?, sttModel?, voice? ('' = Auto), direction? ('' = Auto), speed? (1, 1.1, 1.15, 1.2, 1.25, 1.5) }` | `{ ok, settings }` |
| `POST /admin/voice/preview` (admin) | `{ voice?, direction?, text? }` — unsaved choices included | `{ audio (base64 WAV), transcript, model, voice, attempts, durationMs, ms }`. 20 per 10 min |

`clip` (also `voice` on messages from `GET /threads/:id/messages`) = `{ id, src, direction: in|out, durationMs, duration,
peaks: [48 bars, 8–100], transcript, voice, rate }` — `rate`: the speed to play it at (hers: the speaking speed; theirs: 1). A reply being spoken right now has `voice: { pending: true }`.
Live frames: `voice.ready { messageId, html }` (the player for that reply) and `voice.failed { messageId, error }`.

## Quick decisions (Phase 16, docs/JEV.md) — admin
| Method & path | Body | Result |
|---|---|---|
| `POST /admin/decide` | `{ model?, textModel?, confidence? (0.5–0.9), uses?: { checkin, memory, reflect, turn, page, risk, steps, feed: bool } }` | `{ ok, settings }` |
| `POST /admin/decide/try` | `{ state, question, kind: choice|noul|score, options? (one per line; score: lowest first) }` | `{ summary, confidence, bars: [{ label, p, top }], ms, cost }` — one live decision, nothing else changes. 60 per 10 min |
| `GET /admin/decide/recent` | — | `{ decisions: [{ id, use, label, iconName, outcome, confidence, acted, fallback, ms, at }], html }` — the last 25 |

## Skills (decisions #84, #121) — admin
| Method & path | Body | Result |
|---|---|---|
| `GET /admin/skills/:name/review` | — | `{ skill: { name, description, toolsets, origin, status: active|review|off|broken, problems[], license, approvedAt, files, lines }, raw, findings: [{ level: bad|warn|info, code, line, excerpt, message, file?, other? }], summary: { bad, warn, info }, changes: { available, reason?: never-approved|approved-before-copies, approvedAt, added, removed, hunks: [{ oldStart, oldLines, newStart, newLines, lines: ['+…','-…',' …'] }], files: [{ name, change: added|removed|changed }] }, usage: { count (30 days), lastUsedAt } }` — the review screen's data. Excerpts show hidden characters as `⟦U+200B⟧`; lines point into SKILL.md (front matter included) or into `file` |
| `POST /admin/skills/:name/approve` | `{ force? }` | `{ ok, skill }`. `409 { code: 'lint_bad', error }` when the review found something serious and `force` isn't `true` ("approve anyway"); `422` for a broken skill |
| `POST /admin/skills/:name/disable` | — | `{ ok, skill }` |
| `POST /admin/skills` | `{ name, description (≤ 400), toolsets[] (known ones only), body, force? }` | `{ ok, skill }` — saved and approved; `422 { errors }` for an unknown toolset or a long description (nothing is cut); `409 lint_bad` as above |
| `DELETE /admin/skills/:name` | — | `{ ok }` (your own skills only) |

Error responses may carry `code` (a machine-readable reason, e.g. `lint_bad`) next to `error`.

## Markdown preview (Phase 15)
| Method & path | Body | Result |
|---|---|---|
| `POST /markdown/preview` | `{ text }` (≤ 200,000 chars) | `{ html }` — rendered by the chat's renderer (raw HTML is escaped); nothing is saved. The editors' Preview tab. 240 per 10 min |

## Browser hand-over (decision #61)
| Method & path | Body | Result |
|---|---|---|
| `GET /threads/:id/browser` | — | `{ open, url, title }` — Jess's tab for that chat (`:id` may be `main`) |
| `GET /threads/:id/browser/frame.jpg` | — | the tab as a JPEG (no-store); 404 when no tab is open |
| `GET /threads/:id/browser/stream.mjpg` | — | the tab as live video: `multipart/x-mixed-replace` JPEG frames (an `<img>` plays it) — a snapshot first, then a frame whenever the page changes, ≤ ~10/s; the screencast stops when the request closes (#115) |
| `POST /threads/:id/browser/input` | `{ kind: click, x, y }` (0–1 fractions) · `{ kind: wheel, dy }` · `{ kind: type, text }` · `{ kind: key, key }` · `{ kind: back | reload }` | `{ ok, url, title }` |
| `POST /threads/:id/browser/done` | `{ quiet? }` | `{ ok, next }` — hand the tab back. `next`: `sent` (Jess is told; `runId`), `running` (she's already working — nothing sent twice), `answer` (she's waiting on a question — answer that instead), `quiet` (just closing the viewer; nothing sent) |

Only the chat's owner. Run steps may carry `handover: true` (show "Take over the browser").

## Files outside `/api/v1`
| Path | Auth | Notes |
|---|---|---|
| `GET /library/:id/raw?v=` | cookie or Bearer | The file itself. HTML is always served with the artifact sandbox CSP (opaque origin, no network APIs) |
| `GET /library/:id/download?v=` | cookie or Bearer | Same, as an attachment |
| `GET /library/:id/thumb.jpg` | cookie or Bearer | Preview image of HTML items |
| `GET /feed/covers/:file` | cookie or Bearer | Story cover images (content-addressed, cached immutably) |
| `GET /shots/:file` | cookie or Bearer | Web screenshots referenced by run steps (`step.image`). Only the person they were taken for, or an admin; otherwise 404 |

Run steps (in `runHtml`, `run.step` frames and `run.done` html) may carry `image` — a screenshot path as above.

## WebSocket `/ws` (decision #31)
**Auth.** The same token, carried as the `jb_session` cookie (the Origin must match the host) or as `Authorization: Bearer` / `?token=` (apps). A failed auth gets HTTP 401 on upgrade.

**Server frames** have the shape `{ t, seq?, threadId?, runId?, data }`:

| Type | Data |
|---|---|
| `hello` | `{ seq, userId }` |
| `agent.state` | `{ activity, target?, since?, doneToday }` (not persisted) |
| `run.status` | `{ status, error? }` |
| `run.step` | `{ step: { id, iconName, label, detail?, image?, status, durationLabel? } }` |
| `run.delta` | `{ text }`, streamed reply text in about 80 ms batches |
| `run.done` | `{ status, html }`. `html` is the final rendered bubble. A retried run: `{ hidden: true, replacedBy: { runId, html } }` — the new reply takes its place (#102) |
| `voice.ready` / `voice.failed` | `{ messageId, html }` / `{ messageId, error }` — her voice note of that reply is ready (the player) or couldn’t be made |
| `question.created` | `{ questionId, html, dock }` |
| `question.expired` | `{ id }` — they sent a new message instead of answering; drop the dock (the reply follows as `run.done`) |
| `approval.created` | `{ approvalId, html?, cardHtml, pendingCount }`. To the requester (`html` = the paused bubble) and, if different, to the approver (card + badge count) |
| `approval.updated` | `{ approvalId, status, pendingCount }`. Decided or expired; every copy of the card updates |
| `activity.new` | `{ item }`. A new activity-log entry |
| `library.created` / `library.updated` | `{ item, html? }`. `html` = the rendered library card |
| `library.deleted` | `{ id }` |
| `messages.deleted` | `{ messageIds, runIds }` — remove those bubbles |
| `alarm.ring` | `{ alarm }` — start ringing (web shows the dock + chime) |
| `alarm.updated` | `{ alarm }` — any state change (snoozed / dismissed on another device → stop) |
| `weather.updated` | `{ sky: { bucket, sunrise, sunset, temp, label }, place }` — not persisted; the avatar's sky follows |
| `feed.progress` | `{ state: idle|working|error, note? }` — what the feed digest is doing (not persisted) |
| `feed.topics` | `{ topics: [{ label, when? }] }` — a tune finished setting up topics (not persisted) |
| `goal.updated` | `{ id?, busy?, suggested? }` — a goal changed (questions/plan ready, step done, check-in); re-render (not persisted) |
| `projects.changed` | `{}` — a project was created, renamed, archived or deleted; refresh the list (not persisted) |
| `project.updated` | `{ id, brief?, files? }` — a project's brief or files changed; refresh its panel (not persisted) |
| `ideas.updated` | `{ added }` — reflection found new ideas |
| `feed.updated` | `{ added, reason: tune|refresh|scheduled }` — new stories are in |
| `notify` | `{ kind: message|reminder|alarm|timer|schedule|feed, title, body, href, tag }` — reach the person (toast / system notification) |
| `run.started` | `{ html }` — a run Jess started on her own (scheduled task); `run.done` may also carry `hidden: true` (a silent check-in) |
| `agent.moment` | `{ kind }` (not persisted) |
| `memory.updated` | `{ count }` |
| `thread.compacted` | `{ summaryId, count }` |
| `resumed` | `{ count }` |
| `reload` | — (the client is too far behind) |

**Client frames:**
- `{ t: 'resume', data: { lastSeq } }`: the server replays every persisted event after `lastSeq`, from SQLite.
- `{ t: 'ping' }`

**Heartbeat.** The server pings every 25 s and drops dead sockets. The client reconnects with jittered backoff, and web pages start from the seq they were rendered at (`<html data-seq>`).

## Building a client (the Android app)

Everything the web UI does is available here; the web pages add nothing a client needs. A client, end to end (the
chat suite's "android client" test does exactly this):

1. **Sign in:** `POST /auth/login { email, password, device }` → `{ token }`. Keep the token in the platform keystore.
   Send `Authorization: Bearer <token>` on every call. A `401` means signed out (revoked, disabled, expired).
2. **Live updates:** open `/ws?token=<token>` (or the `Authorization` header). Remember the last `seq` you processed; on
   reconnect send `{ t: 'resume', data: { lastSeq } }` and you get what you missed (`reload` if too far behind).
3. **Chat:** list chats with `GET /threads`; draw one with `GET /threads/:id/messages` (use `markdown` or `html`); send with
   `POST /threads/:id/messages { text, clientId, attachments? }` — `clientId` (a UUID per message) makes retries safe.
   The reply arrives as `run.step` / `run.delta` frames and ends with `run.done` (its `html` is the final rendering; the
   text is in the message list). `question.created` → answer with `POST /questions/:id/answer`; `approval.created` →
   `POST /approvals/:id { decision }`.
4. **Files:** `POST /uploads` (multipart `file`) → Library items; attach their ids to a message. Download with
   `GET /library/:id/download`.
5. **Notifications:** register the device with `POST /devices { platform: 'android', pushKind: 'unifiedpush', pushToken:
   <your distributor's endpoint> }` (ntfy or any UnifiedPush distributor — no Google services needed). Pushes carry
   `{ title, body, href, tag, kind }`; open `href` in the app. Alarms and timers should also be scheduled locally from
   `GET /alarms` so they ring even offline; the push is the backup.
6. **Everything else** (Library, Upcoming, Feed, Goals, Connections, You) is the same JSON as above.

Errors: show `error` to the person as written — 4xx messages are meant for people; 5xx says "something went wrong".
Rate limits answer `429` with a message saying when to try again.

## Coming next
| Area | What |
|---|---|
| Sign-in with Google / Microsoft | OAuth for Gmail, Google Calendar and Microsoft 365 (app passwords work today) |

## Signed-in sites (Phase 21, decision #136)

Each person's browser keeps cookies between sessions (sign-ins they did during a hand-over), sealed on disk with the
install's key. These routes list and forget them; the screen ("Signed-in sites" under You → Connections) comes in Phase 25.

| Method & path | Body | Returns |
|---|---|---|
| `GET /me/browser/sites` | `?all=1` also lists sites with only non-sign-in cookies | `{ sites: [{ site, cookies, signIn, expires }] }` — `site` is the registrable domain (`bbc.co.uk`), `signIn` how many of its cookies look like a sign-in, `expires` the latest sign-in cookie expiry (ISO) or `null` for session cookies |
| `DELETE /me/browser/sites/:site` | — | `{ ok, removed }` — removes that site's cookies and storage from the person's live browser and saved profile; `400` for something that isn't a site name |

## Lists (Phase 22, decision #139)
Family lists: shopping, to-do, wish, packing and custom. A list is private or shared with a group the person belongs to
(`scope`: `"private"` or the group's name), with the same rules as memories: people see their own lists and their groups'
lists, write only where they belong, and anyone else's list answers `404`. Only whoever made a list (or the admin) can rename,
archive or restore it; every member can add, tick, change and remove items. Items change one row at a time, so two people
ticking at once never overwrite each other (a tick on an item someone just ticked keeps their name). Wish lists: when someone
other than the wisher ticks an item it is **bought**, and the wisher never sees that (not in `done`, `bought`, counts or events).
Every change publishes `list.updated` `{ listId }` over the WebSocket to the list's members (never to the wisher for a hidden
"bought"); refetch `GET /lists/:id`.

List object: `{ id, title, kind, scope: 'private' | group name, shared, ownerId, owner, wisherId, wisher, canManage, open, done,
archived, updatedAt }` (counts as the viewer sees them). Item object: `{ id, text, qty, category, assigneeId, assignee, dueAt,
done, doneAt, doneBy, doneById, bought, createdBy, pos }`. Shopping items get a `category` (aisle) inferred from their words in
English, French or Arabic; `"Milk 1L"` / `"2 kg rice"` are parsed into `text` + `qty` on shopping, packing and custom lists.

| Method & path | Body | Returns |
|---|---|---|
| `GET /lists` | `?archived=1` for the archived ones instead; `?fragment=1` (the web page) | `{ lists: [list] }`; with `fragment=1` also `html` (the Lists page's cards, `partials/lists/index-body.hbs`) |
| `POST /lists` | `{ title, kind?, scope?, wisherId? }` | `201 { list, existed: false }`, or `200 { list, existed: true }` when that name already exists there; `403` for a group they aren't in |
| `GET /lists/:id` | `?fragment=1` (the web page) | `{ list, items: [item], members: [{ id, name }] }` (open items first, in order; `members`: who shares it, for assignee pickers); with `fragment=1` also `html` (`partials/lists/items.hbs`) |
| `PATCH /lists/:id` | `{ title?, kind? }` | `{ list }` (maker or admin) |
| `DELETE /lists/:id` | — | `{ ok }` — archives it (maker or admin) |
| `POST /lists/:id/restore` | — | `{ list }` |
| `POST /lists/:id/items` | `{ items: [{ text, qty?, category?, assigneeId?, due? }] }` or one such object | `201 { added, updated, already, list }` — an item already open isn't added twice (a new `qty` replaces the old one); a ticked one comes back open. `due`: `YYYY-MM-DD` or ISO; `assigneeId` must share the list (`422`) |
| `PATCH /lists/:id/items/:itemId` | `{ text?, qty?, category?, assigneeId?, due?, pos?, done? }` | `{ item }` |
| `DELETE /lists/:id/items/:itemId` | — | `{ ok }` |
| `POST /lists/:id/clear-done` | — | `{ removed, list }` — removes the items this person sees as done |

## Name pronunciation (Phase 22, decision #143)
`POST /me/profile` also takes `nameSay`: how the person's own name is said, as a phonetic spelling her voice reads instead of
the written name (`"Shi-vawn"`; letters, marks, spaces, hyphens, apostrophes; at most 60; `""` clears; `422` with
`errors.nameSay` otherwise). `GET /me` returns it as `user.nameSay`. Fields left out of `POST /me/profile` now stay as they are
(an empty string clears one), so an app can send only what changed.

## Audio in the Library (Phase 22, decision #142)
Library items can be `type: 'audio'` (a long read-aloud Jess made with `make_audio`): a WAV (pcm16, 24 kHz mono) at
`GET /library/:id/raw` (supports `Range`) and `/download`; its text (search, Jess) is the script she read. Uploads also accept
`.srt` and `.vtt` caption files: kept as uploaded (`ext` `srt` / `vtt`), and read as the cleaned transcript (cue numbers,
timings and markup removed, rolling captions de-duplicated, one paragraph per speaker turn).

## Library: descriptions, exports and checks (Phase 22, decisions #144–#147)
`PATCH /library/:id` takes `{ title?, description? }` (either or both; `""` clears the description; `422` with `errors.title`
when neither is given or the title is empty or over 120 characters). It works for every item, uploads and scans included
(before, renaming an uploaded PDF or image failed validation), never touches the file and adds no version; search covers the
new title and description at once. Library `item` gains `madeFrom: { id, title, href } | null`: the page a PDF or PNG was
exported from (`library_export`; null for everything else or once that page is deleted). Exports are ordinary Library items
(`type: 'pdf'` or `'image'`, `sourceLabel` "Exported from a page", `origin: 'made'`) and arrive over the socket as
`library.created` / `library.updated` like any other. The agent's page checks (a thumbnail, script errors, phone width) happen
when a page is saved and change nothing in the API: the thumbnail is still `thumbUrl`.

## Memory: dates, import, episodes (Phase 20, decisions #151–#156)
`GET /me/memories` items gain `importance` (1–3), `date` (`YYYY-MM-DD`, `YYYY-MM-DDTHH:MM` in the person's time, or `MM-DD` for
a yearly date without its year; `null` when undated), `recurs` (`'yearly'` or `null`), `dateLabel` ("14 Feb 2016, every year" ·
"22 Sep 2026, 15:00"), `useCount` and `lastUsedAt`. `memory.updated` also fires after an import.

| Method + path | Body | Returns |
|---|---|---|
| `POST /me/memories/import/preview` | `{ text, filename? }`: a pasted memory export from another assistant (lines, markdown, or JSON such as `["…"]` / `{ memories: [{ content }] }`) or a `.vcf` file's text (≤ 500,000 characters) | `{ format: vcard\|json\|text, candidates: [{ key, text, kind, date, recurs, dateLabel, source, problem, duplicateOf }], truncated }`: nothing is saved. `dateLabel` is the date in words ("14 Mar, every year"). `?fragment=1` (the You page) adds `html`, the candidates to tick (`partials/me/import-preview.hbs`). `problem` says why one can't be saved (too long, a secret, instruction-looking); `duplicateOf` is the id of a memory that already says it. Contacts give birthdays and anniversaries (yearly, with the year when known) and relations ("Diego is Maya Smith's brother"). At most 300 candidates; 60 previews per 10 min |
| `POST /me/memories/import` | `{ items: [{ text, kind?, date?, recurs? }] }` (the chosen candidates, ≤ 300) | `{ ok, saved: [{ id, text }], skipped: [{ text, reason, memoryId? }] }`: saved private, marked as the person's own (extraction never overwrites them), through the same filters as every memory; a near-duplicate is skipped as "Already remembered." |
| `GET /me/episodes?limit=100` (≤ 200) | — | `{ episodes: [{ id, text, date, threadId, observedAt }] }`: the one-line notes of earlier conversations, newest first |

## Lessons and the weekly memory tidy (Phase 20 part B, decisions #186–#189)
A lesson is one rule for how Jess works ("When …, do … (not …)"). `lesson` = `{ id, scope: person|household, rule, why, domain
(a site like `booking.com`, or null), source: said|thumbs_down|pushed|owner, status: active|proposed|retired|rejected|promoted, uses,
lastUsedAt, recurrences, createdAt, updatedAt, reviewedAt, retireSuggested (active but unused for 90 days: offer to retire it, never
removed by itself), recent: { hits, tasks } (times learned in the last 30 days, in how many tasks), promotable, runId,
sourceMessageId }`. Personal lessons are the person's alone (the admin never sees them).

A thumbs-down (`POST /messages/:id/feedback { feedback: 'down', note? }`) waits for one cheap model call (≤ 25 s) and answers
`{ ok, lesson, chip: { text: "Noted: …", lessonId, keep } }`, or `lesson: null, chip: null` when there is nothing general to learn,
the chat is off the record or the person is over budget. With a `note` the lesson is theirs and active; without one it is a guess
(`status: 'proposed'`, `chip.keep: true`) until they press Keep. Taking the thumbs-down back (or thumbs-up) removes a guess never kept.

| Method + path | Body | Returns |
|---|---|---|
| `GET /me/lessons` | — | `{ lessons }`: their own, active and proposed first (newest first), then retired |
| `PATCH /me/lessons/:id` | `{ rule?, why?, status?: active\|retired }` | `{ ok, lesson }`; 422 `{ errors: { rule } }` for a secret, an instruction-looking text or > 220 characters |
| `POST /me/lessons/:id/keep` | — | `{ ok, lesson }`: the chip's Keep (a proposal becomes active) |
| `DELETE /me/lessons/:id` | `{ reject? }` (or `?reject=1`) | `{ ok }`: removed for good; with `reject` a proposal is kept as rejected only so the same guess isn't made again |
| `GET /me/memory-tidies?limit=10` (≤ 50) | — | `{ tidies: [tidy] }`: the weekly tidies that changed something, newest first |
| `GET /me/memory-tidies/:id` | — | `{ tidy }` (the Activity item links to `/me/memory?tidy=<id>`) |
| `POST /me/memory-tidies/changes/:id/undo` | — | `{ ok, already? }`: the memories the change took out come back; a merge's new memory goes. 422 when the merged memory was changed since (edit it instead) |

`tidy` = `{ id, at, status, merged, archived, changes: [{ id, op: merge|archive, why, undone, before: [{ id, text, dateLabel }],
after: { id, text } | null }] }`. `memory.updated` fires `{ tidy }` after a tidy that changed something.

**Admin (web routes under `/admin`, JSON, send `X-Requested-With: jessbot`):** household lessons only. `GET /admin/lessons/list?status=`
(proposed|active|retired|promoted|rejected|all) → `{ lessons: [lesson + { fromName, run: { id, at, label, href } }], proposed,
retireSuggested }` (`run.href` only when the chat is the admin's own); `POST /admin/lessons { rule, why?, domain? }` (the owner's own,
active at once); `PATCH /admin/lessons/:id { rule?, why?, domain? }`; `POST /admin/lessons/:id/approve { rule?, why?, domain? }`
(edit and approve); `POST /admin/lessons/:id/reject`; `POST /admin/lessons/:id/retire`; `POST /admin/lessons/:id/promote` (into
AGENTS.md under "## Lessons learned", a versioned save; 422 until it came up 3 times in 2 different tasks within 30 days). Each
answers `{ ok, lesson }` and writes an `admin.lesson.<action>` audit row. Household lessons refuse personal details (emails, phone
or account numbers, IBANs, links with parameters, household members' names): 422 `{ errors: { rule } }`.

## Runs that finish and tell the truth (Phase 19 part A, decisions #128–#130, #148–#150)
All additive.
- **Approvals.** `approval` gains `closedReason` (`timeout` | `moved_on` | `run_closed`, only when `status` is `expired`) and
  `resultLabel` (the decided line: "Approved", "Denied", "Expired, not done", "Expired: you moved on, so it was not done",
  "Closed: that task had ended, not done"). A new message in a chat closes that chat's pending approvals (`moved_on`), and
  Stop / a failure / a restart closes a run's (`run_closed`). `POST /approvals/:id` on such a request, or on a pending one
  whose run no longer waits, answers **`409 { error, code: 'approval_closed' }`** ("This request closed when you sent a new
  message, so nothing was done…") and runs nothing; the page paints the card closed. `approval.updated` gains
  `closedReason` and `label` (the same line).
- **Runs.** `run` (in message/thread views) gains `errorKind` (`transient` | `permanent` | `interrupted` | `budget` on a
  failed run; `missed` on the note for a scheduled task missed while offline), `retryAt` (ISO: the one automatic retry of a
  scheduled or goal run after a passing provider/network failure; the error text says "I'll try again by myself at 07:10.")
  and `scheduleId` (the schedule behind it: "Run it now" for a failed or missed task). `POST /runs/:id/retry` is unchanged
  in shape; the retry shares the first attempt's trigger message, so a change that attempt already made (a send, a save)
  is not made again. A run interrupted by a restart after an approved call started ends with an "outcome unknown" result
  (it may or may not have happened) and goes on once to say so; a waiting run never stays stuck.
- **Schedules.** `job` gains `lastStatus` values `silent` (checked, nothing to say), `skipped` (not run: offline, quiet
  hours, budget), `running` and `retrying` (next to `ok`, `bad`, `null`; `skipped` and `silent` are no longer reported as
  `ok`), `lastRunId`, `endsAt` + `endsLabel` (the `until` day's end), and `watch` for watches:
  `{ condition, url, lastNote, notedAt, checkedAt, checkedLabel, lastCheck: unchanged|noted|reported|failed|missed, failStreak,
  line }` (`line` = "Watching · last: fare 950 EUR · checked 07:00, nothing to report"). `POST /schedules/:id/run` on a watch
  always answers (what it found, condition met or not) and keeps its note.

## Email files, tidying, free time, calendar files (Phase 22 part E, decisions #157–#160)
All additive.
- **Busy sharing (consent).** `POST /me/profile` also takes `shareBusy` (boolean; `"true"`/`"false"`/`1`/`0` from a form):
  "Share when I'm busy with my household". Off by default. `GET /me` (and every `user`) returns `user.shareBusy`. When on,
  people who share a group with this person may have the TIMES this person is busy counted when Jess looks for a time that
  suits everyone (`calendar_free_slots` with `people`); titles, places, notes and which calendar never leave the server, not
  even to Jess. Each change of the setting is audited (`calendar.share_busy`, `{ on }`), and each lookup of this person's
  busy times by someone else (`calendar.busy_lookup`, actor = who asked, target = whose, `{ from, to, blocks }`: metadata
  only). The "You" screen gets the switch in Phase 25.
- **Library.** Attachments saved from an email (`email_save_attachments`) are ordinary Library items with `origin:
  'email'` and `sourceLabel` "From email: “<subject>”" (files saved before decision #161 have `origin: 'downloaded'`, "Downloaded from an email: …"), typed from their bytes like uploads, and arrive
  over the socket as `library.created`. Calendar files (`make_calendar_file`) are items with `type: 'md'`, `ext: 'ics'`,
  `kindLabel` "Document", `description` "Calendar file · N events"; `GET /library/:id/download` now serves every text item
  with its own stored type, so a calendar file downloads as `text/calendar` (phones offer to add it) and a downloaded CSV
  as `text/csv` (documents stay `text/markdown`, pages `text/html` with the sandbox CSP).
- **Approvals.** An `email_send` approval's `preview` now lists its files ("Attached: 2 files, 1.2 MB" then one line each:
  title, kind, extension, size, and anything secret-looking inside, masked). `email_organize` asks only for more than 20
  messages or a move into the bin or spam; its card has `undoable: true`, `reach` "your mailbox only". No endpoint changes.

## Seeing documents: page pictures, OCR, office previews (Phase 22, decisions #161–#163)
- **Library `item` gains** `textSource: 'ocr' | null` (its current text was read from a scan by OCR and may contain errors;
  null = the file's own text) and `pagePictures: [url]` (office files LibreOffice printed: pictures of the first pages, at
  most 3, `GET /library/:id/pages/:n.jpg?v=<version>`, JPEG, owner or viewing admin only; `[]` otherwise). PDFs now get a
  first-page `thumbUrl` (drawn in the background after the save; the item arrives again as `library.updated` with its card
  when it is ready), and so do Word, Excel and PowerPoint files when LibreOffice is installed on the server.
- `POST /library/:id/ocr` `{ pages?, confirm? }` — read a scanned PDF (or a photo of a paper) by OCR, opt-in per file.
  Without `confirm`: `{ estimate: { pages: [n], count, capped: [n], cost (USD or null when the model has no known price),
  costLabel, model, priceSource: 'list' | 'history' | null, budget: { limit, spent, left } } }`; nothing is spent. With
  `confirm: true`, only after that estimate for the same file and pages in the last 30 minutes (else `400`), and only when
  this week's budget covers it (else `400` naming the amounts): `{ item, read: [n], blank: [n], missing: [n], capped: [n],
  cost, costLabel, error }`. `pages`: `"1-5, 8"`; default the pages with no text; at most 20 per reading (`capped` lists
  the rest). `error`: why it stopped early (what was read before is kept). The item then has `textSource: 'ocr'` and a
  description ending "· text from OCR"; usage is recorded as purpose `ocr` ("Reading scans" in Admin → Usage).

## Pictures: make_image (Phase 22, decisions #169–#170)
All additive.
- `POST /admin/images` (admin) `{ model }` — the image model `make_image` draws with (an OpenRouter image model id such as
  `black-forest-labs/flux.2-klein-4b`; `''` = pictures off, the default). A non-empty id is looked up on the endpoint's image
  model list (`GET <base>/images/models/<id>/endpoints`, free, no picture made): unknown there → `422 { errors: { model } }`;
  the list unreachable → saved anyway with `warning`. → `{ ok, settings: { model }, price: { label: "about $0.015 a picture",
  source: 'list' | 'history' | 'fallback' } | null, warning: string | null }`. Audited as `images.settings`.
- **Who may use it** is a permission, not a setting: the new toolset **`images`** ("Pictures") in the policy forms of
  Admin → People / Groups / Permissions. It resolves to `off` for everyone until the admin sets it for a person, a group or
  everyone; `make_image` is offered only when it is on AND a model is set.
- **Library.** A picture is an ordinary item: `type: 'image'`, `ext: 'png'` (or whatever format the model returned, typed from
  its bytes), `origin: 'made'`, `sourceLabel` "Made by Jess", `description` = the prompt (search covers it), `madeFrom` = the
  Library picture it was made from (when one was given). It arrives over the socket as `library.created`.
- **Usage.** Each picture is one `usage_events` row with purpose `image` ("Pictures" in Admin → Usage) and the cost the
  provider reported (the pre-call estimate when the endpoint reports none), so it shows in the person's budget meter.

## Skills Jess drafts, supporting files, the trigger test (Phase 23, decisions #171–#173)
All additive (admin routes, JSON).
- `GET /admin/skills/:name/review` now also returns `proposal` (null unless Jess drafted it): `{ by: { id, name } | null, at,
  why, tests: [text], nearMisses: [text], runId, current (the folder is still exactly what she proposed; false once the admin
  edited it), thread: { id, href, title, own } | null (href/title only for the admin whose chat it is), versions (proposals
  under this name) }`, `examples` (the skill's `examples:` front matter: `{ positive[], negative[], problems[] }` or null) and
  `triggerQueries: [{ text, expect: 'use'|'skip' }]` (what the trigger test runs by default: the proposal's tests and
  near-misses, else the examples). The `skill` object (also in `GET /admin/skills`) gains `proposed` (drafted by Jess and
  unchanged since). New finding codes: `examples-shape` / `examples-miss` (warn), `examples-count` (info),
  `support-file-long` (warn: a supporting file over 20,000 characters, which use_skill can't open).
- `POST /admin/skills/:name/trigger-test` `{ queries?: [{ text, expect: 'use'|'skip' }] | [text] (≤ 10, ≤ 300 chars each;
  omitted = triggerQueries), runs?: 1–3 (default 3), suggest?: bool, dryRun?: bool }`.
  - `dryRun: true` → `{ skill, status, runs, queries, competing (skills in the block), estimate: { model, calls, promptTokens,
    completionTokens, cost (USD or null when the price is unknown), costLabel, priceSource: 'list'|'history'|null } }`; no model
    call and no rate limit.
  - Otherwise → `{ skill, model, runs, results: [{ text, expect, answers: [skill name | 'none' | 'unclear' | 'error'], hits,
    rate (0–1, share of runs that chose this skill), ok }], summary: { total, passed, failed, errors }, estimate, cost,
    costLabel, suggestion?: { description, why, length, fits (≤ 400) } | null }`. `ok` = most runs chose it (`use`) or didn't
    (`skip`). The suggestion (only with `suggest: true` and a failure) is never applied. Each model call is a `usage_events`
    row with purpose `skill_trigger_test` for the admin; audited as `skill.trigger_test`. `422 { errors }` for a bad request
    (checked before the limit counts it), `429` after 6 runs in 10 minutes per admin, `502` when the model answered none.
- Agent tools: `skill_propose({ name, description, toolsets?, body, tests, near_misses?, why? })` (core, risk write) and
  `use_skill({ name, file? })` (supporting files); see docs/FEATURES.md. Notifications: admins get a `notify` frame
  `{ kind: 'skill', title, body, href: '/admin/skills#<name>', tag }` and an activity line when Jess drafts a skill.

## The browser side of research (Phase 21 part B, decisions #164–#168)
All additive.
- `GET /threads/:id/browser` → `{ open, url, title, site, warnings }`: `site` = the registrable domain of the tab's page,
  `warnings` = what looks wrong about it (`browser/trust.js`: look-alike letters, a bare IP address, a brand's name on
  another domain, a password over http, a redirect through other sites) as short sentences, `[]` when nothing does. Meant
  for the take-over viewer, before the person types into the tab (the warning line on screen is Phase 25).
- `POST /admin/browser/settings` takes `blockAds` (boolean; ad and tracker blocking, default off; left out = unchanged).
  `settings.blockAds` comes back with the rest. Admin → Browser's status gains `adblock: { ready, building, error, blocked }`
  while it is on (`null` when off): the lists are loaded or being fetched, the last failure, requests blocked since start.
- Agent tools (web toolset): `open_search({ site, …fields })` (read; opens a ready-made results address in the chat's tab,
  or reads a data API — see docs/WEB.md), `browser_upload({ ref, library_id, site, element? })` (external: asks first;
  the approval's `reach` is "the website <host>", `undo` "can't be undone"), and `web_screenshot` gains `full_page`,
  `mobile` and `save_pdf` (the PDF becomes a Library item: `origin: downloaded`, arriving as `library.created`).
- `npm run links:check [-- site …]` writes `<data>/deeplinks-state.json`: `{ checkedAt, sites: { <site>: { status:
  ok|broken|blocked|error, at, url, detail, ms } } }`.

## Goals: done-when, step order, measures, a second intake round; why an idea was turned down (Phase 22, decisions #182–#185)
All additive.
- `GET /goals/:id` → `goal` gains: `intakeRound` (1 | 2); `pendingQuestion.round` (2 = "a couple more", the follow-ups the
  first answers raised; Skip still posts to `skipUrl` and keeps the first answers); on each `plan` item `doneWhen` (one
  checkable line or null), `afterIds` ([step id] it waits for), `after` (titles of those not done yet, or null), `blocked`,
  `queued` (switched on, starts by itself when they're done); `measures: [{ id, label, unit, start, target, direction:
  up|down, perWeek, latest, latestAt, progress (0–100 or null), thisWeek, weekLabel ("4 of 3 this week" or null), line,
  points: [{ at, value }] (last 30, oldest first) }]`; `streakDetail: { count, cadence: day|week, label }`. Cards (`GET
  /goals`, and the detail) gain `streak` ("6-day streak" at 2 or more in a row, else null); `nextStep` is now the first step
  whose earlier steps are all done (else the last check-in's suggestion).
- `POST /goals/:id/tasks/:taskId` takes `{ enabled?, after? }`: `after: [step ids]` sets which earlier one-off steps of the
  same goal it waits for (`422 { errors: { after } }` for a loop, itself, another goal's step or a repeating step); with
  only `after`, the switch is left as it is. → `{ ok, task: { id, enabled, status, queued, after: [title] | null, afterIds } }`:
  a step switched on before its earlier steps are done is `queued` and starts by itself when they finish (or when the goal is
  resumed).
- `POST /goals/:id/measures/:measureId/logs` `{ value (number), note? }` → `201 { measure, progress }` (the measure as in the
  detail; the goal's progress %, computed from the measure when it has a start and a target); `422` without a number, `404`
  for another goal's measure. Crossing 25/50/75% for the first time adds one milestone to the timeline.
- `POST /ideas/:id/dismiss` takes `{ reason?: not_for_me | already_doing | not_now, note? (≤ 300 chars) }` → `{ ok, state }`:
  `not_now` snoozes (state `snoozed`, nothing recorded); the other two are kept so nothing like it is suggested again
  (`422 { errors: { reason } }` for an unknown reason). No body = dismissed without a reason, as before. `snooze` and
  `restore` answer `{ ok, state }` too (restore clears the reason). The Ideas page data carries `dismissReasons: [{ value,
  label }]`.
- Agent tool `goal_progress` gains `measure`, `value`, and (to start a new measure) `target`, `start`, `unit`, `per_week`;
  `goals_list` shows each goal's measures, streak, order and done-when, and what they turned down.

## Checks before a reply counts, breakers, the fallback chain, sources and the wish log (Phase 19 part B, decisions #176–#181)
All additive.
- **Runs.** `run` (in message/thread views) gains `sources`: `{ checked (pages read), found (all addresses), sites, newestDays,
  label ("Checked 4 sources · 3 sites · newest 2 days old", or "Only search results (…)"), items: [{ url, host, title, date
  (YYYY-MM-DD or null), kind: read|search }] }`, or `null` when the task used no web sources (the trust chip; Phase 25 draws
  it). `errorKind` gains `paused` on the note posted when a scheduled task was paused after 3 failures in a row. New step
  labels a client may see in `steps`: "Checking what I said I did", "Double-checking the numbers", "Checking every
  requirement", "Checking the links", "Dead end check: trying a different route", "Several steps failed: re-planning",
  "Stopped at this task’s spending limit" (the existing "Not done yet — trying another way" stays).
- `GET /admin/wishes?limit=` (admin) → `{ wishes: [{ id, text, count, person, userId, runId, firstSeen, lastSeen }] }`, the most
  asked first ("Asked for, can't do yet"). `DELETE /admin/wishes/:id` → `{ ok }` (`404` when gone; audited `wish.delete`).
- `GET /admin/balance?refresh=1` (admin) → `{ balance: { balance (USD left: the account's credits and the key's limit, the
  lower), days (at the last 14 days' pace), perDay, label ("Balance $23.67 ≈ 12 days"), warn (under 7 days), gap (a sentence
  when OpenRouter counts this key's week more than 10% apart from what was recorded here, else null), recordedWeek,
  providerWeek, at } | null }` (null until it was read once, or off OpenRouter). Without `refresh` it answers from the cache
  (read every 6 hours by the scheduler and on each visit to Admin → Usage).
- Admin web routes (not `/api/v1`, for the record): `POST /admin/model` takes `fallbacks` (up to 3 model ids, comma or space
  separated) and `background` (a model id or empty); each new one is tested with a tiny call first and `422 { errors: {
  fallbacks | background } }` saves nothing when one doesn't answer. `GET /admin/usage` passes `usage.fallbacks: { count,
  label ("Answered by a fallback 3×"), byModel: [{ model, count }] }` and `balance` (as above). The policy form takes an
  optional `taskBudget` (USD for one task; empty = inherit, 0 = no cap; left out = unchanged); the effective policy has
  `taskBudget` (default min($0.50, a quarter of the weekly budget)) and `taskBudgetSet`.
- `notify` frames: `{ kind: 'message', title: "You’ve used 75% of this week’s budget" | "…90%…" | "This week’s budget is used up",
  href: '/me/usage', tag: 'budget-<week>-<pct>' }` (once per level per week); admins: "Unusual spending today" (`tag:
  'spend-spike-<day>'`, once a day) and "The model keeps failing" (`tag: 'provider-errors'`, after 5 failed calls in a row);
  `{ kind: 'schedule', title: 'Paused “<title>”', href: '/upcoming', tag: 'schedule-paused-<id>' }`.
- `usage_events` rows carry `fallback` (1 when a model of the fallback chain answered) and `model` is now the model that
  answered (it was always the configured one).

## Reminders that follow up until done (Phase 22, decisions #190–#191)
All additive.
- `POST /alarms` takes `followUp` (reminders only): `{ everyMin?: 5–240 (default 15), max?: 1–12 nudges (default 3), until?:
  "HH:MM" (local) | minutes (5–1440), escalateTo?: user id of someone in a group the person shares }`. Out of range →
  `422 { errors: { follow_up | escalate_to } }`. With `escalateTo`, that person is asked once, in their own chat, whether they
  may be told (nothing is shared until they agree).
- `alarm` gains `followUp`: `null` for an ordinary reminder, else `{ everyMin, max, sent (nudges sent this occurrence),
  awaiting (posted, waiting for "done"), untilLabel ("until 21:30" | "for 90 min" | null), escalateTo: { id, name, consent:
  none|pending|granted|declined } | null, escalated, closedHow: card|chat|tool|stop|unconfirmed|early|null }`. While
  `awaiting`, `fireAt` is the next check (the next nudge, or the end of quiet hours).
- `POST /alarms/:id/done` → `{ alarm }`: the reminder's Done (its follow-ups stop; a repeating one moves to its next time;
  before it fired it counts as done early). Harmless on one already closed (returns it as it is; a one-off that ended
  unconfirmed becomes done). `404` for someone else's.
- `GET /alarms/consents` → `{ asked: [consent], mine: [consent] }` with `consent = { id, status: pending|granted|declined,
  askedAt, answeredAt, person: { id, name } }` (`asked`: requests this person was asked, `person` = who asked; `mine`: the
  ones they made, `person` = who was asked).
- `POST /alarms/consents/:id` `{ allow: true|false }` → `{ consent }`: only the person asked can answer (`403` otherwise;
  `422` without a boolean); they can change their answer any time.
- Chat: a reminder's messages are ordinary notes (`run.origin = 'reminder'`); the words are "**Reminder:** …", then nudges
  ("**Still on your list:** …", "**Reminder again:** …", "**Last nudge:** …"), an escalation in the other person's chat
  ("**Alice hasn’t confirmed a reminder:** “…”"), and a consent request ("**Alice asked me something:** …"). `notify` frames:
  `{ kind: 'reminder', title: 'Reminder' | 'Last reminder', tag: 'alarm-<id>' }`, `tag: 'alarm-esc-<id>'` (escalation),
  `tag: 'consent-<id>'` (request).

## The Feed in chat, OPML, muted words, the reading diet (Phase 22, decisions #192–#193)
All additive.
- `GET /feed/stories?topic=&q=&hours=&limit=` → `{ stories: [{ id ("i<itemId>" or a post id), title, source, host, topic, why,
  summary, url (the publisher's link), feedUrl ("/feed?story=<id>"), publishedAt, written }] }`: the ranked feed of the last
  `hours` (default 24; a search `q` looks back 7 days unless set; at most 336), optionally one topic (name or key; `404` with
  their topics listed when unknown), at most `limit` (default 8, max 20). The same stories Jess reads with `feed_stories`.
- `GET /feed?story=<id>` (and the `/feed` page): one story as a card (`mode: 'story'`, `filters.story`); nothing for a story
  this person doesn't follow.
- `POST /feed/opml` `{ opml: "<opml …>" (the file's text, ≤ 900 KB), topic?: "a topic name" }` → `201 { added: [{ title, url,
  topic }], skipped: [{ title, url, reason: duplicate|already|invalid|full|topics|too_many }], topics: [{ key, label, created
  }], message }` (`200` when nothing was added; `422 { errors: { opml } }` for a file that isn't OPML or has no feeds; `429`
  after 10 imports in 10 minutes). Without `topic`, each top-level folder becomes a topic of that name (reused when it
  exists; a new one carries only its feeds, no Google News search) and loose feeds go to a topic named after the list. At most
  10 feeds per topic, 12 topics, 200 feeds per file. New sources are fetched by the next feed check, not during the request.
- `GET /feed/opml` → `text/x-opml` attachment `jessbot-feeds.opml` (OPML 2.0): every topic as a folder with its sources.
- `GET /feed/mutes` → `{ topics: [{ value, at }], sources: [...], words: [...], limits: { words: 100 } }`.
  `POST /feed/mutes` `{ kind: topic|source|word, value }` → `201 { kind, value, muted: true, hidden (their stories now hidden),
  mutes }`; `DELETE /feed/mutes` `{ kind, value }` (any case) → `{ …, muted: false, mutes }`. A word is a word or a short phrase
  (≤ 60 characters, ≤ 5 words; `422 { errors: { value } }`), matched as whole words in a story's title and summary in any
  script (Arabic "و/ال/لل…" prefixes included; "trump" never hides "trumpet").
- `GET /feed/diet?days=30` (7–90) → `{ diet: { days, from, to, enough (5+ stories read), stories, minutes, liked, saved,
  topics: [{ label, count, share (%) }], sources: [{ name, count, share }] (top 10), variety: { topics, sources, score (0–1),
  label: narrow|balanced|varied }, suggestion: { kind: start|unread_topic|one_source|one_topic|explore, text, topic?, source? } } }`.

## Phase 25 part B screens (decisions #194–#196)
All additive.
- Approvals: every approval object (`GET /approvals`, the `approval.created` card, chat messages) gains `facts: [{ key, label,
  value?, items?: [{ title, meta?, href? }] }]` (what the tool lays out beside the text: an email's To, Cc, Subject and each
  attached file, only the requester's own files named and linked; a picture's shape, the photo it works from, the model),
  `provenanceLevel: 'low' | 'high' | null` (`high`: something the task read addressed AI assistants), `previewLong` /
  `previewFoldsCompact` (the card folds the text; it is always complete up to 20,000 characters) and `reachShown` (false when
  a `to` fact already says who it reaches). Tools may declare `approvalFacts(args, ctx)`; the server cleans and caps them.
- Admin → Skills (admin routes, not /api/v1): `GET /admin/skills/:name` is the review page (HTML). `GET /admin/skills` rows gain
  `category` (`research` … `help`, `yours`, `other`), `categoryLabel`, `recommended` (in the core set, `RECOMMENDED` in
  services/skills.js) and `checks: { bad, warn, optional, info }` (an undeclared toolset counts as `optional`, not `warn`).
  `POST /admin/skills/:name/trigger-test` (a real run) is tracked: `GET /admin/skills/:name/trigger-test` → `{ test: null |
  { status: running|done|error, startedAt, finishedAt?, calls, result? (the run's answer), error?, code? } }` (in memory, the
  last per skill); a second run of the same skill while one runs is `409`.

## Background tasks, overnight prep, notes for later (Phase 22, decisions #197–#200)
All additive.
- Runs: `run.origin` gains `delegate` (a background task in its own side chat, started by the `delegate` tool), `delegate_report`
  (the one-line result posted back into the chat it came from: "Done in the background: **title**. <first line of the result>
  [Open the side chat](/chat/<id>)", or "I couldn't finish **title** in the background: …") and `prep` (overnight prep). The run
  view gains `parentRunId` (a background task: the run whose `delegate` call started it). The originating run's `delegate`
  step has `href: /chat/<side chat id>`. `notify` frames: `{ title: 'Done: <title>' | 'Couldn’t finish “<title>”', href:
  /chat/<originating chat>, tag: 'delegate-<run id>' }`; a background task's approvals are ordinary approvals (`GET
  /approvals`, the badge), with the usual "…needs your OK" push.
- The sidebar's side chats (the shell's `sideChats`, `threads.js sideThreads`) gain `background: 'delegate' | 'prep' | null` (for
  the Phase 25 marker; `GET /threads` is unchanged).
- `GET /ideas` → the Ideas page data: `{ items: [idea], categories, dismissReasons, starters, ready: [idea], prep: off|ideas }`;
  `idea` gains `kind` (research|plan|draft|comparison|other|null) and `prepared: null | { itemId, title, type, href:
  /library/<id>, readyAt (when "Ready for you" went out, null until after quiet hours), chatHref (the overnight side chat) }`;
  `ready` = the prepared ones already announced.
- `PUT /me/prep` `{ prep: 'off' | 'ideas' }` → `{ ok, prep }` (`422 { errors: { prep } }` otherwise); `GET /me` → `user.prep`.
- `GET /admin/prep` → `{ prep: { dailyCap } }` (USD per person per night, default 0.05); `PUT /admin/prep` `{ dailyCap: 0–1 }` →
  `{ ok, prep }` (`422 { errors: { dailyCap } }`; 0 turns overnight prep off for everyone); admin only (`403`), audited
  (`settings.prep`).
- `GET /me/notes` → `{ pending: [note], delivered: [note] (last 20) }`, `note = { id, text, priority: low|normal|high, kind:
  note|prep, href, sourceLabel, createdAt, deliveredAt }`. Pending notes ride along with the next check-in and are delivered
  once; "Ready for you" is a `prep` note. `notify` frames: `{ title: 'Ready for you', href: /library/<id>, tag:
  'prep-ready-<idea id>' }` after quiet hours; with check-ins off, one plain message titled "Notes" (`run.origin = 'checkin'`,
  `originLabel: 'Notes'`) and a push.
- Upcoming: a schedule (`GET /schedules`, the Upcoming page) gains `retryAt` / `retryLabel` ("14:05" in the schedule's zone,
  while its last run waits for the one automatic retry: `lastStatus: 'retrying'`) and `threadHref` (the chat its runs post in).
  The Upcoming page data gains `dates: [{ id, text, ymd, day, month, time?, relLabel ("Tomorrow", "Thursday, in 5 days"),
  soon, age?, yearly }]`: remembered dates in the next two weeks (`services/upcoming.js datesSoon`, from the same dated
  memories as the prompt's "Dates soon"). A scheduled task's note in the chat (a run with `scheduleId` and `errorKind:
  'missed'`, or a failed one) offers Run it now: `POST /schedules/:id/run`, as on Upcoming.
- Goals: `POST /goals/:id/measures/:measureId/logs` also returns `html` (the measure's card, `partials/goal-measure.hbs`: the
  latest reading, target, a sparkline from two readings, "4 of 3 this week", progress, the log form), so the page swaps it in
  place. The goal page edits a step's order with `POST /goals/:id/tasks/:taskId { after: [step ids] }` (unchanged API; a
  repeating step can't be waited for, an order that loops is `422 { errors: { after } }`). Ideas: the ✕ asks why and sends
  `POST /ideas/:id/dismiss { reason: not_for_me | already_doing | not_now, note? }` (unchanged API; `not_now` snoozes).
- Library: `POST /library/:id/listen { confirm? }` (owner only): without `confirm` → `{ estimate: { minutes, minutesLabel ("about 6
  minutes"), parts, limit (30), tooLong, overBudget } }` (nothing is spent); with `confirm: true` → `202 { job: { status: recording,
  part, parts, minutesLabel, startedAt } }` (`400` when too long or the week's budget is used up, `409` while it records; pictures
  and audio have nothing to read: `400`). The recording runs in the background (`services/read-aloud.js`, the same service as
  make_audio): `library.listen` frames `{ id, job }` after each part and at the end (`status: done` with `audio: { id, href, title,
  length }` and `partial`, or `failed` with `error`), plus `library.created` for the new audio item (its `madeFrom` is the
  document). `GET /library/:id/listen` → `{ job | null }` (a finished job is kept for 30 minutes). `GET /library/:id/ocr` →
  `{ reading: { startedAt, pages } | null }` while a confirmed reading runs (the viewer after a refresh); a second confirmed
  reading of the same item meanwhile is `409`. Cards (`itemView`) already carry `textSource: 'ocr'`; the viewer page adds
  `madeWith` (a picture's model, size, style, cost from its meta sidecar), `ocrOffer` (scan | picture), `ocrReading`,
  `listenable`, `listen`. Printed pages render as `figure.lib-page` with "Page 1 of 3, as printed".

## Phase 25 screens, part C (decisions #203–#205)
All additive: existing callers get the same answers.
- **Admin → Models** (web routes, admin, JSON with `X-Requested-With: jessbot`): `POST /admin/model/test { model }` → `{ ok, ms,
  model, answered, cost, reply | error, status? }`: one model's tiny test call (a fallback row, the background model), 20 per
  10 minutes; `422 { errors: { model } }` for an id that isn't one. Saving (`POST /admin/model`) still tests every new fallback
  and background model itself. The page data gains `llm.fallbackList`, `llm.onOpenRouter`, `images.checked` (the last save's
  `{ price: { label, source: list|history|fallback } | null, warning, at }`, kept in settings `images.checked` for that model)
  and `images.usage` (30 days: `{ count, cost, costLabel, people, countLabel }`).
- **Admin → Usage:** `GET /admin/usage/balance?refresh=1` (admin) → `{ balance, html, gapHtml }`: OpenRouter read again, then the
  balance card and its gap note rendered from `partials/admin/balance-card.hbs` / `balance-gap.hbs`. `usageOverview()` gains
  `features: { image, ocr }` (`services/usage.js featureTotals()`: a picture is one call, a scan read is one call per batch of
  pages; `countLabel` says which).
- **Admin → System** page data gains `wishes: { list, wishes, asks }` (`services/wishes.js wishSummary()`); removing one is the
  existing `DELETE /api/v1/admin/wishes/:id`. **Admin → Overview** gains `security: { checks: securityChecks(), events:
  securityEvents() }` (`services/security-events.js`: `injection_suspected` and `secret_blocked` audit rows of the last 30 days
  grouped by tool and host/sender or kind, with people, count, last time; metadata only, never an excerpt).
- **Admin → People / Groups / Permissions:** the policy form sends `taskBudget` (#178): `''` inherit, `0` no cap per task.
- **Admin → Personality → Lessons:** the page is `GET /admin/personality/lessons` (`?status=` picks the first filter). Every
  `/admin/lessons` action (`POST`, `PATCH /:id`, `POST /:id/approve|reject|retire|promote`) answers `{ ok, lesson, waiting }` (the
  lesson with `fromName`, `sourceLabel`, `open`, `promoteNeeds`, `retireDays`, `run`) and, with `?fragment=1`, `html` (its card,
  `partials/admin/lesson-card.hbs`).
- **You → Memory:** `GET /me/lessons?fragment=1` → `{ lessons, html }` (the "How I work with you" section,
  `partials/me/lessons.hbs`; lessons with `sourceLabel`). `GET /me/memory-tidies/:id?fragment=1` → `{ tidy, html }` (the tidy
  card, `partials/me/tidy.hbs`). The page (`/me/memory`) opens `?tidy=<id>`, or shows the latest tidy of the last two weeks folded.
- **Feed:** `GET /feed/sources?fragment=1` → `{ topics, limits, counts, html }` (the topic cards, `partials/feed/topic-list.hbs`).
  `POST /feed/opml?fragment=1` adds `html`: the summary (`partials/feed/opml-result.hbs`: added per topic, skipped grouped by
  reason in words). `GET | POST | DELETE /feed/mutes?fragment=1` add `html` (`partials/feed/mutes.hbs`). The Feed's home page
  carries `feed.diet` (the reading diet plus its `month`, when there is enough to say); `/feed?story=` for a story that is gone
  renders an empty state (`feed.mode: 'story'`, no sections).
- **Reminders in the chat:** an assistant message view gains `reminder` (`services/alarms.js reminderCard(run)`): `{ kind:
  'reminder', alarm, level, messageId, latest }` for a follow-up reminder's post, or `{ kind: 'consent', consent: { id, status,
  fromName, answeredAt } }` for a consent request asked of this person; else `null`. The alarm view's `followUp` gains `line`
  ("Nudge 2 of 3 · next at 6:15 PM"), `closed: { how, label, done, at, canMarkDone } | null` and `lastPostId` (the message of
  its newest post). A reminder note is redrawn with its card through `run.refresh` once it is recorded. New WebSocket frame
  `reminder.consent` `{ consent: { id, status, answeredAt } }` when the person asked answers (a tap or in words).
- Admin → Browser (admin routes): the page adds `extras` (`services/browser-admin.js browserExtras`: `blockAds`, `adblockOff: [{ host,
  until }]`, `links: { checkedAt, counts, sites: [{ key, label, area, status: ok|broken|blocked|error|unchecked, statusLabel, at,
  detail }] }` from `npm run links:check`, `recipes: [{ id, host, shape, okCount, failCount, lastOkAt }]`, `office: { available, path,
  source, detail, previews, soffice }`), and the status card shows `status.adblock` and `status.searxng`. `DELETE
  /admin/browser/recipes/:id` (forget a learned results page; `404` when gone), `DELETE /admin/browser/adblock-off/:host` (blocking
  back on for that site), `POST /admin/browser/office { previews, soffice }` (`422 { errors: { soffice } }` when the path isn't a
  file; empty = find it). Each answers `{ ok, html }` (the section re-rendered); audited as `browser.recipe_delete`,
  `browser.adblock_on`, `office.settings`.
- Take-over viewer: shows `site` large with the page title and address under it, and `warnings` on a line above the page.
- Chat: `POST /threads/:id/messages { simpler: true, text?, clientId }` is "Simpler" on a reply: the visible turn is `text`, or
  "Explain that again more simply, with the bit of context I’m missing." when empty, and the server adds a hidden system note
  (plain words, short sentences, no jargon, one example, same language) to the chat right before it; a client can't send that
  note itself. Assistant messages gain `followUps: [question]` (a finished reply ending with the exact line "A few things worth a
  second look:" and only bullets after it: the chips; `html` then renders the body without the list, `markdown` keeps the whole
  text) and `simplerText`. `GET /threads` rows gain `lastNudgeAt` (ISO or null) and `nudgeAllowed` (the main chat allows one
  reply with follow-ups a day; a second within 24 hours is taken out of the reply before it is stored; side chats have no limit).

- You → Connections: "Who looked at my availability" (`services/calendar.js busyLookupsFor`: the person's own
  `calendar.busy_lookup` audit rows of the last 90 days → `[{ at, who, from, to, rangeLabel, blocks }]`, metadata only). Activity:
  "Fair draws" (`services/draws.js drawHistory` → `[{ id, mode, label, iconName, headline, detail, from, count, at, private }]`; a
  private Secret Santa shows no matches). Upcoming: "Dates I remember" (above). All page data, no new API routes.
## The weekly self-review, How I'm doing, What's new (Phase 23 part B, decisions #206–#210)

- `GET /admin/self-review?limit=` (admin) → `{ settings: { enabled }, pending (proposals waiting), reviews: [review] }`, newest
  first. `review = { id, origin: weekly|admin, status: running|done|nothing|error, period: { start, end } (UTC), stats (How I'm
  doing, below), model, note, createdAt, finishedAt, proposals: [proposal] }`; `proposal = { id, reviewId, kind:
  agents_rule|removal|instruction|skill|memory|developer, kindLabel, title, why, change (by kind, docs/DATABASE.md 052),
  evidence: [{ runId, href: /chat/<thread>#run-<id> }] (the admin opens them under the usual rules), target: { id, name } | null,
  status: pending|approved|rejected, reason, result, decidedAt, createdAt }`. Members' words never appear in a proposal.
- `PUT /admin/self-review` `{ enabled }` → `{ ok, settings }` (off by default; audited `settings.self_review`). When on, the review
  runs once a week in the owner's quiet hours, within their budget, when nothing of theirs is running.
- `GET /admin/self-review/summary?days=1–31` (default 7) → `{ summary }`, "How I'm doing" computed now in code: `{ period, runs: {
  total, done, errored, stopped, byOrigin }, pushes: { total, runs, deliveredAfter, byKind: { goal, audit, figures, constraints } },
  thumbs: { up, down }, deadEndChecks, repeatsRefused, checkins: { sent, silent, skipped }, spendUsd, failedSteps,
  declinedApprovals, wishes: { n, asks }, proposedLessons: [{ id, rule, recurrences }] (top 3 household lessons waiting) }`.
- `POST /admin/self-review/run` → `{ ok, review }` (Run now; one background-model call, a few seconds; `409 { errors: { budget } }`
  when the owner's weekly budget is used up; audited `self_review.run`).
- `POST /admin/self-review/proposals/:id/approve` → `{ ok, proposal }` with `result`: AGENTS.md saved through the versioned save
  (note `self-review proposal <id>`; Admin → Personality → History restores), a new version of the person's instructions (`422 {
  errors: { body } }` past the limit), or a drafted skill waiting in Admin → Skills (`422` with skill_propose's field errors);
  memory and developer proposals are noted for the admin. `409` when it was already decided, or when AGENTS.md no longer has the
  line a rewording or removal names. `POST /admin/self-review/proposals/:id/reject` `{ reason? }` → `{ ok, proposal }`. Both
  audited (`self_review.approve` / `self_review.reject`).
- `GET /admin/whats-new?limit=` (admin) → `{ entries: [{ id, release (short commit), subjects: [commit subject], lines: [line],
  status: draft|published|discarded, publishedAt, createdAt }] }` (it first takes in what an update step left in `data/whats-new-pending.json`).
  `PUT /admin/whats-new/:id` `{ lines: [line] | "one per line" }` → `{ ok, entry }` (at most 6 lines, each one clean line without
  an em dash; `422 { errors: { lines } }`). `POST /admin/whats-new/:id/redraft` → `{ ok, entry }` (one background-model call; `409`
  over budget). `POST /admin/whats-new/:id/publish` → `{ ok, entry }` (`422` with no lines, `409` when already published; audited
  `whats_new.publish`). `POST /admin/whats-new/:id/discard` → `{ ok, entry }` (`409` for a published one).
- `GET /whats-new` (everyone) → `{ entries: [{ id, lines, publishedAt }] }`: published notes this person hasn't seen (at most 3,
  newest first; none from before they joined). `POST /whats-new/:id/seen` → `{ ok }` (`404` for one that isn't published).
- The decision model's uses (`GET /admin/decide`) gain `reminder` ("Reminder answers", #209).

## The last screens (Phase 25 part D, decisions #211–#213)

- `POST /messages/:id/feedback` also takes `{ noteFirst: true }` with a thumbs-down: the chat asks "What was off?" first, so the
  thumbs-down is saved now and nothing else happens (`{ ok, lesson: null, chip: null, html: null, waiting: true }`); the
  post-mortem runs when they send their words (`note`) or skip. Every answer carries `html`: the "Noted: …" chip rendered by
  `partials/chat/noted-chip.hbs` (`null` without a chip). `chip` gains `rule`. A chat reply (`GET /threads/:id/messages`, the
  page) carries `noted: { text, rule, lessonId, keep } | null` (services/lessons.js `notedFor`): the chip is there after a reload.
- Every reply in the chat is an anchor, `id="run-<run id>"`: `/chat/<thread>#run-<id>` (the self-review's evidence links, a
  background task's "started from") opens at it and marks it; one further back than the page shows says so.
- A run's steps gain `tool` (the delegate step's link to its side chat stays visible when the steps are folded); a run gains
  `schedulePaused` (`true`/`false` on a "paused after 3 failures" note: is that task still paused; `null` otherwise). Upcoming's
  schedules gain `failStreak` and `pausedByFailures`. Resume from the note is `POST /schedules/:id/resume` (unchanged).
- A background task's side chat (the page only): `background` = `{ kind: 'delegate', title, brief, skill, startedAt, status, from:
  { href: /chat/<thread>#run-<id>, label } | null }` or `{ kind: 'prep', title, startedAt, status, idea: { title, why } | null,
  item: { title, href } | null }` (agent/tools/delegate.js `backgroundOf`; the brief is read back from the run's trigger with
  `briefOf`, the one format `delegateTrigger` writes).
- `PUT /me/prep` also returns `view` (services/prep.js `prepView`): `{ value, capLabel, quiet ("22:00 to 07:30"), stopped (what
  would keep it from ever running, in their words, or null: the admin switched it off, web or goals not allowed, the Library on
  Ask, the budget), last: { title, ideaTitle, href, at } | null }`. You → Notifications shows it with `GET /me/notes`' lists.
- The main chat page carries `whatsNew` (the person's unseen published notes, as `GET /whats-new`); "Got it" is `POST
  /whats-new/:id/seen` for each.
- `GET /admin/self-review/summary` adds `days` and `spendLabel` (agent/self-review.js `summaryFor`). A proposal adds `preview`: `{
  where ("AGENTS.md, under “How I answer”", "Maya’s instructions, added at the end"…), lines: [{ mark: add|del|same, text }],
  note?, skill?: { name, description, tests } }`; its evidence adds `label` (what the task was, never their words), `person`
  (first name) and `at`.
- The Admin → System page's parts re-render from the web routes (admin only): `GET /admin/system/self-review` → `{ running,
  pending, html }` (a review still `running` 15 minutes after it started shows as cut off), `GET /admin/system/summary?days=`
  → `{ days, html }`, `GET /admin/system/whats-new` → `{ html }`.
- `POST /goals/:id/measures` `{ label, unit?, start?, target?, per_week? }` → `201 { measure, html }` (the new number's card);
  `422 { errors: { measure } }` for a missing name, neither a target nor a number per week, the same start and target, or a name
  the goal already counts.
- The Library page takes `?type=` (a chip key: html, doc, pdf, image, sheet, audio; or an item type: md opens Documents, slides
  Office); the page keeps it in the address. Its search asks `GET /library?query=` (above) after the title match.
- make_image's approval card gains a `price` fact ("about $0.015 a picture") when Admin → Models has worked one out.
