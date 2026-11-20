# Agent evaluation (`npm run eval:agent`)

A dev-only check of how well the real model uses Jess's tools on household questions whose answers are known
(decision #173; the method is the one from anthropics/skills mcp-builder's evaluation guide). `scripts/agent-eval.js`:

- makes a **throwaway data dir** (its own copy of `.env` for the model key; nothing touches `data/` or a running server),
  sets up Jess and one admin (Europe/London) with core, memory, library, files, office, schedule and lists on (web, email,
  calendar off, so no answer depends on the internet), and seeds fixtures: three PDFs (a 7-page boiler manual, a 4-page
  tenancy agreement with the deposit on page 3, a 2-page school trip letter), a budget workbook made by `makeWorkbook`
  with live `SUM` totals, three alarms and a reminder tomorrow, a shopping list and a to-do list with one item done;
- asks 11 read-only questions, each in a fresh side chat, through the **real agent loop** (`startTurn`) and the **real
  model**; the answer is checked by string match (every pattern must match);
- adds to each question a request for a `<feedback>` block on tool names, parameters and results that were confusing,
  missing or slow, and prints what came back: the input for the tool-description hygiene pass;
- prints the estimated cost first (the prompt measured with `buildPrompt` + the tool schemas, ~3 steps a question, the
  model's listed price) and runs only with `--yes`. Options: `--runs 1-3`, `--only id,id`, `--model <id>`,
  `--out results.json` (every answer, tool call with its arguments and the start of its result, feedback and cost).
- runs against **another provider** with `--base-url <url> --model <id>`: Ollama
  (`--base-url http://127.0.0.1:11434/v1 --model qwen2.5:7b`, no key; give it a 32,768-token context first, see
  [the guide](guide/providers.md#give-ollama-a-context-of-32768-tokens)) or any OpenAI-compatible service (its key in
  `LLM_API_KEY`). The OpenRouter key is then neither read nor sent anywhere.

## Run of 2026-09-26 (1 run each, openai/gpt-6-luna)

Estimated $0.055; spent **$0.021** (cached prompts). **8 of 11 passed** in 66 s.

| Question | Result | Tools |
|---|---|---|
| Which PDF in my Library has the most pages? | pass | library_list ×2 |
| How many pages does the boiler manual have? | pass | library_list |
| How much is the deposit in the tenancy agreement? | pass (cited page 3) | library_list, library_read |
| What date is the school trip in the letter from school? | **fail**: "I couldn't find the school letter" | library_list |
| What total does the budget sheet give for March? | pass | library_list ×2, library_read |
| Which month has the highest total in the budget sheet? | **fail**: said March (1,542.85); January is 1,550.2 | library_list, library_read |
| Which alarm fires next after 7 am tomorrow? | pass | list_alarms |
| What time is my "Call the plumber" alarm? | pass | list_alarms |
| Do I have a reminder tomorrow? What is it for? | **fail**: "I don't see a reminder" | none |
| What's on the shopping list? | pass | list_show |
| How many things are still left to do on my to-do list? | pass | list_show |

**The model's own feedback** (10 of 11 said "none"): "Searching for 'PDF' first returned no matches; listing the Library
without a query worked and showed page counts. It would help if the search supported filtering by file type."

**Why the three failed** (the same fixtures replayed through the tools without the model):

1. **`library_list` search needs every word.** `query: "letter from school"` finds nothing because "from" isn't in the
   title "School trip letter"; `query: "PDF"` finds nothing because the file type isn't searched. The model tried once
   and gave up. Fix belongs in the Library search (ignore small words, match most words, match the type), plus a line in
   the tool description ("few words; leave out the query to list everything").
2. **A spreadsheet's numbers are shown unevenly.** `library_read` gave the right table, but totals as `1,550.2` next to
   `1,542.85` (the column is a currency column): the model compared them wrongly. Showing numbers with the column's own
   format (2 decimals for currency: `1,550.20`) would make comparisons reliable.
3. **"Coming up (next 24h)" is read as "everything tomorrow".** The prompt's Upcoming block covers the next 24 hours
   only, so a reminder at 18:00 tomorrow (34 hours away) was missing, and the model trusted the block instead of calling
   `list_alarms`. The block should run to the end of tomorrow in the person's time, or say that later items need
   `list_alarms`.

These are inputs for the Phase 23 tool-description hygiene pass (Library search and office reading belong to the
Library/office code; the Upcoming block to the prompt).

## After the fixes (decision #207): run of 2026-09-26, 1 run each, openai/gpt-6-luna

Estimated $0.062; spent **$0.024**. **11 of 11 passed** in 51 s (before: 8 of 11 in 66 s).

| Question | Before | After | Tools after |
|---|---|---|---|
| Which PDF in my Library has the most pages? | pass (library_list ×2) | pass | library_list |
| How many pages does the boiler manual have? | pass | pass | library_list |
| How much is the deposit in the tenancy agreement? | pass | pass | library_list, library_read |
| What date is the school trip in the letter from school? | **fail** | pass | library_list, library_read |
| What total does the budget sheet give for March? | pass (library_list ×2) | pass | library_list, library_read |
| Which month has the highest total in the budget sheet? | **fail** | pass | library_list, library_read |
| Which alarm fires next after 7 am tomorrow? | pass (list_alarms) | pass | none: "Coming up" now holds all of tomorrow |
| What time is my "Call the plumber" alarm? | pass (list_alarms) | pass | none |
| Do I have a reminder tomorrow? What is it for? | **fail** | pass | none |
| What's on the shopping list? | pass | pass | list_show |
| How many things are still left to do on my to-do list? | pass | pass | list_show |

What changed at the root: Library search ranks items with all the words first, then any of them, and a kind of file named in the
query matches every item of that kind (`library_list` also takes `type`); a spreadsheet's numbers read as their format shows them
(1,550.20 next to 1,542.85); "Coming up" runs to the end of tomorrow in the person's timezone. The model's feedback: "none" for
all 11. The prompt measured ≈17,694 tokens a step (≈15,528 in the first run): the operating manual got ~100 tokens shorter and the
tool schemas are about even (descriptions trimmed, `type` added); the growth is the tools other Phase 22 chunks added to the core
set since the first run, and the four alarms of tomorrow now listed in "Coming up".
