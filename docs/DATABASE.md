# Database & safe upgrades

SQLite file: `data/jessbot.sqlite` (built-in `node:sqlite`, WAL mode). Code: `src/db/index.js`.

## How schema changes ship

Every schema or data change is a **new numbered file** in `src/db/migrations/`:

| File | Use |
|---|---|
| `NNN_name.sql` | plain SQL (CREATE/ALTER/INSERT…) |
| `NNN_name.js` | `export async function up({ db, all, get, run, exec })` for data transforms SQL can't express |

On boot, Jessbot applies pending migrations in order. Safeguards (all verified by test):

1. **Backup first** — if anything is pending, the DB is snapshotted to `data/backups/pre-migrate-<time>.sqlite`
   (`VACUUM INTO`) before any change.
2. **All or nothing** — each migration runs in its own transaction. On error it rolls back, the DB is left
   exactly as before, and **the server refuses to start** with a message naming the migration and the backup.
3. **No editing history** — applied migrations are SHA-256 checksummed (line endings normalised). If an applied
   file changes, boot stops: revert it and write a new migration.
4. **No downgrades** — if the DB contains migrations the running code doesn't know (older build on a newer DB),
   boot stops instead of corrupting data.
5. **Table rebuilds** — SQLite can't ALTER everything. For the 12-step rebuild (create new table → copy → drop →
   rename), put `-- jessbot:foreign_keys=off` at the top of the SQL (or `export const foreignKeys = false` in JS).
   FKs are disabled around that migration and `PRAGMA foreign_key_check` must pass before commit.

## Rules for writing migrations

- Never edit or delete a migration once it has been committed — add a new one.
- Prefer additive changes (new tables/columns with defaults); they are always backward-safe.
- Don't use `BEGIN`/`COMMIT` inside a migration — the runner wraps it.
- Number sequentially with three digits: `002_users.sql`, `003_threads.sql`, …

## Commands

```
npm run db:status   # applied / pending / unknown / modified
npm run db:backup   # manual snapshot to data/backups/
```

Restore = stop Jessbot, copy a backup over `data/jessbot.sqlite` (delete the `-wal`/`-shm` files), start.

## Migration notes (Phase 18 onward)

What each newer migration adds, and anything about it that code relies on.

- **029_skill_review_off_record.sql** (decisions #121–#123): `skills.approved_body` (the approved SKILL.md, front matter
  included, for the "changed since you approved it" diff) and `skills.approved_files` (JSON: every file in the skill's
  folder → its SHA-256 at approval). `approved_checksum` now holds the *whole-folder* checksum; rows approved under the
  old SKILL.md-only checksum are re-pinned by `services/skills.js` the first time the skill is read, if SKILL.md is still
  exactly what was approved (no migration-time file reads: the check runs on every read, so a restored older database
  heals the same way). `threads.no_memory` (off the record) and `threads.no_memory_upto` (newest message id written while
  it was off the record, set when it goes back on). Index `messages_tool_name` for skill usage counts.
