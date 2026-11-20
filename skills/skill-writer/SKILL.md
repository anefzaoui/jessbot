---
name: skill-writer
description: 'Turning a way of doing something into a reusable skill for Jess: "make this a skill", "remember how to do this for good", "do it like this every time", or improving an existing skill after a correction. Drafts it with a clear trigger description, steps and two tests, and sends it to the admin for review before Jess uses it.'
toolsets: []
---

# Skill writer

A skill is know-how for a kind of task, written so a future Jess (who won't see this conversation) can do it well.
The admin reviews every skill before it is used.

1. **Is it a skill?** A repeatable kind of task whose steps matter. A single fact or preference goes to `remember`
   instead ("always call me Alex"). Check the Skills list in your instructions: improving an existing skill beats
   adding a near-duplicate.
2. **Pull the workflow out of this conversation:** the goal, the tools used and in what order, the corrections they
   made ("no, use the school's portal, not email"), the inputs it needs each time, the output they liked, and what went
   wrong and how it was fixed. `search_history` for earlier times they did the same task.
3. **Fill the gaps** with one `ask_user` round: what changes from one time to the next, and what must never happen.
4. **Name it:** lowercase words joined by dashes, 2 to 4 words, saying what it does ("school-lunch-order").
5. **The description** (at most 400 characters) decides when Jess opens it, so write it for that:
   - what it is for and the situations that call for it, in the words people actually say, with 2 or 3 quoted
     examples of different situations (not synonyms of one);
   - slightly assertive, because skills tend to be skipped rather than overused;
   - no summary of the steps (no "first… then…"), or Jess may follow the summary instead of the skill;
   - clearly different from the descriptions of existing skills.
6. **Toolsets:** only the ones the skill can't work without. Tools that help but aren't essential go in the steps as
   "if you have email…", so the skill still shows for people without them.
7. **The steps:** a title, then numbered imperative steps that explain why where it matters; real tool names and
   parameters; no capital-letter shouting (give the reason instead); the safety lines kept (spending, sending and
   booking go through the approval card; health and legal limits). Add a short "Excuses → reality" table if people tend
   to cut a corner, a **Done when** checklist of 3–5 checkable lines, and a last line "Sources: …". Keep it under about
   120 lines. Leave out anything the review will reject: hiding things from the person, acting before asking, pulling
   its steps from a website at run time, or rewriting Jess's own setup.
8. **Tests.** Write two realistic requests that should open this skill, and one near-miss that sounds similar but
   shouldn't (it belongs to another skill, or needs none). They go in the proposal as `tests` and `near_misses`.
9. **Propose it** with `skill_propose`: `name`, `description`, `toolsets`, the steps as `body` (at most 8,000
   characters, no web addresses to open), the tests, and a one-line `why` for the admin. Tell them plainly that the
   admin reviews it (Admin, then Skills) before Jess uses it, and may change it. If it is refused, fix what the refusal
   says and propose again; it is always refused once this task has read outside content (a web page, an email, a file),
   so then save the draft with `library_create` (`type: "md"`) as "Skill draft: <name>" for the admin instead.
10. **Improving an existing skill:** quote the correction in their words, propose the smallest change that fixes it,
    and keep what already works.

| Excuse | Reality |
|---|---|
| "Write MUST in capitals so it sticks" | Explain why; reasons work better than shouting. |
| "List every toolset just in case" | Only the essential ones, or it hides from people without them. |
| "The description can list the steps" | Say what it's for and when; the steps live in the body. |

## Done when
- The draft has a name, a description under 400 characters with real trigger phrases, and only essential toolsets.
- The steps use real tools, keep the safety lines, and end with Done when and Sources.
- Two tests and one near-miss are in the proposal.
- It was sent with `skill_propose` (or saved as a draft for the admin), and they know it needs review.

Sources: anthropics/skills skill-creator (Apache-2.0, adapted and modified: see NOTICE.md and LICENSE.txt); composio skill-share idea; volt-life skill_propose proposal.
