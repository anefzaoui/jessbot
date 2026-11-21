# Jessbot — Feature Checklist

Single source of truth for *what* Jessbot must do. Every item is traced to its source:

- **[T1]** the public video "Meta Muse is an INCREDIBLE AI agent" (a review of Meta's Muse)
- **[T2]** the public video "Take the full tour of Muse, Meta's personal AI agent" (Meta's own tour)
- **[U]** owner requirement from the planning conversation
- **[R]** adopted from research (OpenClaw / Hermes / Muse UX reviews) — see DECISIONS.md

Tick items only when they work end to end. `Phase` refers to the build plan in ARCHITECTURE.md.

## Chat — "one god thread"
- [x] One main thread per user, messaging-app feel; the agent is visible at the top (avatar + name) [T2][T1] — P3
- [x] Side chats as exceptions to the main thread (create, rename, delete) [T1] — P3
- [x] **On the home screen**: a web app manifest (the assistant's name, the logo or its look's portrait), so Jessbot installs on a phone's home screen or as a desktop app where the browser allows it (HTTPS or localhost) [U] — #55 (decision #253)
- [x] **Off the record** side chats: nothing from them becomes a memory; `remember` only on an explicit ask [U] — P18 server side (#123); the switch in a side chat's header (and its menu on phones) with a chip while it's on — P25 (#175)
- [~] Talk about anything *and* delegate tasks (buy tickets, plan a family weekend, bookings) [T2][T1] — P3/P5 (research, compare, plan, build pages, schedule; paying/booking stays with the person — spend actions always ask)
- [x] **Delegate to the background**: "research this in the background" → Jess starts it in its own side chat ("Working on: …", its own browser tab, the same approvals and spending limits, its own Stop) so the chat stays free, and posts a one-line result with a link back when it's done (plus a notification); at most 2 at once per person; never started after a page or email tried to instruct her [R] — P22 server side (#197); the link to the side chat stays visible on the reply, the post-back has its badge, the side chat opens with what it was asked (folded) and a link back to where it started, and the rail marks it — P25 (#212)
- [x] Live **status display** at the top: tap → what it's doing, has done, will do [T2] — P3/P4/P7
- [x] **Named activities always visible**: resting / searching / reading / editing / writing / creating… with target + elapsed, on avatar, strip, panel, tab title [U] — P1 (UI) / P3 (events)
- [x] Permissions requested inline in chat *and* grantable from the status/approvals view [T2] — P4; the approval card says what
  will happen, who it reaches (an email's To and each attached file), whether it can be undone and why it asks (a page that tried
  to steer AI assistants said plainly), the exact text folded when long, a stamp for every state — P25 (#194)
- [x] **Simpler and follow-up questions** [R]: "Simpler" on a reply asks for it again in plain words (the instruction is added
  server side); a reply ending with "A few things worth a second look:" shows those questions as chips that ask them; the main
  chat keeps at most one such nudge a day, enforced in code — P25 (#196)
- [x] Very fast, streaming replies [T1] — P3
- [x] **Refresh-proof live state**: thinking/tool steps/partial text survive reload; client resumes stream from last seq [U] — P3
- [x] Every action gives feedback: optimistic UI, pending/success/error, retry, cancel, elapsed timers [U] — P1/P3
- [x] **Visual questions** (`ask_user`): radio / checkbox / yes-no / text, docked above the composer, persisted, re-openable from history [U] — P1 (UI) / P3 (tool)
- [x] Tool steps collapsed ("Worked 42s · 5 steps"), expandable lineage [R] — P4
- [x] **Voice** [T1][U] — P14 (docs/VOICE.md, decisions #99–#100): record voice notes in the composer (she transcribes and answers);
  she answers by voice when you send a voice note, when you ask ("send me a voice note", "say it", "tell me verbally") and when
  you press Listen; her voice matches her look and personality (Admin → Models: voice, delivery, "Hear her", models)
- [x] File uploads in chat (images, PDFs, docs) → readable by the agent, saved to Library [U] — P10 (decision #76: text + vision, RTL-correct PDF text)

## Always working in the background
- [x] Agent has its own browser/computer and keeps working when the app is closed [T2][T1] — P3/P5 (server-side runs + its own headless browser + scheduler)
- [x] Runs are server-side jobs; clients subscribe to live events over **WebSocket** (/ws, heartbeat, resume from last seq) [R][U] — P3
- [x] **Alarms, reminders, timers**: set by chat; ring on web (sound + notification) and later the APK (local alarm + server ping backup) [U] — P7 web done (ringing dock + chime, synced Stop/Snooze, notifications, /api/v1/alarms + devices registry for the APK); push transport P12 (Web Push + UnifiedPush, #85)
- [x] **Reminders that follow up until done** ("keep reminding me until I say done": pills, bins, homework): gentler then firmer
      nudges until "done" (a tap, `reminder_done`, or a reply read in English, French or Arabic), "stop reminding me", or the
      limits (max, until, a day, the next occurrence); never in quiet hours; repeating ones start clean; an optional heads-up to a
      household member who agreed, in their own chat [R] — P22 (#190–#191); the reminder card in the chat (Done, "Nudge 2 of 3 · next
      at …", how it ended) and the consent card (Yes / No) P25 (#205)
- [x] Proactive: thinks of things to do and does them (e.g. builds artifacts unasked) [T1] — P6/P8 (unasked Library items, daily reflection → Ideas + suggested goals, goal check-ins)
- [x] **Time-aware**: knows date/day/time per person (timezone, part of day, weekday/weekend), quiet hours [U] — P3
- [x] **Highly proactive**: suggests next steps, flags issues, offers solutions unprompted; per-user heartbeat [U] — P3/P7 (check-ins off/light/normal, silent when nothing is useful, quiet hours + budget respected)
- [x] **Notes for later**: a task running on its own (a scheduled task, a background task, overnight prep) leaves a short note for your next check-in instead of messaging you at night; each note is delivered once (with check-ins off: one plain message after quiet hours) [R] — P22 (#200)
- [x] **Location + weather aware**: knows where each person lives; watches weather; proactive warnings ("rain at 5, take a jacket") [U] — P7 (set_location/get_weather, You → Where you live + GPS, weather in every prompt, once-per-event heads-ups)
- [x] **Living avatar scene**: transparent portrait over time-of-day × weather backgrounds (24) + CSS weather effects [U] — P1b + P7 (real weather + real sunrise/sunset of the person’s home, live updates)
- [x] **Schedule-aware**: learns everyone's routines/events; knows what is happening now for each person (scoped) [U] — P3 memory + Upcoming, P10 calendar sync
- [~] **Runs that finish and tell the truth**: a restart never leaves a task stuck or redoes a send ("outcome unknown, check
  first"); Retry never repeats what went out; a new message closes a pending OK; scheduled tasks record their real outcome,
  get one retry after a hiccup, push on final failure, say when they were missed while offline, and may end with one
  question [R] — P19a server side (#128–#130, #150); Upcoming says how each task's last run went (Run it now on a failed or
  skipped one, "Trying again at 14:05"), and a missed or failed task's note in the chat offers Run it now — P25 (#196)
- [x] **Watches**: "tell me only when the fare drops / the parcel moves / tickets go on sale": a quiet scheduled check that
  remembers what it saw, writes only when the condition is met, speaks up after 3 failed checks, ends on a date, and skips
  the model when the watched page hasn't changed [R] — P19a server side (#148, #149); "Watching · last: … · checked 14:00"
  on Upcoming, with "Couldn't check the last 3 times" — P25 (#196)
- [~] **Replies that are checked before they count**: a "done" no step backs, "I can't browse" while she can, "I'll let
  you know" with nothing scheduled, a missed requirement (date, headcount, class, budget…), a price or time that isn't in
  anything she read, or a link she never opened each send her back once (a visible step); unseen links are taken out;
  a Markdown report written from web pages gets a Sources section built in code; each run keeps its sources for the
  trust chip ("Checked 4 sources · 3 sites · newest 2 days old") [R] — P19b (#176, #177, #180); the chip under a finished reply, with the pages behind it — P25 (#212)
- [~] **Long tasks that don't go round in circles**: dead-end checks (≤ 2), one re-plan after an error streak, a
  checkpoint every 15 steps, "The task you're on" and what already failed kept in view, the same read never made a
  third time, a spend cap per task (asks to continue when someone is waiting) [R] — P19b (#177, #178)
- [~] **Routing per message**: the message sense suggests the skill that fits, how hard to think (reasoning effort, when
  the model takes one) and careful topics outside projects (health, legal, money: safety lines, authoritative sources,
  nothing personal in searches); keywords when the decision model is off [R] — P19b (#177)
- [x] **Wish log**: what people asked for that no tool does, counted when it comes back, for the owner (Admin → System, "Asked
  for, can't do yet", with Remove) [R] — P19b (#181), the screen P25 (#203)

## Right panel (desktop) / avatar sheet (mobile)
- [x] **Activity** feed — everything done, grouped day by day, by time ("I got more done than I thought") [T1] — P4
- [x] **Approvals** — pending permission requests with badge counts [T1] — P4
- [x] **Upcoming** — scheduled tasks / cron jobs [T1] — P7 (7-day strip, alarms, tasks with run/pause, check-ins; live)
- [x] **Identity** — personality + memories: editable but tucked away for power users [T1] — P3/P9 (You → Memory; Admin → Personality)
- [x] **Pictures** — the admin uploads or picks the avatar, the background behind it and the cover (chat header, Feed greeting); uploads are re-saved without their metadata [U] — #7 (Admin → Identity)
- [x] **Quick decisions** — a decision model (Jev) skips needless work, reads pages in any language, speeds up browsing (fast steps, the autopilot: a flight search in ~12 s) and ranks the feed by what you asked for [U] — P16 (#106–#111, docs/JEV.md)
- [x] **Markdown editors** — coloured markdown and Edit / Preview (server-rendered, Ctrl+Shift+P) on SOUL / AGENTS / MEMORY, skills and instructions [U] — P15 (#103)

## Feed
- [x] Content Jessbot finds for you, each post written just for you [T2] — P7c
- [x] Prompt at the top defines what you want, can be very specific and time-based
      ("finance news in the morning, non-fiction book recs in the evening") [T2] — P7
- [x] RSS/news: Jessbot configures subscriptions from the feed prompt; fetcher pulls on schedule; LLM decides what becomes a post [U] — P7c
- [x] Replaces "briefs via cron in chat" — morning/afternoon/tech & AI release briefs live in the feed [T1] — P7c
- [x] Like / less / save / not-interested (topic) / fewer-from (source) with Undo; taste feeds the next pick — P7c
- [~] **The Feed in chat**: "what's new in my feed?", a morning brief or "anything about the strike?" read the person's own
      ranked stories (`feed_stories`, with the source, why it's there, the link and a link to it on the Feed); "add this blog to
      my feed" (`feed_follow`) and "hide football" (`feed_mute`) work from chat [R] — P22 (#192); the story opens on `/feed?story=`
- [x] **Bring your feeds (OPML)**: import a feed reader's list (folders become topics, duplicates skipped, a report of what was
      added) and export yours; **muted words** (whole words in any language, Arabic included) next to topic and source mutes;
      **your reading diet** (topics and sources you actually read this month, how varied, one suggestion) [R] — P22 server side
      and API (#193); the Sources page (import with a summary, export, muted words), the monthly diet card and the gone-story
      state P25 (#204)

## Ideas
- [x] Proactive suggestions derived from your conversations
      (e.g. "lower back recovery regimen", "kindergarten coordination", "permit applications") [T2] — P8
- [x] Fights "blank canvas syndrome" — starter ideas for new users [T1] — P8
- [x] **Why an idea was turned down**: "Not for me" / "Already doing it" (+ your words) are remembered and nothing like it is suggested again (ideas and goal suggestions); "Not now" just snoozes it [R] — P22 server side (#185); ✕ on an idea asks why with the reasons as chips, Undo as before — P25 (#196)
- [x] **Overnight prep (opt-in)**: while you sleep, Jess prepares ONE of your research, plan, draft or comparison ideas as a Library draft (web reads and one document only, nothing sent or booked, a small nightly cap set by the admin, never while something else runs or the week's budget is low, never a dismissed or snoozed idea) and says "Ready for you" in the morning; the morning check-in mentions it [R] — P22 server side (#199); the switch on You → Notifications (it says what would stop it), "Ready for you" on Ideas, notes for your next check-in, the nightly cap on Admin → Usage — P25 (#212)

## Goals
- [x] Goals appear from conversation as Jessbot learns what you care about [T2] — P8 (reflection + goal_suggest → "I noticed you care about…")
- [x] Click a goal → multi-choice questions that coax a brain dump [T1] — P8
- [x] Reverse prompt: "Here's everything I can do for this goal" → pick → it executes (e.g. LinkedIn carousel) [T1] — P8
- [x] Lightweight status per goal based on background work; tap for detail + full timeline [T2] — P8
- [x] Longer-timeline goals section [T2] — P8
- [x] **Plan steps say when they're done**: each step has a "Done when" line (e.g. "a Library doc with 3 priced options"), sent with the step's run and checked by the goal gate before the reply counts as finished [R] — P22 (#182); on the step card with what it waits for and an order editor — P25 (#196)
- [x] **Steps run in order**: a step can wait for earlier ones ("After: Shortlist venues"); switching it on queues it and it starts by itself when they're done; the next step shown is the first one ready; an order that loops is refused [R] — P22 (#182)
- [x] **Real numbers**: a goal can count something (weight 92 → 84 kg, savings, "3 runs a week"); progress is computed from it, "4 of 3 this week", streaks by day or week (never shamed), milestones at 25/50/75%, and at most one gentle nudge a day after a lapse [R] — P22 server side (#183); a card per number on the goal page (sparkline, this week, Log it) and the streak — P25 (#196); "Track a number" on the goal page and the streak on the goal card — P25 (#212)
- [x] **A second round of questions**: after the first answers, 0–3 follow-ups that only make sense now; skippable [R] — P22 (#184)

## Library
- [x] Everything created lives here: documents, PDFs, markdown, images [T2][T1] — P6/P10/P11 (pages, documents, uploads, Word/Excel/PowerPoint/PDF)
- [x] Rich interactive HTML artifacts (e.g. chess analysis dashboard, "about me" site, use-case site) [T2][T1] — P6 (sandboxed, versioned, live previews)
- [x] Artifacts created proactively without being asked [T1] — P6 (tool instructs it; "Made without being asked" label)
- [x] Office documents: spreadsheets, docs, slides (Univer or better alternative — evaluate first) [U] — P11 (decision #81: real .docx/.xlsx/.pptx made server-side, previews in the Library)
- [x] PDF capabilities (read, create, fill, merge) [U] — P11 (read #76, create #81, fill + merge #82)
- [x] **Spreadsheets right when opened anywhere**: every formula computed as the file is made and its result stored in the cell, Excel recalculates on open, post-2007 functions stored with their `_xlfn.` prefix (checked in Excel), dynamic-array functions refused with a clear message, formula problems (#DIV/0!, #REF!, #NAME?…) reported to Jess by cell so she fixes and remakes; input columns, cell notes, freeze panes, wrap [R] — P22 (#131)
- [x] **One theme table** for Word, Excel, PowerPoint and PDF (11 themes by role, contrast-tested; default "jess" = Harbor) [R] — P22 (#132)
- [x] **Presentations that don't look machine-made**: layouts (bullets, two columns, stats, comparison, quote, timeline, native chart, Library picture, section, closing), dark title/closing slides, no stripes, every text box measured (down to 14 pt, then the slide is refused by name) [R] — P22 (#132)
- [x] **Word polish**: fixed DXA column widths sized to content, Letter/A4 from where the person lives, "Page X of Y" footer, contents list with 3+ sections, Library pictures [R] — P22 (#132)
- [x] **make_pdf**: `\newpage` page breaks, `$…$` / `$$…$$` maths (temml → MathML), bundled OFL fonts (same PDF on any host, Arabic always shaped), themes, pictures [R] — P22 (#133)
- [x] **Their own files are never regenerated**: an id of an uploaded (or downloaded) file makes a new item instead; real in-place edits as new versions: `sheet_set_cells` (cells, ranges, defined names; refuses workbooks with charts, pivots, macros or pictures) and `docx_fill` ({{placeholders}} and phrases across runs, formatting kept) [R] — P22 (#134)
- [x] **PDF forms that work for families**: each field's page, position, printed label, tooltip, max length and checkbox value; answers in any language (bundled Unicode fonts; Arabic left to the viewer while editable, written onto the page when flattened); `pdf_write_text` for flat or scanned forms [R] — P22 (#134)
- [x] **Small changes without resending**: `library_edit` (exact find/replace patches for pages and documents; each find must match once, else the candidates are listed with their line; a new version with a diff summary), `library_append` (a line or table row added to a markdown log, under a heading made if missing, a key such as a date replaces its entry instead of duplicating) and `sheet_append_rows` (rows added to the table in their own .xlsx: above a totals row, whose SUM ranges widen; formulas carried down; styles, notes, merges, validation, conditional formats, names and tables follow) [R] — P22 (#144)
- [x] **Jess looks at the pages she makes**: one render gives the thumbnail plus checks (script errors with their line, blocked or failed loads, width and cut-off text at 390 px, a blank screen); the result says "Checks: …" and the first version (or a failed check) comes with a phone screenshot the model sees; one round of fixes, then stop [R] — P22 (#145)
- [x] **Page → print-ready PDF or PNG**: `library_export` (A4, A5, Letter, square 1080×1080, story 1080×1920, landscape), rendered as the viewer shows it, bundled OFL fonts, saved as a new Library item linked back to its page (the same size again = a new version) [R] — P22 (#146)
- [x] **Searchable names for any file**: `library_describe` sets the title and description of uploads and scans too (search covers both); `PATCH /api/v1/library/:id` takes `description` [R] — P22 (#147)
- [x] **PDF pages as pictures**: every PDF gets a first-page thumbnail in the Library (older ones drawn a few per visit); `pdf_page_image` shows Jess any page (page size in points and the scale, so a spot converts to `pdf_write_text` coordinates); after `pdf_fill_form` / `pdf_write_text` / `make_pdf` she sees page 1 of the new copy; PNG exports of paper sizes at 2× for print [R] — P22 (#161)
- [x] **Office previews as they print, when LibreOffice is installed** (optional, never required): Word, Excel and PowerPoint files printed to PDF in a throwaway locked-down profile (no macros, no links, offline, one at a time, time-limited); first 3 pages as the thumbnail and the Library preview; `make_*` shows Jess page 1; the doctor says whether it was found [R] — P22 (#162)
- [x] **OCR for scans, opt-in per file**: `ocr_document` shows the pages and the estimated cost first (nothing spent), reads only after their yes (never in a scheduled task), at most 20 pages a reading, blank pages skipped, budget-checked; the text becomes the file's text (Library search, `library_read`, project search), marked "text from OCR (may contain errors)"; photos of papers too [R] — P22 (#163)
- [x] **Pictures, opt-in**: `make_image` draws invitations, colouring pages, story art and stickers with an OpenRouter image model on the same key (Admin → Models; empty = off, the default), only for people the admin gives the "Pictures" permission (toolset `images`, off for everyone); cost estimated and checked against the weekly budget before the call, the reported cost recorded ("Pictures" in usage and the budget meter); saved to the Library as "Made by Jess" with the prompt; edits and "a colouring page from this photo" take one of the person's OWN pictures; no likeness of a real person other than the requester unless it's their own photo of people who agreed; model refusals said plainly [R] — P22 (#169, #170); the Pictures card in Admin → Models (on or off, the price and how it was worked out) P25 (#203)
- [x] **Library cards and viewer say what each file is** [R]: where it came from (downloaded from a site, from an email, uploaded), what it was made from, an Add to calendar button on calendar files (card and viewer), a listening card for read-aloud audio, slide previews by layout, a notice on PDFs whose form answers the viewer app must draw, and the title and description edited in place — P25 (#175)

## Connected capabilities
- [x] Web search & page reading — **only** through its own headless browser (open-source Chromium by default, CloakBrowser optional; no curl) [U] — P5, engines #218 (+ screenshots shown in chat, Admin → Browser, setup step)
- [x] **Uses websites like a person**: opens pages, types, picks from autocomplete and calendars, clicks through, reads results; asks with a screenshot when stuck or when the choice is yours; pay/book/send always asks [U] — decision #56
- [x] **Ready-made searches**: `open_search` opens the results of flights (Google Flights, Skyscanner, Kayak, Ryanair), stays (Airbnb, Booking, Google Hotels), maps and directions, nearby places (OpenStreetMap, with distances), shops for the person's country (Senegal → Jumia, amazon.fr), jobs, events, parcel tracking and scholarly search in one step from checked fields (no past dates, children by age, real currencies); `npm run links:check` switches off links that stopped working so Jess uses the form [R] — P21 (#164)
- [x] **Learns a site's results address** after searching it through its form, keeping only the shape (never what was searched), and offers it next time; forgotten after two failures [R] — P21 (#165)
- [x] **Browser extras**: attach one of your Library files to a web form (asks first, naming the file and the site), full-page and phone screenshots, save a page as a PDF in the Library, the autopilot stays on its site (sign-in and payment hand-offs excepted), long pages trimmed by what matters [R] — P21 (#166)
- [x] **Warns about look-alike sites** before you sign in (fake letters, a brand's name on another domain, passwords over http, detours through other sites); warn-only [R] — P21 (#167); the take-over viewer shows the site large and the warnings above the page — P25 (#196)
- [x] **Ad and tracker blocking**, off by default (Admin → Browser), inside the same network guard; off by itself on a site that asks for it [R] — P21 (#168); Admin → Browser shows its state, the sites it's off for (Turn it on now), SearXNG's state, which ready-made search links work and the learned results pages (Forget) — P25 (#195). OpenWeb was trialled and not adopted (docs/OPENWEB-EVALUATION.md)
- [x] **Reads more than articles**: `web_read` handles PDF links (text with page markers; `save: true` keeps the PDF in the Library for form filling), RSS/Atom/JSON feeds and OPML lists, YouTube videos (the transcript from their captions, with times), X posts and Reddit threads; a bot check is waited out and retried once with the person's cookies, then reported honestly as BLOCKED [R] — P21 (#135, #136)
- [x] **Searches by intent**: past day/week/month/year, news in the person's language and country (Google News), reference (Wikipedia, also the last resort when every engine fails), and a cross-check that asks two engines and marks what both found; optional self-hosted SearXNG first when the admin sets it up (`npm run searxng:install`) [R] — P21 (#137, #138)
- [ ] Marketplace/social lookups via the browser (Muse's Instagram/Facebook moat → our open web) [T1] — P5
- [x] Email (IMAP/SMTP) — check mail, draft/send behind approval [U][T1] — P10 (decision #78)
- [x] Calendar (CalDAV) — "when is my next appointment", create events behind approval [U][T1] — P10 (decision #79)
- [x] **Email files and tidying**: `email_save_attachments` (an email's PDFs, images, Office files and text into the Library, typed from their bytes; programs, macro files and archives never kept), `email_send` with up to 5 of their own Library files (20 MB; the card lists each), `email_organize` (read/unread, flag, archive, move; asks above 20 messages or for the bin; nothing ever deleted), `email_unsubscribe_link` (shown, never followed) [R] — P22 (#157)
- [x] **Free time worked out in code**: `calendar_free_slots` (a daily window, days, buffers, all-day and "free" events, clock changes), with household members' busy times only when they turned on "share when I'm busy" (times only, audited) [R] — P22 (#158, #159); the switch is on You → Connections — P25 (#175)
- [x] **Weather by day and hour** (up to 16 days), UV and wind, past weather since 1940; **public holidays** for any country, offline [R] — P22 (#140)
- [x] **Fair draws** (pick, shuffle, teams, pairs, dice) decided by crypto with a draw id; a Secret Santa reveals each match privately in that person's own chat [R] — P22 (#141)
- [x] **Transcripts and read-aloud**: .srt/.vtt meeting or video transcripts upload as clean text; any document or story becomes one audio file in the Library (≤ 30 min), with Listen on documents [R] — P22 (#142), P25 (#196); **names said right**: a phonetic spelling per person her voice uses — P22 (#143), the field on You — P25 (#175)
- [x] **Lighter and cheaper calls**: pictures go to the model as a 1568 px copy (about 7–12× smaller) while the person keeps the original; prompt caching for Anthropic models via OpenRouter (the second call reads ~99 % of the prompt from cache) [R] — P22 (#201, #202)
- [x] **Calendar files without a calendar**: `make_calendar_file` saves one or many events (a trip, fixtures, term dates; time zones) as an .ics in the Library that phones add with one tap [R] — P22 (#160)
- [x] Skills: `skills/<name>/SKILL.md` describing how to use tool groups; admin-reviewed [U][R] — P12 (#84)
- [x] Extensible tool registry (code plugins declaring toolset + risk) [U][R] — P4

## Usage
- [x] Generous, visible usage: per-user budget meter, cost per task [T1][R] — P3/P9 (You → Usage, Admin → Usage)
- [x] Cheapest model that works; model-agnostic (fixes Muse's "no frontier models") [T1][U] — P3 (Admin → Models: any OpenAI-compatible endpoint)
- [x] **Fallback models, a background model, the balance**: up to 3 fallback models answer when the main one is down or busy
  (OpenRouter `models`, each tested when saved; usage records the model that answered, "Answered by a fallback N×"); an
  optional cheaper model for summaries, memory, the feed and goals, retried once on the main model when it fails; the
  OpenRouter balance in the doctor and Admin → Usage ("Balance $X ≈ N days", a warning under a week, a gap with what was
  recorded here); budget alerts at 75/90/100 %; an admin alert on an unusual day or a failing provider; scheduled tasks
  pause after 3 failures [R] — P19b (#178, #179); the Admin screens P25 (#203: fallback rows tested as they are added, the
  background model's test, the balance card with Read it now, the per-task budget field)

## Sign-in (issue #6)
- [x] **Two-step sign-in** with any authenticator app, recovery codes shown once, an app-friendly API step; **change your
  password** (signs out every other device); **reset links** an admin makes and hands over (or `npm run reset-link` on the
  server); stronger password hashing, redone at sign-in; rate limits stored in the database [R] — #230, #228

## Safety (from the skills review, Phase 18)
- [x] **Outside content stays information**: web pages, emails, files, search snippets, browser snapshots and calendar titles reach Jess inside fences a page can't close, with hidden text (tiny, invisible, off-screen, white-on-white) left out; text addressed to AI assistants is flagged inside the fence ("⚠ …, not from them") and she tells the person instead of acting [R] — P18 (#118, #120)
- [x] **Approvals count what the task read**: after an email or a web page, standing "always allow" permissions stop covering sending and spending, and lasting changes (scheduled tasks, repeating reminders, memories, goals, background tasks) ask first; the card says what she read [R] — P18 (#124)
- [x] **Nothing secret leaves**: the app's keys and saved passwords are blocked from any tool call; card numbers and passwords are masked on approval cards; addresses built to catch data always ask; passwords and card numbers are never kept in memory [R] — P18 (#125, #126)
- [x] **Approval cards show the whole thing**: the full message (with its length), attached files, whether it can be undone and who it reaches; offered once, an angry email can wait an hour before it's sent [R] — P18 (#127); the card redesign — P25 (#194)
- [x] **Browser downloads land in the Library** (typed from their bytes, text extracted, "Downloaded from <site>"), and saved sign-ins are sealed with the install key [R] — P18 (#117), P21 (#136)
- [x] **After a restart nothing is repeated blindly**: an approved step cut off mid-way says "outcome unknown, check first", Retry never redoes a send that already happened, and a card left behind by a new message closes instead of lying [R] — P19 (#128–#130)

## Multi-user & admin (Jessbot-specific)
- [x] Owner/admin + members (family, company); each has an account [U] — P2
- [~] Admin sets **per-user instructions** — how Jessbot responds to that person [U] — P2 (UI + storage, versioned) / P3 (applied in prompt)
- [x] Admin sets **per-user tool permissions** (toolsets, approval mode, budget) [U] — P4
- [x] Shared knowledge with explicit scopes; strict per-user isolation by default [U][R] — P3/P4
- [x] `SOUL.md` (persona), `AGENTS.md` (rules), `MEMORY.md` (shared), `users/<id>/USER.md` [U][R] — P3
- [x] Admin control dashboard: users, groups, soul, tools, schedules, approvals, usage, model, browser, logs, system [U] — P2–P9 (System = health check, backups, live log)
- [x] **Skill review assistant**: plain-code warnings on a skill's text (hidden characters, override language, data-catching links, installs, secret asks, capability mismatch, description collisions), broken skills shown with reasons, whole-folder checksum, diff since approval, usage counts, "approve anyway" for serious findings [R] — P18 server side (#121, #122); Admin → Skills finds any skill by words, status, origin and category, switches on the recommended core set in one go (each approved on its own), and each skill has its review page — P25 (#195)
- [~] **Jess drafts skills; the admin approves them**: `skill_propose` writes a draft that waits in Admin → Skills (never active until approved; refused after reading outside content, over a built-in or someone else's skill, with links to open, AI-addressed text, secrets or serious review findings), who asked, the chat, why and the test requests kept for the review, admins notified; `use_skill` opens a skill's supporting .md/.txt files; the admin's **trigger test** (does the description make Jess open it? cost shown first, 3 runs per request, optional better-description suggestion never applied); optional `examples:` front matter checked offline [R] — P23 server side (#171–#173); "Drafted by Jess" and the trigger test on the review page (cost first, a bar per request, a suggested description shown as a proposal) — P25 (#195)
- [x] **Weekly self-review for the owner** (off by default): once a week, in the owner's quiet hours and within budget, the week's
  thumbs-down, pushes, dead-end checks, repeats, declined approvals, failed steps, wishes and lessons become at most 3 proposals
  (a rule for AGENTS.md or its removal, a person's instruction, a skill that still waits for review, a memory fix, a note for the
  developer) with the tasks behind them; approving applies it through the versioned saves; members' words never reach it.
  "How I'm doing": the week in numbers [R] — P23 server side (#208); on Admin → System (Run now, each proposal's change as a small diff and the tasks behind it, Approve / Reject with a reason; How I'm doing over 7 or 30 days) — P25 (#212)
- [x] **What's new in Jess**: each release's commits drafted into 3–6 plain lines, edited and published by the admin, shown once
  per person [R] — P23 server side (#210); the editor on Admin → System and the card above the main chat's composer — P25 (#213)
- [x] First-time setup wizard [U] — P2
- [~] Onboarding customisation: instance name (knows it is a Jessbot, original name Jess), short description, avatar variant, tone → SOUL.md [U] — P2 (done; the portraits too: P1b, #7)
- [x] Context management: per-message/tool-result summaries, compaction, never-out-of-control context; memory tiers (design from research) [U] — P3
  (the summary's open tasks say done-and-confirmed, only claimed, or still to do: done only when a tool result confirms it — P22, #198)
- [~] **Memory that works as documented**: recall by meaning and in any language (words + vectors, RRF), no near-duplicate
  memories, lasting facts don't fade (decay by kind, use and importance), dated memories (birthdays yearly, appointments)
  that come up by themselves ("Dates soon", check-ins), one-line episodes of past chats, "what did we talk about last
  Tuesday", people named with their relation, import from another assistant or a `.vcf` [U] — P20 part A (#151–#156);
  lessons and the weekly tidy P20 part B (#186–#189). You → Memory shows each memory's date, importance and use,
  pins, the conversations remembered, and Import (paste or a `.vcf` → preview → tick → save) — P25 (#175); "How I work
  with you" (your lessons), the weekly tidy with Undo per change, and Admin → Personality → Lessons (household lessons to
  approve, retire, promote) — P25 (#203, #204); a thumbs-down asks "What was off?" and shows "Noted: …" with Keep / No — P25 (#211)
- [x] **Family lists** (shopping, to-do, wish, packing): `/lists` with every list you can see, shared with a group or just yours; add in plain words ("Milk 1L" parsed, aisles for shopping), tap to tick, who's on it and when it's due, wish lists that never show the wisher what was bought, clear ticked, archive and restore; two people see each other's ticks live [R] — P22 server side (#139), the Lists page P25 (#174)
- [x] Projects & tasks stored in local SQLite [U] — P8 (goals = projects, goal_tasks = their tasks: once → a run, recurring → a schedule)
- [x] **Projects** (owner, 2026-09-25): one continuous chat per project, started by talking (her questions → a New project card),
  a brief that stays current, files never lost to summaries, Main knows every project — P13a (#91). Project soul P13b, deep files P13c.
- [x] JSON API `/api/v1` with bearer tokens for a future Android app [U] — P2 (auth, me, sessions) + each phase; reviewed end to end in P12 (#87, client walkthrough in API.md)
- [x] Portable: Windows PC + Linux VPS, all data in `./data`, binaries in `./tools` [U] — P0

## UI quality bar
- [x] Best-in-class UI: three-pane desktop, bottom tabs on mobile, light + dark [U] — P1
- [x] Animated avatar reflecting agent state (Muse avatar holds a laptop/orb while working) [R] — P1/P1b
- [x] Humanoid avatar (female / male / neutral, picked at setup, in SOUL.md) with 13 emotions + 4 life frames driven by activity [U] — P1b
- [x] Accessible: landmarks, headings, aria-live announcements (Muse's reviewed gaps) [R] — P1
- [x] All client JS/CSS in-house; no CDNs [U] — P1