- **030_run_taint.sql** (decisions #119–#120): `run_taint (run_id → runs ON DELETE CASCADE, level 'low'|'high', tool, label,
  at)`, unique per (run, level, tool, label): what outside content each run read (`low`) and which of it was caught
  addressing AI assistants (`high`). Written by `agent/injection.js` (`guardOutside`, `flagPromptHit`) through
  `agent/taint.js` `markRunTaint`, whose `true` return (first time) gates the one `injection_suspected` audit row per run
  and source; read with `taintOf(runId)` / `isTainted(runId, level)` (approvals). No text is stored, only the source label.
  Tools that read outside content without `guardOutside` (a reopened stored result, an image, a PDF's fields, a project's
  file list) are marked by the loop after they run (`noteToolRead`, generic label, only if that tool has no row yet).
- **032_approval_context.sql** (decisions #124–#127): six nullable columns on `approvals`, written by `createApproval`
  (`services/approvals.js`): `provenance` (the run's taint labels as one line, "Suggested after reading: …"), `ask_reason`
  (the gate's line when it asks where it otherwise wouldn't have, `policy.assess`), `flags` (JSON `[{ kind, label, masked }]`
  from `lib/dlp.js`, never the secret itself), `undoable` (1/0/NULL) + `undo_note`, and `reach`. `preview` now holds the full
  text (capped at 20,000 characters with a "(cut at …)" marker) with secret shapes masked; `args` is unchanged and is what
  runs. Rows from before 032 have NULLs and show none of it.
- **034_household.js** (decisions #139–#143; a `.js` migration with `foreignKeys = false`): `lists (owner_id, scope_id →
  scopes, kind shopping|todo|wish|packing|custom, title, wisher_id, archived_at)`, unique title per scope among live lists;
  `list_items (list_id → lists ON DELETE CASCADE, text, qty, category, assignee_id, due_at, done_at, done_by,
  hidden_from_owner, created_by, source_msg_id, pos)` — one row per item, so changes never overwrite each other;
  `hidden_from_owner = 1` marks a wish someone other than the wisher ticked ("bought"), which `services/lists.js` shows the
  wisher as open. `draws (public_id, user_id, run_id, mode, input JSON, result JSON)` — `result` is NULL for a privately
  revealed Secret Santa, by design. `users.name_say` (how to say my name). The global policy gets `lists: allow` where unset.
  And `library_items.type` gains `'audio'`: SQLite can't alter a CHECK, so the table is rebuilt (create new → copy → drop →
  rename, indexes and triggers re-created) **from its own current definition in `sqlite_master`**, with only the CHECK list
  changed; columns added by earlier migrations are carried over whatever they are, and child tables (project_chunk_state,
  project_chunk_vecs) keep pointing at `library_items`. `PRAGMA foreign_key_check` must pass before it commits.
- **035_library_source_item.sql** (decision #146): `library_items.source_item_id` (→ `library_items(id)` ON DELETE SET
  NULL; partial index where set): the item another was made from. Today: the PDF or PNG `library_export` printed from an
  HTML page points back at that page (`itemView().madeFrom` = `{ id, title, href }` while the page exists), and a new export
  of the same page with the same extension and title (size/orientation) becomes a new version of that export (`exportOf`).
  No other code path sets it.
- **036_runs_finish.sql** (decisions #128–#130, #148–#150): runs that finish and tell the truth.
  - `approvals.executing_at` (set by the loop right before an approved call runs: a restart after it is an "outcome
    unknown", `recoverRuns`), `approvals.closed_reason` for `status = 'expired'`: `timeout` (the 24 h TTL), `moved_on` (a new
    message closed its run), `run_closed` (its run ended: Stop, failure, restart). NULL on older rows = timeout.
  - `runs.schedule_id` (→ schedules ON DELETE SET NULL: the schedule that started it; its outcome is written there when it
    finishes, `recordRunResult`), `runs.watch` (1 = a quiet watch check), `runs.error_kind` (`transient` | `permanent` |
    `interrupted` | `budget` on failed runs; `missed` on the note for a task missed while offline), `runs.retry_at` (UTC ISO:
    the one automatic retry of a schedule/goal run after a transient failure is due; cleared when it runs; partial index
    `runs_retry`), `runs.retry_of` (→ runs: the failed run a retry replaced, by hand or automatically; a run with it set gets
    no automatic retry), `runs.recovered` (1 = a restart already re-queued it once).
  - `schedules.notify` (`always` | `changes` = a watch, CHECK), `only_when` (the condition in words), `memo` + `memo_at` (the
    last good NOTE line, one clean line ≤ 500 chars), `ends_at` (UTC ISO end of the `until` day), `fail_streak` (failed checks
    in a row), `watch_url` + `watch_hash` (SHA-256 of that page's whitespace-normalised readable text at the last good
    check), `checked_at` + `last_check` (`unchanged` | `noted` | `reported` | `failed` | `missed`). `last_status` is now NULL
    while a fired run is under way (it was set to `ok` at creation) and `ok` | `bad` | `silent` | `skipped` once known.
- **037_memory_dates_episodes.sql** (decisions #151–#156): memory that works as documented.
  - `memories.recurs` (`yearly` | NULL, CHECK): with `event_at` (`YYYY-MM-DD`, `YYYY-MM-DDTHH:MM` in the person's wall-clock
    time, or `MM-DD` for a yearly date whose year isn't known) a memory is about a day; partial index `memories_event` on
    `(scope_id, event_at)`. `importance` (1–3) is now set by extraction and `remember`. `memory_vec` (from 004) is now filled:
    one vector per active fact (model + dims per row), kept only while the text is unchanged; an edit or supersede deletes
    it, a purge cascades.
  - `episodes.from_msg_id`, `episodes.to_msg_id`: the messages an episode (one dated line per extraction pass, private
    scope) covers; deleting a message in that range deletes the episode. Indexes `episodes_scope (scope_id, observed_at)`,
    `episodes_thread (thread_id, from_msg_id, to_msg_id)`.
  - `episode_vec (episode_id PK → episodes ON DELETE CASCADE, model, dims, vec)`: meaning search over episodes, like
    `memory_vec`.
  - `memory_events.op` gains `dedupe` (a near-duplicate write that returned the existing fact; `new_text` = the attempted text).
- **038_busy_sharing.sql** (decisions #158–#159): free time and household busy sharing.
  - `calendar_events.busy` (INTEGER NOT NULL DEFAULT 1): 0 for an occurrence marked free (`TRANSP:TRANSPARENT`) or cancelled
    (`STATUS:CANCELLED`); free-slot finding skips those, every other reader still lists them. Written by each sync (rows from
    before the migration count as busy until the next 15-minute sync rewrites them).
  - `users.share_busy` (INTEGER NOT NULL DEFAULT 0): the person's consent, "Share when I'm busy with my household". Read by
    `services/calendar.js sharedBusyBlocks` (only for people who share a group; busy times only), set by `users.setShareBusy`
    / `POST /api/v1/me/profile { shareBusy }` (audited).
- **039_document_pictures.sql** (decisions #161–#163): seeing documents.
  - `library_items.preview_version` (INTEGER): the version whose pictures were made (a PDF's first-page thumbnail; an office
    file's pages printed by LibreOffice), or tried and failed; NULL = never tried, which is what the lazy backfill
    (`library.js backfillPreviews`, at most 4 per Library view, and the item viewer) looks for. A version that failed is not
    retried; an office file with no LibreOffice around is left NULL so it is drawn once LibreOffice is installed.
  - `library_items.preview_pages` (INTEGER NOT NULL DEFAULT 0): how many page pictures that version has, as files next to
    it: `v<N>.page<k>.jpg` (k ≤ 3), plus `v<N>.render.pdf` (the office file as LibreOffice printed it, for pdf_page_image).
    `thumb.jpg` / `has_thumb` as before; `addFileVersion` now clears `has_thumb` so the old picture never shows a new version.
  - `library_items.ocr_version` (INTEGER): the version whose text sidecar (`v<N>.txt`) was read by OCR; the item counts as
    "text from OCR" while this equals `version` (`isOcrText`). What each reading found (pages, blank pages, model, total
    cost, when) is kept in the version's `v<N>.meta.json` under `ocr`.
- **042_skill_proposals.sql** (decisions #171–#173): skills Jess drafts with `skill_propose`. `skill_proposals (id, name,
  proposer_id → users SET NULL, thread_id → threads SET NULL, run_id → runs SET NULL, why, tests JSON [text], near_misses
  JSON [text], checksum, raw, created_at)`, index `skill_proposals_name (name, id)`. The skill itself is an ordinary folder in
  `data/skills/<name>/` with no `skills` row until an admin approves it (so it is `review`); this table holds what can't sit
  in that folder, because the approval checksum covers every file in it. One row per proposal (Jess updating her own draft
  adds one); `checksum` is the folder checksum right after writing, so the newest row describes the folder only while they
  match (an admin's edit makes the skill theirs, and Jess can no longer write over it). `raw` = the proposed SKILL.md.
  Deleting the skill deletes its rows. `allSkills()` reads the newest row per name (a database without 042 yet: none).
- **040_site_recipes.sql** (decision #165): `site_recipes (host, path_template, param_names JSON, ok_count, fail_count,
  last_ok_at, created_at)`, unique per (host, path_template, param_names), indexed by host: the SHAPE of a site's results
  address after Jess searched it through its form — slots (`{query}` for what was typed, `{date}`, `{number}`, `{value}`),
  never values; session/tracking parameters and opaque state blobs are dropped before anything is stored
  (`browser/recipes.js recipeFrom`). Household-wide (no user column, by design: only shapes). `learnRecipe` inserts or
  counts again; `noteRecipeUse` counts a success (`fail_count` back to 0) or a failure, and deletes the row at the second
  failure in a row; `recipeHint` reads the best one for a host (most successes). Nothing else reads or writes it.
- **045_goal_steps_measures.sql** (decisions #182–#185): goals that know when a step is done, run in order and count.
  - `goal_tasks.done_when` (TEXT): one checkable line from the plan or a check-in; appended to the step's run as
    "Done when: …" (first in the trigger text, which the goal gate reads) and to a routine's schedule prompt.
  - `goal_tasks.after_ids` (TEXT NOT NULL DEFAULT '[]'): JSON [goal_tasks.id] of the same goal's one-off steps it waits for.
    Written by `services/goals.js addTasks` (plan numbers → ids; links that would loop, point at itself or at a routine are
    dropped) and `setTaskAfter` (the API; refuses the same with a 422). A step switched on while any of them isn't `done`
    stays `enabled = 1, status = 'todo'` (queued) until `agent/goals.js startReady` starts it (a blocker finished in a run or
    via `goal_progress step_done`, or the goal resumed).
  - `goals.intake_round` (INTEGER NOT NULL DEFAULT 1): 2 once the first answers are in; `intake` then holds the 0–3
    follow-up questions (NULL while being written; none → `stage = 'planning'`). Answers from both rounds are in `answers`.
  - `goals.milestone` (INTEGER NOT NULL DEFAULT 0): the highest of 25/50/75 already put on the timeline (`setProgress`).
  - `goals.lapse_hint_at` (TEXT, UTC ISO): when the last gentle nudge after a lapse went out. At most one a day per person
    (the newest across their goals) and one per lapse (none again until something newer is logged).
  - `goal_measures (id, goal_id → goals CASCADE, label, unit, start REAL, target REAL, direction up|down, per_week 1–21,
    created_at)`: a level to move from start to target and/or a rhythm. Labels are unique per goal (any case). A level measure
    with no start takes its first reading as the start.
  - `goal_logs (id, measure_id → goal_measures CASCADE, value REAL NOT NULL, at, note, run_id → runs SET NULL)`, indexed by
    (measure_id, at): each reading or session. Progress = (latest − start) / (target − start), clamped to 0–100; streaks
    (`streakOf`) count days or weeks (their timezone, Monday first) with a reply/action/artifact event or a log.
  - `ideas.dismiss_reason` (TEXT, NULL | not_for_me | already_doing) and `ideas.dismiss_note` (TEXT ≤ 300): why an idea was
    turned down. "Not now" is a snooze and is never stored here; restoring an idea clears both. `ideas.turnedDown` feeds the
    reflection prompt and the chat prompt's goals block ("TURNED DOWN (with why)").
- **044_run_checks.sql** (decisions #176–#181): replies checked before they count, breakers, the fallback chain, sources, wishes.
  - `runs.sources` (TEXT, JSON): what the task found in web search results and the pages it read — `[{ url (normal form,
    browser/read.js normalizeUrl), link (as seen), host, title, kind: search|read, date (YYYY-MM-DD or null), at }]`, ≤ 80 (search
    hits make room first). Written by `services/sources.js noteSources` after each successful web_search / web_read /
    browser_read / browser_open / open_search call (and an approved one); read by the citation check (with every address in
    the chat's tool results and the person's messages), the code-built Sources section of a Markdown document, and the run
    view's `sources` (the trust chip).
  - `usage_events.fallback` (INTEGER NOT NULL DEFAULT 0): 1 when a model of the fallback chain answered instead of the one
    asked for. From this phase `usage_events.model` is the model that ANSWERED (the response's `model`, `llm.js answeredBy`),
    and `runs.model` is updated to it too (the run's reply says which model wrote it). Index `usage_run` (run_id) for the
    per-task spend cap (`usage.js spentOnRuns`).
  - `policies.task_budget_usd` (REAL, NULL = inherit): what one task may spend (0 = no cap). Resolved like the weekly budget;
    the effective default is min($0.50, a quarter of the weekly budget). `setPolicy` keeps it when the caller leaves it out.
  - `wishes (id, user_id → users CASCADE, text ≤ 240, count, run_id → runs SET NULL, first_seen, last_seen)` + `wishes_fts`
    (external-content FTS5 over `text`, insert/delete triggers): the wish log. `services/wishes.js recordWish` finds the same
    wish of the same person by FTS, confirmed by word overlap (≥ half the words of the shorter one, a small stoplist aside),
    and counts it again; otherwise a new row.
  - Not new columns, but new uses: `schedules.fail_streak` now also counts a scheduled TASK's final failures in a row (a
    success resets it, resuming resets it; 3 → paused, agent/proactive.js), besides a watch's failed checks; `runs.error_kind`
    gains `paused` (the note posted when a task was paused). Settings keys: `spend-alert:<userId>` ({ week, level }: the
    budget alerts sent this week), `spend-spike-alert` (the day last alerted), `openrouter-balance` (the last credits/key read),
    and `llm.fallbacks` / `llm.background` in the `llm` setting.
- **046_lessons_tidy.js** (decisions #186–#189): lessons and the weekly memory tidy. JS for one reason: `memories.status` gains
  `'archived'`, and SQLite can't alter a CHECK, so `memories` is rebuilt from its own definition in `sqlite_master` with only that
  list changed (the migration 034 pattern: FKs off around it, every column other migrations added carried over, its indexes and
  triggers re-created, row ids kept so `memories_fts` and `memory_vec` stay valid; `foreign_key_check` must pass).
  - `lessons (id, scope person|household, user_id → users CASCADE (person: whose; household: whose task taught it; NULL for the
    owner's own), domain (registrable host or NULL), rule ≤ 220, why ≤ 160, source said|thumbs_down|pushed|owner,
    source_message_id → messages SET NULL, run_id → runs SET NULL, status active|proposed|retired|rejected|promoted, uses,
    last_used_at, recurrences, reviewed_by → users SET NULL, reviewed_at, created_at, updated_at)` + `lessons_fts` (external-content
    FTS5 over `rule`, insert/delete/update triggers). Written only through `services/lessons.js addLesson` (cleaning, the
    household personal-data check, the same-lesson match that counts a repeat); `promoted` = moved into AGENTS.md by the owner
    (so it isn't in the prompt twice); `rejected` rows are kept only so a guess isn't made again.
  - `lesson_hits (id, lesson_id → lessons CASCADE, run_id → runs SET NULL, source, at)`: each time a lesson was learned, the first
    time included; the evidence for promotion (≥ 3 hits in ≥ 2 distinct runs within 30 days).
  - `memory_tidies (id, user_id → users CASCADE, status done|nothing|error, merged, archived, note, at)`: one row per person per
    weekly pass (written first, so "once a week" holds whatever happens); `memory_tidy_changes (id, tidy_id → memory_tidies CASCADE,
    op merge|archive, memory_ids JSON, new_memory_id, why, undone_at)`: each change, undoable one by one (no FK to memories: a
    memory forgotten later is purged as usual).
  - `memories.status = 'archived'`: taken out of recall, the prompt and "Dates soon" by the tidy (every reader filters on
    `status = 'active'`), kept for history, restorable by the tidy's Undo. Memory events gain the ops `archive` and `undo`
    (actor `tidy` for the tidy's own changes).
- **047_reminder_followups_feed_words.js** (decisions #190–#193): reminders that follow up until done, and muted words in the
  Feed. JS for one reason: `feed_mutes.kind` gains `'word'`, and SQLite can't alter a CHECK, so `feed_mutes` is rebuilt from its
  own definition in `sqlite_master` with only that list changed (the migration 034 pattern; FKs off around it,
  `foreign_key_check` must pass).
  - `alarms` gains `follow_every_min` (NULL = an ordinary reminder that posts once), `follow_max` (nudges after the reminder),
    `follow_until` (`'HH:MM'` local, or `'+N'` minutes after the reminder), `follow_count` (nudges sent this occurrence),
    `occurrence_at` (UTC ISO of this occurrence's first post; NULL = not posted yet), `last_post_msg_id` (the reply a "done"
    must come after; plain integer, no FK), `escalate_to → users SET NULL`, `escalated_at`, `closed_how`
    (card|chat|tool|stop|unconfirmed|early). While a follow-up waits, the row stays `status = 'scheduled'` with `fire_at` = the
    next check, so the scheduler, Upcoming and "Coming up" need nothing new. A repeating reminder resets `follow_count`,
    `occurrence_at`, `last_post_msg_id` and `escalated_at` when it rolls to its next occurrence (services/alarms.js `end`).
  - `reminder_posts (id, alarm_id → alarms CASCADE (NULL for a consent request), user_id → users CASCADE (whose chat), run_id →
    runs SET NULL, message_id, kind reminder|follow_up|escalation|consent_request, level (0 = the reminder, 1.. = nudge number),
    posted_at)`: which chat reply belongs to which reminder (the Done button on its card: `reminderOfRun`), and how often it spoke.
  - `reminder_consents (id, from_user_id → users CASCADE, to_user_id → users CASCADE, status pending|granted|declined, asked_at,
    answered_at, UNIQUE (from, to), CHECK from != to)`: a household member's agreement to be told when this person doesn't
    confirm a reminder. Asked once per pair; only `to_user_id` can answer (`answerConsent`), and can change it any time.
  - `feed_mutes.kind` allows `'word'`: a muted word or short phrase, matched as whole words (Unicode, Arabic clitics peeled) on
    a story's title and summary (services/feed.js).

- **048_screens_b.sql** (decisions #194–#196): what the Phase 25 part B screens need that wasn't stored.
  - `approvals.facts` (JSON `[{ key, label, value?, items?: [{ title, meta?, href? }] }]`, NULL = none): the facts a tool lays
    out beside its preview (an email's To / Subject / Attached files, a picture's shape and model), from the tool's optional
    `approvalFacts(args, ctx)`, cleaned and masked by `services/approvals.js factsOf` at creation (at most six; links only to
    `/library/<id>`; someone else's Library file is never named). `approvals.provenance_level` (`low` | `high`, NULL when the
    task read nothing from outside): the run's taint level when it asked (`high` = some of what it read addressed AI
    assistants), so a card in the history keeps the level it was decided under. Rows from before read as `low` when they have
    a provenance.
  - `threads.last_nudge_at` (UTC `YYYY-MM-DD HH:MM:SS`): when a reply in this chat last ended with the follow-up lead-in
    ("A few things worth a second look:" + bullets, `lib/follow-ups.js`). The main chat keeps at most one a day: a second one
    within 24 hours is taken out of the reply before it is stored (`services/messages.js addMessage` → `services/reply-actions.js
    settleNudge`).

- **049_background_prep_notes.sql** (decisions #197–#200): background tasks, overnight prep, notes for later.
  - `runs` gains `parent_run_id → runs SET NULL` (a background task: the run whose `delegate` call started it; its result is
    posted back into that run's chat; partial index `runs_parent`), `spend_cap` (REAL, what this run may spend instead of the
    person's per-task cap; overnight prep sets what is left of the night's cap; NULL = the policy's task budget, read by
    `spend-watch.js runCap`) and `tool_allow` (JSON array of tool names: the only tools the run is offered and allowed by the
    loop; NULL = the person's toolsets; overnight prep: `web_search, web_read, read_offloaded, library_create, leave_note`).
    Retry copies all three.
  - `users.prep` (`off` default | `ideas`, CHECK): overnight prep, opt-in per person.
  - `ideas` gains `kind` (research|plan|draft|comparison|other, CHECK; NULL for older ideas and starters, guessed from their words
    in `services/prep.js`), `prep_run_id → runs SET NULL`, `prep_started_at` (tried once: never prepared twice),
    `prepared_item_id → library_items SET NULL` (the draft) and `ready_at` ("Ready for you" sent, after quiet hours).
  - `notes (id, user_id → users CASCADE, text ≤ 400, priority low|normal|high, kind note|prep, href, source_label, run_id → runs
    SET NULL (who left it), idea_id → ideas CASCADE (prep notes), delivery_run_id → runs SET NULL (the check-in carrying it),
    delivered_at, created_at)`, index `notes_pending (user_id, delivered_at, id)`. Pending = not delivered, under a week old, not
    carried by a check-in that is still going (a silent or failed check-in leaves it pending), and for a prep note, its idea
    still open with its draft in the Library. Delivered once (`services/notes.js`).
- **051_reminder_post_consent.sql** (decision #205): `reminder_posts` gains `consent_id → reminder_consents CASCADE` (partial index
  `reminder_posts_consent`): the request a `consent_request` note carries, so its chat card answers it with a tap. Written by
  `agent/reminders.js requestConsent` through `alarms.recordPost`; older notes have NULL (no buttons; still answered in words).
- **052_self_review_whats_new.sql** (decisions #208, #210): the weekly self-review and What's new in Jess.
  - `self_reviews (id, period_start, period_end (UTC 'YYYY-MM-DD HH:MM:SS', the window read, end included), origin weekly|admin,
    status running|done|nothing|error, stats (JSON "How I'm doing", built in code: agent/self-review.js weekStats), model, note
    (why nothing, the error, proposals left out and why), created_at, finished_at)`. The row is written before anything else, so
    a failed review still counts as that week's (the weekly one runs when no `weekly` row is under 7 days old).
  - `self_review_proposals (id, review_id → self_reviews CASCADE, kind agents_rule|removal|instruction|skill|memory|developer,
    title, why, change (JSON by kind: agents_rule `{ section?, text }` or `{ find, text }`; removal `{ find }`; instruction and
    memory `{ user_id, text }`; skill `{ name, description, toolsets, body, tests, near_misses }`; developer `{ text }`), evidence
    (JSON run ids the model was shown), target_user_id → users CASCADE, status pending|approved|rejected, decided_by → users SET
    NULL, decided_at, reason (a rejection's), result (what approving did), created_at)`; partial index on pending ones.
  - `whats_new (id, commit_ref UNIQUE (the released commit, short hash), subjects (JSON commit subjects since the previous release),
    lines (JSON plain lines: drafted, then the admin's), status draft|published|discarded, drafted_at (the scheduler asked the model
    once), published_at, created_at)` and `whats_new_seen (entry_id → whats_new CASCADE, user_id → users CASCADE, seen_at, PRIMARY
    KEY (entry_id, user_id))`. An update step writes `data/whats-new-pending.json`; `services/whats-new.js importPending` takes it
    in (one entry per released commit) and deletes the file.
