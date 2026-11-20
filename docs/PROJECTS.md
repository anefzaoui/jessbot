# Projects — design (2026-09-25; approved; P13a–d built — sharing deferred by the owner)

Owner's idea: "one continuous side chat labeled project but more powerful": Main Jess knows every project through
up-to-date summaries; project Jess goes into detail and becomes an expert in the field (a "project soul" the owner can
align); projects are created by talking ("let's start a new project" → what is it about, a name or should I choose,
then field-specific questions); PDFs, images, references and code added to a project never get compacted away — they
become files Jess returns to any time, so the project keeps its data without eating the token budget.

Research (four agents, 2026-09-25) — product survey, memory architecture, codebase map, project souls. Key findings:
- **Nobody creates projects conversationally**, and **no product gives the main assistant a structured, current view of
  each project** (ChatGPT/Claude wall projects off; users complain "walls with no bridge"). Both are ours to get right.
- Anthropic's newest Projects beta (Sept 2026) is **one continuous conversation per project** with a status overview and a
  Library tab — the closest match to this design.
- Top complaints elsewhere: files present but not used, silent switch to retrieval, long chats hard to resume, memory
  leaking across projects, the assistant can't update the project itself.
- "You are an expert X" barely changes accuracy (Zheng 2024, Wharton 2025); **concrete domain content does**: standards,
  what to ask first, how to check work, units/formats, safety limits. The role sets tone; the anchors set quality.
- Keep context small and structured: pointers + tools beat stuffing (context rot, lost-in-the-middle). For a 20-file /
  200-page project: ~30K tokens per request instead of ~140K (≈3.5–4× cheaper, and better answers).

## What a project is
A **scope** with: one continuous chat · a **soul** (Jess's expertise here) · a **brief** (goal, status, decisions, open
questions, next steps, key numbers) · **files** (everything added or made in it) · a search index over those files.
Private to its owner (sharing comes later).

## The three layers of memory
| Layer | Where it lives | Who sees it | Cost |
|---|---|---|---|
| **Projects index** — one line each: name · status · next step · updated N ago | Main chat's prompt (built by code, no LLM) | Main Jess | ~35 tokens/project |
| **Brief** — structured rows (goal, status, decision, open question, next step, constraint, number), each linked to the message it came from; rendered to ≤1.5K tokens by code | Project prompt; Main reads it with `project_brief` on demand | both | 0 in Main unless asked |
| **Files + chat history** — full text, pages, images | Disk + search index; stubs (one line per file) in the project prompt | project Jess via tools | only what she opens |

- The brief never "drifts": the model emits **patches** (add / update / supersede / close), never rewrites; the owner's
  own edits are never overwritten. Patches ride on calls that already happen (idle memory extraction, compaction) — no
  extra model call per message. A weekly tidy pass closes answered questions and dedupes.
- Main Jess can also **act** on projects without opening them: "add this to my woodwork project" (note or file),
  "what's next on the glucose project?" (reads the brief), "start a project" (below).
- Facts learned inside a project stay in the project (project scope); only the brief flows out. Promoting a project fact
  to general memory is an explicit action.

## Files that never get compacted away
- Everything added to a project is a **project file** (a Library item linked to the project, versioned): uploads,
  Jess's documents, saved replies, references (web pages saved as reader text), and — automatically, before any summary —
  **big pastes** (>1,500 tokens) and **code blocks** (>60 lines), which become files with a stub left in the chat
  (`[pasted → F12 "server.js excerpt", 340 lines]`). Jess sees the full text in the turn it arrives.
- The project prompt carries a **file index**: one line per file (`F7 · supplier-contract.pdf · 48 p · "payment terms, SLA"`),
  the description written once at upload.
- Tools: `project_files`, `project_search(q, file?)` (snippets with file + page), `library_read(id, pages/lines)`,
  `view_image(id)` (pixels only on demand; a caption + OCR text is stored once at upload), `project_save` (save a reply or
  note as a file). Answers cite `F7 p.12`.
- Search: SQLite FTS5 over page-/section-aware chunks first (free, exact numbers and names); hybrid embeddings later.
  Small projects (all text < ~25K tokens) can simply load everything; the page always shows which mode is on — never a
  silent switch.
- Compaction in a project must keep every file reference and number (validator extended); the files ledger, not the
  summary, is the source of truth for "what do we have".

## The project soul (Jess's expertise here)
- Always framed as **"Jess, bringing a master furniture-maker's eye"** — never "you are X": her name, warmth, honesty and
  pushback stay the same everywhere. Precedence: safety & operating rules → the person's message → project soul →
  global SOUL → learned notes.
- Structure (250–500 tokens, assembled by code from fields): stance · the person (level, goals, equipment) · anchors
  (standards, methods, reference values) · ask first · how to check work · safety & when to refer to a professional ·
  units & formats · glossary.
