# Context & Memory design

Chosen 2026-09-24 from two research reports (context compaction; long-term memory). Implemented in Phase 3; long-term
memory brought up to this design in Phase 20 (decisions #151–#156; lessons and the weekly tidy #186–#189). Where something here is still a plan, it says so.
Owner goal: "auto-summarize each message and each thing so things don't go out of control."

## Principles

1. **Raw history is never deleted** (except an explicit user "forget", which also redacts). Compression is restorable.
2. **Big things are offloaded at write time, deterministically — no LLM.** A 2,000-token tool result becomes a stub
   + blob. (JetBrains 2025: observation masking halves cost with equal or better quality than summarization.)
3. **Dialogue is condensed rarely**, into one **structured, anchored rolling summary**: only the newly evicted
   span is summarized and merged (Factory). Not an LLM call per chat message — nobody reads those, and they cost.
4. **Cache-first.** Stable prefix, append-only between rare "epochs"; rewrites happen only at epochs or when the
   cache is already cold (Manus, OpenClaw). Key metric: `cached_tokens / prompt_tokens` > 80%.
5. **1M context is not a budget.** Context rot hurts every model well below the limit, and GPT-6 Luna doubles the
   price above **272K** input tokens. Working target **120K**, hard cap **200K**.
6. **Scope comes from the server, never from the model** — for memory reads, writes and searches.

## Per-item "summaries" (what "summarize each thing" means here)

| Item | When | How |
|---|---|---|
| Any message / tool result | write | `token_count` (gpt-tokenizer o200k estimate, calibrated against provider `usage`) |
| Tool result > 2,000 tok | write, sync | body → `data/blobs/<sha256>.txt`; context keeps a **stub** (tool, args, size, head/tail 600 chars, ref). Agent re-reads with `read_offloaded(ref, range?)`. The stub replaces the body only in **later turns** — within the turn that produced it the model sees it in full (decision #44) |
| Message / tool result > 1,500 tok | *planned, not built* | a 1–3 sentence **gist** for the stub and the UI |
| Conversation span | at compaction | level-1 **segment summary** + updated level-3 **rolling thread summary** |
| Each day | *planned, not built* | a level-2 **day summary**; `search_history` gives a per-day digest from the messages instead (#155) |
| Each extraction pass | idle ~10 min | **memory extraction** (below) + one **episode** (a dated line, ≤ 280 chars) from the same call (#155) |

## Context assembly per request (cache order, most stable first)

| # | Block | Budget | Changes when |
|---|---|---|---|
| 1 | Tool schemas (policy-filtered, fixed order, deterministic JSON) | ~5K | policy/deploy |
| 2 | SOUL.md + AGENTS.md + lessons learned (#188) + user instructions + speaker identity (no timestamps) | ≤ 4K + ≤ 2.2K | rarely |
| 3 | Core memory snapshot (user profile + permitted shared scopes) | ≤ 4K | epoch |
| 4 | Rolling thread summary (structured) + pinned messages | ≤ 8K + ≤ 6K | epoch |
| 5 | Side-chat digest | ≤ 2K | epoch |
| 6 | Verbatim turns since the anchor (offloaded tool results as stubs) | rest; ≥ last 20 msgs / 30K | append-only |
| 7 | Current agent-loop tool results (full; older masked after the last 3) | ≤ 60K | within a turn |
| 8 | Volatile tail: current time, "Coming up" (until the end of tomorrow in their timezone, #207), the reply language, routing hints from the message sense ("## Skill for this", "## Careful topic: …", #177), on runs of 6+ steps "## The task you're on" (the request ≤ 600 chars + ≤ 8 failed steps, #177), remembered dates soon, retrieved memories (≤ 8 facts + 3 episodes), approval/question state, a correction nudge and lessons that may apply (#187, #188) | ≤ 3K | every request |
| — | Output reserve | 16–32K | — |

OpenRouter `session_id` = thread id (sticky provider routing → cache hits).

**Anthropic models (decision #202, `llm.js withPromptCache`, applied by `buildPrompt`).** OpenAI, Gemini and DeepSeek cache
the prefix on their own; Anthropic models cache only up to an explicit `cache_control: { type: 'ephemeral' }` breakpoint
(≤ 4 per request, content-array form). When the configured model, or the model that answered the run last, starts with
`anthropic/` (or `~anthropic/`), the request gets two: on the stable system message (blocks 1–5) and on the last turn with
content before the tail (blocks 6–7; the picture itself when the last part is one). The tail (block 8) is then sent as a
**user** message starting with "(From the app, not written by them: …)", because OpenRouter moves every system message into
Anthropic's system prompt ahead of the turns, where the tail (it holds the minute) broke the prefix of every call: measured
on claude-haiku-4.5, 8,302 of 8,308 prompt tokens written to the cache on each call and none read; with the tail as a user
message the next call read 8,278 of 8,316. Other models get the request exactly as before (the tail a system message).
Anthropic's minimum cacheable prefix is 1,024–4,096 tokens by model; Jess's system block is above it.

**Pictures in the context (decision #201).** An image goes to the model as its model copy (`v<N>.model` next to the file:
at most 1568 px on the longer side, a JPEG on white unless it is already a small JPEG/PNG), never the original: a 2 MB,
4779×2987 photo becomes 303 KB (1568×980), a 2.2 MB PNG screenshot 188 KB, in every call of the turn. Copies are made when
an image is stored (uploads wait for it), attached to a message, viewed (`view_image`) or captioned; a missing one sends the
original once (≤ 8 MB) and is made for the next step. PDF page pictures for the model (`pdf_page_image`, first looks) use the
same 1568 px cap. Token estimates count a picture as 1,600 tokens (`lib/tokens.js IMAGE_TOKENS`), not its base64 length.

**Outside content in the context (decision #118, docs/SECURITY.md).** Pages, search results, snapshots, emails, files and
calendar entries arrive fenced: `<kind … fence="id">`, one notice line, an optional ⚠ warning, the text, `</kind fence="id">`.
Tool results get a random id when the tool runs and are stored with it, so later turns replay them byte-identically.
Blocks rebuilt on every step use an id that is stable for the server process: attached files (block 6), a small
project's files (block 2) and the calendar entries in "Coming up" (block 8). Their warnings come from the stage-1 patterns
only (no model call in prompt assembly), so the same text always renders the same way. Browser snapshots keep the
`--- page snapshot ---` mark outside the fence: an older snapshot is dropped from the mark on, fence included.

## Compaction

**Triggers:**
- **Soft:** a turn ends with `usage.prompt_tokens > 120K`. Queue a background job.
- **Idle:** the cache is cold (idle > 30 min) and the verbatim region is over 60K.
- **Hard:** the next request would exceed 200K. Compact synchronously first.
- **Manual:** the "Compact now" button.

**Procedure:**
1. **Cut.** Keep a verbatim tail of about 30K tokens or at least 20 messages. Align the cut to a turn boundary where no tool call is open and no approval or question is pending.
2. **Memory flush.** The same call returns `memory_candidates[]`, which go through the normal extraction path. The span's
   TOOL lines (web pages, emails, files) are outside content: the prompt says candidates come only from what the person said
   in USER lines, and a plain-code backstop keeps a candidate only when at least 60% of its content words appear in the
   span's USER rows (`inTheirWords` in `services/context.js`: `Intl.Segmenter` words in any script, numbers and framing
   words ignored, a shared four-letter stem counts). A page or an email can't become a memory by way of the summary. [#125]
3. **Summarize only the span** (previous summary JSON plus the span, with stubs and gists) using the chat model — or the background model when one is set, retried once on the chat model when it fails (#179). The output is a JSON summary with these sections:
   - `goals_and_projects`
   - `user_preferences_and_constraints`
   - `decisions` (with why)
   - `open_tasks_commitments_pending`, each `{ item, status }` with status `done-confirmed` (a TOOL line in the
     span shows it succeeded), `claimed` (said to be done, nothing confirms it) or `planned` (still to do). The prompt says:
     "Mark something done only when a tool result in the span confirms it." In code (`normaliseTasks`): a plain string or an
     unknown status is `claimed`; `done-confirmed` stands only when a tool in the span succeeded or the previous summary
     already had that item confirmed. The summary text says "(said to be done, not confirmed: check before relying on it)". [#198]
   - `artifacts` (files, jobs, URLs, refs)
   - `identifiers` (copied verbatim)
   - `timeline` (dated)
   - `user_quotes`
4. **Validate.** Every URL, path and ID from the span must be in the summary or reachable through a ref, and the summary must be ≤ 8K tokens (trim `timeline` first). If validation fails, retry once, then fall back to masking only. Never wipe.
5. **Commit in one transaction.** Add a level-1 summary row, supersede the level-3 row, mark the span `compacted_into`, and increment `context_epoch`.

## Long-term memory (thin layer; no framework)

No existing framework is TypeScript-native, SQLite-only, strictly multi-scope and still maintained. The design ports ideas instead:
- **Hermes:** bounded core memory, frozen snapshot, injection scan, FTS session search
- **Mastra:** dated observations
- **Graphiti:** temporal supersede instead of delete
- **OpenClaw:** hybrid search, decay, gated promotion
- **Anthropic:** path and size safety

| Tier | Contents | In prompt |
|---|---|---|
| T0 Core | user profile ≤ 1,400 chars; each shared scope (family, company) ≤ 2,200 chars; pinned facts | always (frozen per epoch) |
| T1 Facts | atomic facts ≤ 300 chars, scoped, optionally dated (one-off or yearly), with importance 1–3 and source links | retrieved (≤ 8) |
| T2 Episodes | one dated line per extraction pass, private, knows the messages it covers | retrieved (≤ 3) |
| T3 Raw history | messages + FTS5 | via the `search_history` tool (own chats only; words and/or their local dates; a day digest) |

**Extraction** runs when a chat has been idle for about 10 minutes (the scheduler checks the database, so it survives
restarts). The decision model first asks "anything here?" (a durable fact, an episode-worthy event, a project change) and
skips only when very sure (#107). Then one call with JSON output (`services/context.js`), on the background model when the
admin chose one in Admin → Models (else the chat model), with one retry on the chat model when it errors or its JSON can't
be read (#179, `llm.js jsonJob`):
1. The conversation lines are the new user and assistant messages since the checkpoint, each with its id and **local date
   and time** (so "next Tuesday" can become a date).
2. **EXISTING FACTS** are the saved facts nearest to what the person said (#152): `recallHybrid` with each of their new
   turns as its own query (top 30), then the pinned ones, then the newest 20; at most 60, private scope only. Each shows
   its date.
3. The model returns `ops` (**add** with `kind`, `importance` 1–3, and for a fact about a day `date` + `recurs: yearly`;
   **update** of a shown id) and `episode`. Updates only touch facts it was shown and never one the person wrote or
   edited; a date that doesn't parse is dropped and the fact kept. The prompt asks it to name people with their relation
   ("Maya (daughter) starts school on 1 Sep").
4. Every add goes through `addFactChecked`: a near-duplicate in the same scope (cosine ≥ 0.93 when embeddings work, else
   ≥ 90% the same words), carrying the same numbers and the same date (embeddings barely see numbers: two dentist dates
   scored 0.945 on the real model), returns the existing fact and logs a `dedupe` memory event instead of a second row. The
   compaction flush and the `remember` tool use the same path; `remember`'s answer lists up to 3 similar memories ("if one
   is now wrong, update it by id").
5. **DELETE happens only on an explicit user "forget".** Supersede sets `valid_to` on the old fact and links it.
6. Scope rules:
   - Default scope is **private**.
   - A shared scope is used only when the user says so and has write access to it.
   - Private facts are **never auto-promoted** to shared.
   - In group contexts, only scopes that every participant can read are injected.
7. An injection and invisible-Unicode scan runs on every write, and every change writes an audit event. The injection
   patterns are the detector's stage 1 (English, French, Spanish, German, Arabic; `agent/injection.js`) plus persona
   switches; the invisible set is the one in `lib/untrusted.js`, which keeps U+200C/U+200D (Persian, emoji sequences).
   Secrets are refused on every write path (the `remember` tool, extraction, the compaction flush, edits on the Memory
   page, imports, episodes): card numbers (Luhn), API keys and tokens, private keys, two-step sign-in seeds and
   "password/PIN/code is …", with one kind line ("I don't keep passwords or card numbers in memory: they'd go to the AI
   service with every message. A password manager is the safe place."). IBANs and phone numbers are kept. The shapes are
   the outbound guard's (`lib/dlp.js`); the extraction and summary prompts say it too. [#125]
8. **The weekly memory tidy** (#189; `agent/memory-tidy.js`, the scheduler's `memoryTidyTick`): once a week per person, only in
   their quiet hours, within their weekly budget and when no task of theirs is running, one person per tick. Code picks the
   candidates (`services/memory.js tidyCandidates`) from their private, active memories, never a pinned one, never one in their own
   words (`created_by = user`), never one learned in a chat that is now off the record: groups of the same kind and date with
   cosine ≥ 0.85 (from `memory_vec`; no groups when embeddings are off), one-off events more than 30 days past, undated events
   noted and unused for 30 days, and details (importance 1) nobody used in a year. The model sees only those and returns merges
   (within one group: the first memory is superseded by the merged text, the others archived; the highest importance kept) and
   archives (`memories.status = 'archived'`: out of recall and the prompt, kept for history). Anything outside what was shown is
   skipped in code. The pass is recorded (`memory_tidies`, each change in `memory_tidy_changes`), an Activity item says "Tidied
   your memories: merged N, archived M" and links to `/me/memory?tidy=<id>`, and every change can be undone on its own
   (`POST /api/v1/me/memory-tidies/changes/:id/undo`). Promotion into a shared scope always needs a human: the tidy never moves
   anything between scopes.

**Lessons** (#186–#188; `services/lessons.js`, `agent/lessons.js`, the `learn_rule` tool). A lesson is one rule for how Jess
works, "When …, do … (not …)" (≤ 220 chars, optional why ≤ 160, optional site), in `lessons` (migration 046), cleaned like a
memory (invisible characters, instruction-looking text and secrets refused).
- **Personal** lessons (scope `person`) are active at once, only ever shown to their person (You → Memory, `GET /api/v1/me/lessons`;
  the admin never sees them) and removable by them. They come from `learn_rule` (their words quoted from their message this turn
  or the one before it; refused after the run read outside content, #119, and in an off-the-record chat unless they ask to
  remember) and from a thumbs-down: one cheap post-mortem (request + reply + their optional "What was off?") → a lesson, active
  when they said what was off, else proposed until they press Keep on the "Noted: …" chip.
- **Household** lessons (scope `household`) reach everyone and wait for the owner (Admin → Lessons: approve, edit, reject, retire)
  unless the owner wrote them. A task the goal gate pushed (#113) and that then delivered gets one cheap call at its end → a
  proposed household lesson with its site (only a site the task opened). They must carry no personal details (emails, phone or
  account numbers, IBANs, links with parameters, household members' names), checked in code.
- **A repeat** (same scope, person and site; ≥ 60% the same words) counts again instead of a new row: `recurrences` + a hit in
  `lesson_hits`. The owner may promote a household lesson into AGENTS.md (a versioned save, under "## Lessons learned") once it came
  up 3 times in 2 different tasks within 30 days. An active lesson unused for 90 days is marked "retire?", never deleted by itself.
- **Use.** `lessonsBlock(user)` sits right after AGENTS.md in the system block (cached prefix): the person's active lessons without a
  site (≤ ~1,000 chars) then the household's (≤ ~1,200), most used first; each message counts every lesson in the block once, so
  their order among themselves holds and the prefix only changes when a lesson is added, edited or reviewed. The tail's
  `lessonsTail` adds up to 3 lessons that didn't fit but share two or more words with their message (a site lesson when they
  name the site), and a nudge when their message corrects her (the per-message sense's `correction` answer, else plain words in
  five languages): fix it, then save it with `learn_rule` if it is lasting, or ask in one line; a correction that repeats one of
  their lessons names it. `domainNotes(user, host)` gives ≤ 3 active lessons for a site ("Notes from past visits to
  booking.com: …") for the browser_open / web_read results, counted once per run and site. Off-the-record chats get no nudge and
  teach nothing. Wired: prompt.js (block and tail), sense.js (the question), proactive.js (the tidy). *Not wired yet:*
  `domainNotes` in the browser_open / web_read results (tools/browse.js and web.js belong to another chunk; the call is one
  line after each result is built).

**Retrieval** (`services/memory.js`, #151, #153). The server computes the visible scopes, then:
1. Words: FTS5 BM25 top 40 over `memories_fts` with **prefix terms** (`lib/fts.js ftsAny`: any of the words; a word of
   4+ letters loses its last letter, so "kids" finds "kid"; filler words dropped). Meaning: the query's embedding against
   `memory_vec`, brute-force cosine over the active facts of the visible scopes (filtered in SQL *before* scoring), top 40
   above 0.2. An Arabic message finds an English fact this way; so does "what should I cook?" → "allergic to peanuts".
2. Merge with RRF, k = 60 (`lib/rrf.js`, shared with project-file search).
3. Multiply by salience: × decay (half-life by kind: event 30 days, schedule 90, fact and preference 365; profile, place,
   instruction and **pinned never decay**; age counts from the later of noted and last used) × (1 + 0.3·(importance − 1))
   × 1.5 if pinned × 0.2 for a one-off event more than 14 days past.
4. The query embedding races ~900 ms, then words alone; with embeddings off (`JESSBOT_EMBED_OFF=1`) or failing, it is
   BM25 only. No MMR (not built; the decision model's pick below does the de-duplicating job).
- **Per message:** the sense (`agent/sense.js`, one decision-model call) gets ~25 hybrid candidates + the pinned and newest
  (≤ 40 facts) and up to 6 episodes (hybrid + the 2 newest), and picks ≤ 8 facts and ≤ 3 episodes for the tail. The
  chosen facts are marked used once per message. Without the sense (decision model off or late), the prompt falls back to
  words-only `recall` (6 facts, 2 episodes), marked once per message too, however many steps rebuild the prompt.
- **The `recall` tool** uses the hybrid search (8 facts + 3 episodes) and marks what it returns as used.
- **Vectors** are filled in the background: after every add, supersede and edit, and a backfill whenever recall finds
  facts or episodes without one (a new embedding model re-embeds everything). A vector is only stored if its row still has
  the same text; an edit or supersede drops the old one.

**Dated memories** (#154). `memories.event_at` holds `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM` (their wall-clock time) or, for a
yearly date without its year, `MM-DD`; `memories.recurs` = `yearly` (migration 037). `remember` takes `date`, `yearly`
(a boolean: models fill every field of a tool, and a filled-in `false` or `""` means nothing, while a one-value enum got
filled with "yearly" on a weekly routine in the live check) and `importance` (on add; an update keeps date and importance
unless a new date is given); extraction sets them too. `datesBlock()` puts "## Dates soon (from memory)" in the tail: dated items in the next
7 days in their timezone ("Sun 14 Feb (in 3 days): Maya (daughter)'s birthday [memory 12], turns 11 (every year)") and
one-off events of the last 3 days under "Just passed", so she can ask how the dentist went. The check-in decision sees the
same list. Memory lines show their dates. Reminders can repeat `yearly` (`lib/when.js repeatToCron`).

**Episodes** (#155). One line per extraction pass from the same call ("" when it was only small talk), stored private with
`from_msg_id`/`to_msg_id`; deleting a message deletes the episodes covering it (and their vectors); a deleted chat's
episodes aren't recalled; off-the-record chats never produce one. Searchable by words and meaning (`episode_vec`).

**History by date** (#155). `search_history` takes `query` and/or `from`/`to` (their local dates): matches come with the
message before and after, labelled with the chat and local time; dates without a query give a day digest (message count,
chats, what Jess did from the activity log, the day's episodes, the start of their messages; ≤ 40 lines).

**Import** (#156). `POST /api/v1/me/memories/import/preview` turns a pasted memory export from another assistant (lines,
markdown, ChatGPT-style JSON) or a `.vcf` (via `ical.js`: names, birthdays with or without the year, anniversaries,
relations) into candidates; nothing is saved until `POST /api/v1/me/memories/import` with the chosen ones (private, marked
as theirs, every line through `cleanFact` and the duplicate check). The screen is Phase 25.

**Embeddings** sit behind a pluggable interface (`services/embeddings.js`, #95):
- OpenRouter `openai/text-embedding-3-small` at 512 dims (about $0.02 per 1M tokens), the admin's `embeddings` setting.
- Every row records its model and dims; rows of another model are ignored until re-embedded.
- *Planned, not built:* an offline option (`@huggingface/transformers` in `./tools/models`), and `sqlite-vec` if the corpus
  grows past about 100k rows (it must be loaded with `allowExtension` set at construction time).

**Forget** hides the fact at once and hard-deletes it about a minute later (the Undo window): the row, its FTS row
(trigger) and its vector (`ON DELETE CASCADE`), keeping a tombstone without the text. Deleting a message the other way round
offers to forget the memories learned from it (decision #50) and removes the episodes that covered it.

**Off the record** (decision #123; side chats only; `POST /api/v1/threads/:id/off-record`, the toggle comes in Phase 25):
while `threads.no_memory` is on, nothing from the chat becomes a memory. Extraction skips it without a model call (in a
project chat only the project brief is kept, with no person facts asked for or applied); compaction still summarises (the
chat must go on) but its memory flush saves nothing; `remember` refuses unless the person's own message in that turn asks
to remember something (English, French, Spanish, German, Arabic, Persian phrasings; questions like "do you remember…?"
don't count) and tells the model to say it wasn't saved; idea reflection skips it. Turning it off records
`no_memory_upto`, so the off-record stretch is never read later, and a compaction span that reaches into it flushes nothing.
The chat itself stays in the person's history (`search_history` still finds it: it is theirs).

## Getting better: the weekly self-review (decision #208)

Nothing in the prompt changes by itself. Once a week, when the admin switched it on (`PUT /api/v1/admin/self-review`), in the
owner's quiet hours, within their budget and with nothing of theirs running, `agent/self-review.js` reads the last 7 days in
plain code: thumbs-down replies, the goal gate's and reply audit's pushes (by their step labels), dead-end checks, changes
refused as repeats (#114), declined approvals, failed steps, the wish log, lessons and skill use. Members' tasks reach the model
only as patterns (origin, tools, what went wrong, the run id); their requests, replies, step labels, approval titles and reasons
never do; the owner's own chats may be quoted. One background-model call returns proposals; code keeps at most 3, drops any
that cite a task the model wasn't shown, a line AGENTS.md doesn't hold exactly once, a removal of a heading or a safety rule, or
text that reads like instructions to an assistant. The admin approves (AGENTS.md through the versioned save, a person's
instructions as a new version, a skill through `skill_propose`, so it still waits for review) or rejects with a reason.
"How I'm doing" is the same week in numbers, no model.

## Schema sketch (Phase 3 migrations)

```sql
-- conversation
messages(id, thread_id, seq, role, author_user_id, content, created_at, token_count, summary, pinned,
         offloaded_ref, stub, tool_call_id, masked_at_epoch, compacted_into, redacted)
messages_fts USING fts5(content, summary)
thread_summaries(id, thread_id, level /*1 segment,2 day,3 rolling*/, from_seq, to_seq,
                 content_json, content_md, token_count, model, created_at, supersedes_id)
threads(…, active_summary_id, context_epoch, last_prompt_tokens, last_cached_tokens, last_activity_at)
-- memory
scopes(id, kind /*user|group*/, name) · scope_members(scope_id, user_id, role /*read|write|admin*/)
memories(id, scope_id, subject_user_id, author_user_id, kind, text, pinned, importance, confidence,
         observed_at, event_at, valid_from, valid_to, supersedes_id, status, created_by,
         source_thread_id, source_message_id, created_at, updated_at, last_used_at, use_count)
memories_fts USING fts5(text, content='memories', content_rowid='id', tokenize='unicode61 remove_diacritics 2')
memory_vec(memory_id, model, dims, vec BLOB)                  -- filled since Phase 20
memories.recurs ('yearly' | NULL)                             -- migration 037
episodes(id, scope_id, thread_id, observed_at, ref_date, text, from_msg_id, to_msg_id) + episodes_fts + episode_vec
memory_events(id, memory_id, op, actor, at, old_text, new_text)
memories.status += 'archived'                                 -- migration 046 (the weekly tidy)
lessons(id, scope person|household, user_id, domain, rule, why, source, source_message_id, run_id, status, uses, last_used_at,
        recurrences, reviewed_by, reviewed_at) + lessons_fts + lesson_hits(lesson_id, run_id, source, at)       -- migration 046
memory_tidies(id, user_id, status, merged, archived, note, at) · memory_tidy_changes(tidy_id, op, memory_ids, new_memory_id, why, undone_at)
```

## UI

- **Threads:**
  - A divider reading "Earlier conversation summarized · N messages · dates · View summary · View originals". Raw messages stay scrollable.
  - Tool cards: "Output stored (48K tokens) · gist · open".
  - A pin toggle on each message.
  - "Memory updated (3)" chips after a flush.
- **Context meter:** "84K / 200K · cache 91% · compacted 2h ago", with a **Compact now** button. The rolling summary can be edited, and an edit starts a new epoch.
- **"What I remember about you":** add superseded-version history, a pin toggle (promotes to core), and "Move scope" (private → a shared scope the user can write to). User edits are marked `created_by=user`, and extraction never overwrites them.

## Verified locally
- FTS5 with BM25 works in the built-in `node:sqlite` (SQLite 3.53.3) — checked 2026-09-24.

## Still unverified (check at implementation)
- GPT-6 Luna's tokenizer (assume o200k and calibrate against `usage`)
- GPT-6 Luna's cache TTL
- whether OpenRouter's `dimensions` parameter works for each embedding model
- brute-force cosine timings on the target hardware
