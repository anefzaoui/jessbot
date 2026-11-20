# Jessbot: product context

Read with `docs/DESIGN.md` (visual system) and `docs/UI.md` (components, rules) before any UI work. This is the
context the design skills in `.claude/skills/` ask for.

## What it is
A self-hosted personal agent for one household or small team. **Jess** (renameable) has her own browser, keeps
working when the app is closed, and reports back: chat, a feed she writes, goals she works on, ideas she proposes,
projects with their own brief and files, a library of what she made, and a schedule of what she'll do next.

## Who uses it
- **The owner** (admin): sets it up on their own computer, runs it all day on desktop and phone, approves anything
  that spends money or speaks for them. Technical enough to paste an API key; not interested in configuring.
- **Family / colleagues** (members): each has a private chat; the owner decides what Jess may do for them.

## Surfaces and modes (impeccable)
- Every signed-in page is **Operate**: a tool you live in. Scanability, consistency and trust beat expression;
  personality lives in Jess herself (the living avatar, her sky, her voice) and in precise details.
- The **Feed** reading sheet is **Read**: long-form comfort, 65–75ch measure.
- Setup and sign-in are the only near-**Persuade** moments (first impression of Jess), and still restrained.

## Use scene
Glanced at many times a day, often on a phone, often at night (the sky follows the viewer's clock). Both themes are
first-class; dark is common. Work runs for minutes in the background, so every state must say what she is doing.

## Voice
Plain, warm, specific, first person from Jess ("I'll ask here and in chat"). Sentence case. No exclamation marks, no
"Oops", no AI filler verbs, no em-dashes in UI copy. Errors name the problem and the way out.

## Constraints
- All browser JS/CSS in-house; no front-end libraries or CDNs. Server-side libraries are fine.
- Content can be right-to-left (Arabic); use logical properties.
- Nothing is fire-and-forget: pending → success/error, with Retry/Undo; runs survive a refresh.