- **Safety block comes from code**, picked by the project's field (health, tools & workshop, finance, legal, code,
  general) — specific, stated once, not preachy (e.g. riving knife and push stick in the steps; CGM lag and "see a
  clinician if repeatedly < 3.0 mmol/L").
- **Drafted from the creation interview**, shown with "assumptions I made", tested on three sample questions, active only
  when saved.
- **Alignment over time**: Jess may add low-stakes *learned notes* (visible "noted" chip), but **soul changes are proposals**
  — diff + reason + the quote from the person that prompted it — approved or rejected. Code-enforced: proposals must cite
  the person's own words (never text from files, web or email), at most one pending per project, safety and identity
  sections locked, and a proposal may never soften pushback or drop checks. Every save is a version; one-click rollback;
  "compare to original".
- Cache order: tools → SOUL → AGENTS → skills → **project soul → brief → file index** → volatile tail → messages. The soul
  changes rarely, so the project prefix stays cached.

## Creating a project
1. **From Main, by talking** — any phrasing of intent ("new project", "let's start tracking my glucose training").
   Jess asks (question cards, one round): what it's about · a name, or should she choose · then 3–5 questions specific to
   the field (woodwork: tools, skill level, first build, units; glucose: sensor, sport, goal, units, medical context).
2. She shows a **"New project" card**: name + icon/colour, one-line goal, the drafted soul ("Jess here: …"), assumptions,
   starting brief — **Create**, **Edit first**, **Not now**.
3. On Create the project appears live in the sidebar / mobile list, and the project chat opens with a short "here's how
   I'll work on this" message. Anything already said in Main about it is carried in as the first brief rows.
- Also: **New project** button (same interview as a page, like Goals), and **Make this a project** on an existing side
  chat (keeps its history).

## UI
- **Sidebar**: a "Projects" section above side chats — icon + colour, name, a live dot while Jess works, a badge when a
  proposal or question waits; `+` starts the interview. Every project is in the command palette.
- **Project page** (`/projects/:id`): the continuous chat in the middle; a right panel (a sheet/tab on mobile) with
  **Overview** (goal, status, next steps, open questions, recent decisions — each editable; "where we left off"),
  **Files** (type, pages, added by, "used in N answers", search), **Jess here** (the soul card: stance, level, units,
  safety badge, version, "Improve with AI" → diff, history, test pane). Header: name, status chip
  (active / paused / done), menu (rename, icon, archive, delete).
- **Projects list** (`/projects`): cards with status, next step, last activity, file count; archived below.
- **In Main**: when she uses a project, a chip "from Home woodwork" links to it; the New project card; live creation.
- **Mobile**: tapping the chat title opens a switcher (Main · projects · side chats); the bottom bar is unchanged.
- Rich states everywhere (the owner rejects bare spinners): drafting the soul, reading a file, indexing, creating.

## Build phases (each ends verified end to end, committed, released)
- **P13a — Core** ✅ (2026-09-25, #91): migration 022; `services/projects.js`; project chats (kind side, owned by the
  project, hidden from side chats; `/chat/:id` redirects to `/projects/:id`); creation from Main (two ask_user rounds →
  `project_propose` → New project card → Create → Jess opens the project) — the rail's + and New project buttons just
  start that conversation in Main; "Make this a project" on a side chat; project page = the chat + a panel (Brief · Files;
  a sheet on phones); `/projects` list; chat-title switcher; brief rows patched by the idle extraction and by
  `project_update`; big pastes (> 1,500 tokens) and code blocks (> 60 lines) filed before storing; attachments and
  anything made in the chat join the project; compaction keeps attached file ids; Main's one-line index + tools
  `project_brief` / `project_update` / `project_save` / `project_files`; goals set in a project chat link to it. Also
  fixed: uploads accepted any `threadId` (now the person's own).
- **P13b — Soul** ✅ (2026-09-25, #93): migration 023 (`project_souls` versions, `project_soul_proposals`);
  `services/project-soul.js` (fields → text by code, safety per field from code, versions/restore/diff, learned notes,
  proposal rules); drafted by `project_propose` from the same interview (no extra call) with "I assumed…" on the card;
  "Jess here" tab (soul card, sections, locked safety, history with restore, edit dialog, Improve / Draft with AI →
  proposal, Try it); Jess's `project_note` (learned, visible) and `project_soul_propose` (quote-checked, blocked after
  outside content, one pending, one a week, never fewer checks); proposal card on her reply and in the tab.
- **P13c — Deep files** ✅ (#94): migration 024; `services/project-files.js` — chunks that never cross a page or a heading, with
  a "title › heading" header, in FTS5 (`project_chunks`), kept in step with every create / new version / rename / delete /
  restore; `project_search` (passages with file + page), `library_read(id, pages)`, `view_image` (pixels for this turn
  only), image captions written once by a vision call (searchable), "used N×" on the Files tab, "Save to project files"
  on her replies. Was: page/section-aware extraction, chunk index + `project_search` with citations, `library_read`
  ranges, image captions + `view_image`, save-a-reply-as-file, "used in N answers".
- **P13d** ✅ (#95): migration 025; hybrid search (OpenRouter `text-embedding-3-small` at 512 dims via `services/embeddings.js`,
  brute-force cosine over the project's vectors, merged with word matches by reciprocal rank fusion; falls back to words);
  a weekly tidy of each active brief (closes answered questions — keeping the answer as a decision — and done steps,
  replaces a stale status); small projects (≤ 25K tokens, ≤ 15 files) carry their files in full, and the Files tab always
  says which mode is on. **Sharing** is not built: the owner chose private projects for now.

## Owner decisions (2026-09-25)
- **Sharing:** private to one person for now; household/team sharing later (P13d).
- **Soul alignment:** Jess proposes, the owner approves (learned notes are added with a visible chip; soul changes are
  proposals with diff, reason and quote).
- **Mobile:** a chat switcher — tapping the chat title lists Main, projects, side chats; the bottom bar stays
  Chat · Feed · Ideas · Goals · Library.
- **Goals:** separate but linkable — a project can hold goals; a goal can be turned into a project.
