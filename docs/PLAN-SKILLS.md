# The skills review plan (Phases 18–25), approved by the owner 2026-09-26

Screen work follows docs/DESIGN.md (Harbor palette, no em-dashes in UI copy). Inputs: 5 repos reviewed (≈5,100 entries; reports in …\c6958e54-…\scratchpad\skills-review\), merged in
`consolidated-inventory.md` (this folder). Every "today" claim below was re-checked against HEAD 751112c by a
verification pass (8 confirmed, 3 partly, memory mostly confirmed; one new bug found).

## Owner answers (2026-09-26)
- Skills: write all; propose a core set (~25) on; the rest wait in Admin → Skills.
- Opt-in features: **make_image only** (prayer times, kid-safe profiles, Home Assistant: not now).
- Extras: model fallback chain, overnight prep, delegate to background, SearXNG — all yes.
- SearXNG: support a URL in Admin → Browser + install a local instance in tools/ (venv, 127.0.0.1).
- Heavy extras: OCR for scanned PDFs (opt-in per file), real office previews when LibreOffice is present, OpenWeb
  evaluation (trial + go/no-go report). Spotify: no.
- #83 changes: a scheduled task may end with ONE question.
- Lessons: personal lessons on at once (visible/removable); household lessons need the owner's OK.
- UI: back-end first, all screen work in the last phase (the redesign, #116, has landed).

## Ground rules for every phase
- Inspect the exact code first; one file at a time; small commits of **my hunks only** (git diff -U0 → keep by content →
  git apply --cached --unidiff-zero) whenever another session edits the tree at the same time.
- New migrations 029+ (never edit applied ones); decisions #117+ in docs/DECISIONS.md and in config/code.
- Checks before each commit: npm test, ui:check + ui:flows (dev :3738), test:e2e, test:chat for agent changes.
- Each phase ends: docs updated (ARCHITECTURE row, FEATURES, SECURITY/JEV/API/CONTEXT-AND-MEMORY as touched),
  committed, and the day-to-day server restarted (by its PID) after checking no run is active.
- Live AGENTS.md/SOUL.md changes go through the versioned save (as in #113); templates updated too.
- Per standing rule: once approved, build all phases through and report at the end.

## Phase 18 — Safety (server side)
1. Browser downloads land in the Library (Session.saveDownload → upload path; honest wording; per-session caps).
2. `src/lib/untrusted.js`: strip invisible/bidi/tag characters (keep ZWJ/ZWNJ); unforgeable fences (random boundary,
   inner tags neutralised); used by web_read, web_search snippets, browser snapshots, email_list/read, library/file
   blocks, project files, and calendar titles/locations in the "Coming up" block (capped, one line).
3. Hidden-text pruning: computed-style pass in the page before web_read extraction (tiny font, opacity, off-screen,
   clip, same colour as background; keep display:none content); same rules on HTML email (inline styles, mso-hide).
4. Fix memory.js stripping ZWJ/ZWNJ (breaks emoji + Persian).
5. Injection detector (`src/agent/injection.js`): multilingual stage-1 patterns + hidden-text signal → Jev confirm
   (new decide() use) → warning banner inside the fence, run marked tainted, metadata-only audit event.
6. Taint-aware approvals (`src/agent/taint.js`): after a run read outside content, "always allow" no longer covers
   external/spend tools, and persistent writes (schedule_task, reminders, remember, goal_suggest, cancel_schedule) ask;
   the approval stores a provenance line ("Suggested after reading: email from …").
7. Compaction flush: memory candidates only from what the person said (prompt rule + word-overlap backstop).
8. Outbound DLP + exfil-URL guard (`src/lib/dlp.js`): registered secrets and secret shapes blocked/flagged in outbound
   args; data-carrying URLs to exfil hosts raised to "ask"; log redaction of registered values. Approval previews carry
   the full text (email up to 20k chars, calendar descriptions) plus "can/can't be undone · reaches …" data.
9. Secrets never become memories (Luhn cards, key shapes, "password/PIN/code is …") — kind refusal.
10. Unknown-outcome guard: recover `waiting` runs whose approved call has no result ("outcome unknown — check before
    repeating"); same wording for interrupted non-read calls; #114 widened to earlier runs of the same trigger message.
11. New bug: a new message while an approval is pending closes the run but leaves the card pending ("Approved" does
    nothing) → expire/close the approval with the run; waiting runs no longer block check-ins/extraction forever.
12. Saved sign-ins (browser profiles) sealed with lib/secrets.js.
13. Skill review assistant (server side): `src/services/skill-lint.js` (invisible chars, override language, URLs/exfil
    hosts, shell, credential asks, persistence, capability mismatch, size); broken skills reported with reasons instead
    of vanishing; unknown toolsets / long descriptions rejected, not cut; checksum covers the whole skill folder
    (existing approvals migrated once); approved body stored for a "changed since you approved" diff.
14. Doctor security checks (allowPrivate on, always-allow grants on external/spend, missing secret, lint-bad active
    skills, injection events, spend spike).
15. Off-the-record threads (server side): no extraction/episodes; remember asks first.
Tests: unit tests for fences, pruning, DLP, taint decisions, recovery paths; test:chat pressure cases (injected email,
"just send it", "tell me it's booked").

## Phase 19 — Runs that finish, and tell the truth
1. Unattended reliability: one retry after a transient failure (schedule/goal), push on final failure, "skipped" kept
   distinct with "I was offline and missed X [Run now]", restart recovery re-queues runs that changed nothing yet;
   fireSchedule stops marking "ok" at creation.
2. Watchers: `schedules.notify always|changes`, memo state, fail_streak, ends_at; NOTE line; silent finish; no goal
   gate; optional code-only change check (hash of the page's readable text) before any model call; ≥2 h interval, cap
   per person.
3. #83 change: scheduled tasks may end with one question (last step only; expires on next run or new message).
4. Reply audit: "done" claims checked against successful tool calls; capability denials; promises without a reminder
   or scheduled task → one push with a specific nudge.
5. Dead-end detector + "the task you're on" anchor in the tail (long runs) + failed-steps list in the push nudge +
   checkpoint every 15 steps.
6. Requirement + figure check: goal gate asks whether every explicit requirement is met; money/times/dates in the
   reply are matched in code against this run's tool results, Jev only for the leftovers; one push.
7. Breakers: per-task spend cap (asks to continue when attended), repeated-read breaker, error-streak re-plan,
   budget alerts 75/90/100 %, daily spike alert to admin, schedule paused after 3 failures.
8. Model fallback chain (OpenRouter `models`, admin-picked, validated) + usage records the model that answered;
   optional background model for JSON jobs; OpenRouter balance in doctor/Usage.
9. Skill routing hint from the per-message sense; reasoning effort per message from the sense.

## Phase 20 — Memory that works as documented
1. Hybrid multilingual recall: memory_vec filled (backfill + on write), BM25 with prefix terms + cosine + RRF (shared
   rrf helper from project search), embed race with BM25 fallback; used by sense candidates and the recall tool.
2. Extraction compares against the nearest facts; write-time near-duplicate merge.
3. Decay by kind/use/importance; pinned/profile/instructions never decay; fix the per-step use-count bump.
4. Dated memories: `remember` takes a date (+ yearly); "Dates soon" block; check-ins see dated items; yearly repeat for
   reminders.
5. Episodes (from the same extraction call) + date-scoped search_history ("what did we talk about last Tuesday").
6. Lessons: corrections, thumbs-down (optional "what was off?"), pushed-then-delivered tasks → short lessons; personal
   ones active at once, household ones proposed; per-site notes shown when Jess opens that site; promotion to AGENTS.md
   by the owner.
7. Weekly memory tidy (clusters, stale events, archive with undo).
8. Facts name people with their relation (prompt rule); memory/contact import (.vcf, other-assistant export).
9. Docs truth pass: CONTEXT-AND-MEMORY.md and #27 describe what is built.

## Phase 21 — Research and the web
1. web_read site readers: PDFs (pdfText, ≤25 MB, "scanned" said honestly), RSS/Atom/OPML rendered, YouTube
   transcripts, X posts (fxtwitter), Reddit threads (.json).
2. Escalation ladder: shared wall detection, wait for self-solving checks, one retry with the person's profile, honest
   BLOCKED + host cooldown.
3. Search by intent: freshness filters per engine, news via Google News RSS (language/country, fix en-US), Wikipedia
   for reference + last-resort fallback, cross-check mode, URL normalisation, 10-min cache.
4. **SearXNG**: engine support (admin URL, JSON API, direct connection like #77 — new decision amending #15/#23) + a
   local instance in tools/searxng (venv, 127.0.0.1, start script, gitignored).
5. Sources per run: links in the reply checked against what was read; code-built Sources section in reports; quote
   check; trust-chip data.
6. open_search deep-link builder (flights, stays, maps, shops, jobs, events, parcels, scholarly) + `npm run
   links:check`; learned site recipes (parameter names only).
7. Browser: browser_upload (own Library files, always asks), full-page/mobile screenshots and page PDF, autopilot
   domain lock, snapshot trimming by priority, domain trust warnings (tldts), optional ad/tracker blocking inside the
   existing guard (admin switch, off by default).
8. Careful topics outside projects (health/legal/money via the sense → safety lines + authoritative sources).
9. **OpenWeb evaluation**: trial on read-only ops (Google Flights, Booking, Amazon) vs our browser; go/no-go report
   with speed/cost/licence/maintenance; nothing adopted without your OK.

## Phase 22 — Household tools
1. Family Lists (tables, `lists` toolset, API; page comes in Phase 25).
2. Reminders that follow up until done (+ Done, confirm phrase via Jev, optional escalation with consent).
3. Email: save attachments to the Library; attachments on email_send (card lists files); email_organize
   (read/flag/archive/move, asks above N) + unsubscribe link.
4. Library: library_edit (find/replace patches), library_append, library_describe, sheet_append_rows; no
   regeneration over uploaded files.
5. Office quality: spreadsheet error report + cached results + calc-on-load + _xlfn prefixes + input/notes options;
   one theme table for docx/xlsx/pptx/pdf; slides without stripes, layouts (two-column, stats, comparison, quote,
   timeline, chart, image) with a fit check; docx widths/footer/page size/images; make_pdf page breaks + math (temml);
   Library page → PDF/PNG with bundled OFL fonts; visual self-check of pages (console errors, overflow, phone
   screenshot to Jess).
6. PDF forms: field context (page, label, tooltip), Unicode values, pdf_write_text for flat forms, rendered page to
   check placement, PDF thumbnails; **OCR of scanned PDFs** (opt-in per file, page cap, cost shown).
7. **Real office previews** when LibreOffice is installed (capability-detected, sandboxed, timeout).
8. Calendar free slots (busy-only household sharing with consent); .ics file when no calendar is connected.
9. pick_random / roll (fair draws, teams, Secret Santa with private reveal in each person's thread).
10. Feed in chat (feed_stories, feed_follow), OPML import/export, muted words.
11. Weather by day/hour, UV, history; public holidays tool.
12. .srt/.vtt uploads; long read-aloud (make_audio); images downscaled before the model; cache_control for
    anthropic/* models; pronunciation of names.
13. **make_image** (OpenRouter image model, off by default, per-person toggle, budget-metered).
14. **delegate** (background side chat with a self-contained brief; ≤2 per person; result posted back) + compaction
    marks what was confirmed vs claimed.
15. Goals: done_when per step, step order (after/frontier), measures + streaks + milestones, a second intake round,
    reasons when an idea is dismissed.
16. **Overnight prep** (opt-in per person, daily cap): one Idea prepared in quiet hours → "Ready for you".

## Phase 23 — Prompts and self-improvement
1. AGENTS.md/SOUL.md pass (versioned save to live): ask in rounds, look facts up first; read back before acting on a
   worked-out plan; excuses table + report-back shape; reply size; how I write (incl. Arabic tells); follow-up
   questions after consequential answers; cool-off for angry sends; look before "I don't know"; never claim done
   without a successful step; a promise needs a reminder.
2. Tool-description hygiene: contracts in tools, steering in skills (library_create design text → make-a-page).
3. skill_propose (lands in review, guarded against outside content) + use_skill opens supporting files + trigger test
   + usage counts.
4. Weekly self-review → at most 3 proposals for the owner (incl. removals); wish log ("asked for, can't do yet");
   weekly "How I'm doing".
5. Dev: agent-eval script, skill routing unit tests, test:chat pressure cases.

## Phase 24 — Skills (≈60 new + 4 upgraded; each with Done-when; own words; Sources line; licences honoured)
Proposed core set on (~25): research-report↑, inbox-triage↑, trip-planner↑, weekly-review↑, scam-check, fact-check,
medicine-info, read-long-document, bills-and-receipts, household-budget, meal-planner, grocery-order,
morning-briefing, plan-my-day, birthdays-and-people, appointment-prep, meeting-notes, write-with-me, polish-writing,
decision-stress-test, buying-guide, price-watch, troubleshoot, homework-helper, school-helper, bedtime-story.
Waiting for you in Admin → Skills: decide, idea-shaper, big-decision-map, draft-feedback, difficult-conversation,
academic-writing, family-update, social-post, questions-for-someone, cv-and-cover-letter, job-search, learn-with-me,
worksheet-maker, learn-this, story-game, what-if-page, mind-map-page, get-unstuck, habit-coach, life-planner,
automate-my-routines, get-to-know-me, time-capsule, chore-quest, expense-log, spreadsheet-analysis, document-compare,
document-expiry, switch-provider, shop-and-return, second-hand-search, gift-finder, family-cookbook, book-something,
trip-organizer, flight-deals, parcel-tracking, places-and-directions, public-transport, home-upkeep, walk-me-through,
fill-a-form, daily-log, training-plan, baby-log, calm-and-breathe, calm-requests, digital-safety-checkup, find-a-time,
email-to-calendar, knowledge-notes, save-page, watch-topic, media-tracker, where-to-watch, events-finder,
kids-activities, home-search, family-history, translate-a-document, book-or-memoir, make-a-page, printables,
generative-art, daily-devotion, sourdough-starter, fair-draw, skill-writer.
Dropped by your answers: prayer-times, music-picks.

## Phase 25 — Screens (on the finished redesign, #116)
Lists page; Admin → Skills (warnings, diff since approval, usage, trigger test, "drafted by Jess"); approval card
(undo/reach line, provenance, attachments, DLP flags, full text); reply "Simpler" + follow-up chips; Upcoming
"Watching"; You → Memory "How I work with you" + Admin lessons; off-the-record toggle; Signed-in sites; sources trust
chip; goal page (done-when, order, streaks, sparkline); idea dismiss reasons; Feed muted words + OPML; Admin → Models
fallbacks + background model; Admin → Browser SearXNG; per-person toggles (make_image, overnight prep); delegate
side-chat link; weekly self-review proposals; wish log.

## Not doing (and why)
Prayer times, kid-safe profiles, Home Assistant, Spotify (your answers); HMAC audit chains / remote policy planes /
third-party scanners (off-box); XP leaderboards (family comparison); regex "humanizers" (damage text, miss Arabic);
Excel upsert-by-key (fights versioned documents); anything flagged unsafe in the reports.

## Housekeeping
Delete the proprietary anthropics docx/pdf/pptx/xlsx folders (and Composio's copy) from skills-src when done.
