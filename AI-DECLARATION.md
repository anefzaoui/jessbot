---
version: '0.1.2'
level: copilot
processes:
  design: assist
  implementation: copilot
  testing: copilot
  documentation: copilot
  review: assist
  deployment: copilot
---

This format is based on [AI-DECLARATION.md](https://ai-declaration.md/en/0.1.2/).

# How Jessbot is made, and where AI comes in

Short version: most of Jessbot's code is written by AI, and I want that to be easy to find rather than something you
discover in the commit log. I'm the maintainer, and I designed Jessbot as the household agent I wanted to live with:
one agent the people at home can talk to, that works in the background, and that never sends or spends anything
without asking.

## Which AI

[Claude Code](https://claude.com/claude-code), Anthropic's coding tool, running Anthropic's Claude models. Commits made
with it carry a `Co-Authored-By: Claude ...` line that names the model, so `git log` shows which changes it touched.

Jessbot itself also uses AI at runtime, of course: it is an agent that talks to a language model you choose (see the
README's Providers section). This page is about how the code is made.

## How it's used

I design Jessbot and decide every feature: what it does, how it should behave with each person in a household, what
it must never do on its own, and how it should look and feel. I write that down as a plan for each change, and Claude
Code writes most of the code from it: the server, the pages, the agent's tools and prompts, the tests and the docs.
Every decision and the reason for it is recorded in [docs/DECISIONS.md](docs/DECISIONS.md). Each plan is approved by
me before it is built, the changes are checked by running Jessbot for real (not only by the tests), and I use it
myself.

## Disclosure by area

The categories and levels below are the ones the
[selfhosted community on lemmy.world](https://lemmy.world/post/49151085) asks for, so you can compare Jessbot with other
projects. The levels in the header use the [AI-DECLARATION.md](https://ai-declaration.md/en/0.1.2/) names for the same
thing.

- Design (architecture, system design): Assisted. The features, the safety model (approvals, what the agent may and
  may not do) and the screens come from me. Claude proposes how to build parts of it, and I pick or change the plan.
- Implementation (production code): Generated. Most of the code is written by Claude from my plans, then checked by
  running it.
- Testing (tests, test plans, QA): Generated for the automated tests, human for the hands-on QA. Claude writes most of
  the tests and runs the end-to-end checks; I try the features for real.
- Documentation (docs, comments, README): Generated. Claude drafts most of it, and I edit what isn't true to how
  Jessbot works.
- Review (code review): Assisted. I decide what goes in. Claude helps read through the changes.
- Deployment (CI, Docker, install scripts): Generated, checked by me.

## Contributions

Contributors use their own tools. If an outside contribution was written with AI help, its commits say so the same
way, with a `Co-Authored-By` line. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Tests

The automated tests live in [`tests/`](tests/) and run with Node's built-in test runner (`npm test`). The end-to-end
and real-model checks are in `scripts/` (see CONTRIBUTING.md).
