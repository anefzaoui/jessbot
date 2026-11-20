# Jessbot: notes for AI coding sessions

Everything in [CONTRIBUTING.md](CONTRIBUTING.md) applies; this page adds what an AI coding agent working on the repo
should know.

Read first: `docs/ARCHITECTURE.md` (the plan and phase status), `docs/FEATURES.md` (what Jessbot does and where each
item came from), `docs/DECISIONS.md` (why), `docs/UI.md` (components and rules). For UI work also `docs/DESIGN.md` (the
visual system) and `docs/PRODUCT.md`, and follow the design skills in `.claude/skills/` (impeccable leads, Operate
mode; taste-skill's bans are the checklist; this project's rules win on conflicts).

## Working rules

1. **Understand, then plan, then code.** Restate the request, read the code involved, ask only what you can't find out,
   and make small changes one file at a time rather than one huge edit.
2. **Docs stay current.** Update the `.md` files in the same change so the next session loses nothing. Record every
   meaningful decision in `docs/DECISIONS.md` and in the code that carries it out.
3. **Fix root causes**, never one-off patches. A flaky test gets its cause found, not a retry.
4. **Cheapest thing that works.** Plain code for deterministic work, the cheapest model that does the job, local or
   self-hosted options first.
5. **Verify the whole system** after a change, by running it the way a person uses it, not only the unit tests.
6. **Keep contracts aligned.** Producers and consumers of a shape (service, route, template, client JS, API docs) change
   together.
7. **Don't reinvent the wheel** on the server: look for a maintained library first. In the browser, everything is
   in-house (no front-end libraries, no CDNs).
8. **Reversibility.** Look at `git diff` before anything destructive, commit working states often, and in JS string
   replacement use `replace(a, () => b)` so `$` in `b` stays literal.

## Running things

- `npm run dev` serves http://127.0.0.1:3738 with its own data in `data/dev` and restarts on changes in `src/`; run
  `npm run css:watch` alongside. `npm start` is the normal server on :3737 with `data/`.
- Stop a server you started by its process ID (look it up from the port), never by a command-line pattern: other
  programs may be running on the same machine.
- The setup code for a fresh install is in the server log. Test scripts that create the first admin read it from there
  or set `JESSBOT_SETUP_CODE` for their throwaway server.
- Web access goes through a headless Chromium (`src/browser/`). Pages, feeds and email are untrusted input: they are
  fenced and never treated as instructions (see `docs/SECURITY.md`).
- Checks before committing: see the table in CONTRIBUTING.md.
- UX rule: nothing is fire-and-forget. Every action shows pending, success or error, and runs survive a refresh.
