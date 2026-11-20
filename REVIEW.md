# Review checklist

What to check in a pull request, by what its diff touches. Check only the items a diff triggers; most pull requests
trigger a few. The reviewer reads this file from `main`, never from the pull request under review. A pull request that
changes this file, CI workflows, tests or the verify skill (`.claude/skills/verify`) is reviewed against `main`'s copy,
and more strictly.

An item is added when the same kind of miss has shown up in two pull requests and can be seen from a diff. Items that
stop earning their place are removed. The first items below come from misses that reached `main` or a review.

## Every pull request

- [ ] It was run the way a person uses it, as the verify skill says, and the description says how (`Verified:`) and
      what wasn't (`Not verified:`).
- [ ] CHANGELOG.md has its line under `[Unreleased]` (or the description says why none); ROADMAP.md moves its item.
- [ ] Anything visible has screenshots: light and dark, and a phone width when the layout changed.
- [ ] The review and the merge are for the same commit (merge with that commit's SHA).

## Decisions

- **Triggered by:** a new entry in docs/DECISIONS.md.
  - [ ] Its number is one above the highest on `main` (gaps stay gaps) **and** not taken by another open pull request;
        after a merge of `main`, check again. Two pull requests have taken numbers another one already had (233 and
        234 were renumbered at merge), and decisions are cited by number in code and docs.
  - [ ] The code that carries the decision out names it (`decision #N`), with the same number.

## Docs and the code

- **Triggered by:** a change to README.md, docs/ (the guide, FEATURES.md, SECURITY-MODEL.md), `.env.example`, a page's
  help text or the doctor's advice.
  - [ ] Every feature, setting, menu name and file it mentions exists in the code under that name today. Docs have
        claimed a backup that skipped the file, a setting the code ignores and a control that isn't there (#55).
  - [ ] Something not built yet is said to be planned (ROADMAP.md), not described as working.

## Outside content and the model

- **Triggered by:** a new or changed path from something Jessbot didn't write (a page, a feed, mail, a calendar
  invite, a file, a tool's result or error, a background task's report, another person's text) into a prompt.
  - [ ] It reaches the model fenced (`lib/untrusted.js`) with a kind the defanger knows, or, when it must be plain (an
        error), as one clean, capped line. Background reports and tool errors both reached the model unfenced before
        (#44, #46).
  - [ ] Reading it marks the run's taint, so the approvals count what the task read.
  - [ ] docs/SECURITY-MODEL.md's table of entry points has its row.

## Tests

- **Triggered by:** a new or changed test that depends on the time of day, a date, a time zone, a delay or another
  process.
  - [ ] It passes at any hour and on a slow machine: schedules placed relative to now and far from the edges, latches
        or conditions instead of fixed delays. Two tests failed only near 07:00 or on a loaded machine (p19a, p22j).
        A flaky test is fixed or deleted with the reason, never re-run until it passes.
- **Triggered by:** a test, a fixture or a script that starts a server.
  - [ ] It listens on a port the test picks (`tests/helpers/listen.js`, or a random one in the script's range), never
        the default 3737 or the dev server's 3738, and uses a throwaway `JESSBOT_HOME` and `JESSBOT_ENV_FILE`: a test
        that binds 3737 meets the real install running there, or reads its `.env`.
- **Triggered by:** a key, token, password or address in a test, a fixture or the docs.
  - [ ] It is obviously fake (`sk-or-v1-test-…`, `example.com`, `.test`), never something shaped like a live key with
        a real prefix and real length: secret scanners and readers can't tell those apart from a leak.

## Security-sensitive code

- **Triggered by:** a redirect, a path from a request, a regular expression over outside text, or HTML or SVG built
  from a value.
  - [ ] It goes through the shared helpers: `localPath`/`safeNext` for redirects, `lib/safe-path.js` for files,
        `lib/text-safe.js` for linear-time text handling and escapes. CodeQL's findings on the pull request are fixed
        or explained in the description, not left for later.

## Outside contributions

- **Triggered by:** a pull request from outside the maintainers that touches `.github/`, `package.json` or the lock
  file, `scripts/`, a test's expectations, this file or the verify skill.
  - [ ] Read every line; nothing reaches the network, secrets or the release, and no check got looser. Run it only in
        CI or a throwaway container, never on a machine with a real install.
