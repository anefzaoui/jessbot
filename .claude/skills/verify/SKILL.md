---
name: verify
description: How to verify a change to Jessbot for real before it's called done or merged - isolation (own port and data folder, never the owner's instance), lint and tests, a fresh instance in a real browser, the e2e and chat checks with the mail and calendar test servers, Docker for install changes, screenshots, and cleaning up. Use before every commit you call finished, before opening or merging a pull request, and in every agent brief ("follow the verify skill").
---

# Verify a change to Jessbot

Unit tests aren't proof that a feature works. A change is verified when it ran the way a person uses it, on a fresh
instance of its own, and the evidence (commands, numbers, log lines, screenshots) is written in the pull request. Check
what the diff touches against [REVIEW.md](../../../REVIEW.md) as well.

## 0. Isolation first, every time

- Work in your own clone or git worktree (`git worktree add <dir> -b <branch> origin/main`), never in a checkout
  someone else is using, and never in the folder of a running install. Never `git stash` in a shared repository.
- **Never the owner's instance.** Don't open, sign in to, restart or stop a Jessbot you didn't start, don't touch its
  `data/` or `.env`, and don't use the ports 3737 (the normal server), 3738 (`npm run dev`) or 3000.
- **Every instance you start gets its own port and its own data**, all three set, every time:

  ```bash
  export PORT=$((4200 + RANDOM % 600))                 # not 3737, 3738 or 3000; check it's free first
  export JESSBOT_HOME="$(mktemp -d)"                   # a throwaway data folder
  export JESSBOT_ENV_FILE="$JESSBOT_HOME/.env"         # without it the server reads, and rewrites, the repo's .env
  export JESSBOT_SETUP_CODE=verify-setup-code          # a known setup code for the first admin
  NODE_ENV=development node server.js > "$JESSBOT_HOME/server.log" 2>&1 &
  ```

  A model key goes in as `OPENROUTER_KEY` in the environment (used, never stored), not in a `.env` you copied. The
  e2e and chat scripts already do all of this themselves (random port, `mkdtemp` folder); a script or test you add must
  too (`tests/helpers/listen.js` for test servers).
- Test data is made up: invented people, `example.com` / `.test` addresses, keys that are obviously fake.
- Outside contributors' code runs only in CI or a throwaway container, never on a machine with a real install.

## 1. Cheap checks (before any push)

```bash
npm run lint                         # syntax of every JavaScript file
npm test                             # unit and integration tests (throwaway folders, fake model servers)
node --test tests/<file>.test.js     # the area you changed, while you work
npm run build                        # after changing templates, styles or icons (fails on an unknown icon name)
npm audit --audit-level=high         # after changing dependencies
```

A test that fails now and then is a bug: never re-run it until it passes, never add a sleep or skip it. Find why (a
time of day, a fixed delay, a shared port), or delete it and say why in the pull request.

## 2. Run it for real

Pick what the diff touches:

| The change touches | Run |
|---|---|
| a page, a template, styles or client JS | a fresh instance (step 0) in a real browser: set it up with the known code, sign in, do what the change does, as an admin and as a member; `node scripts/ui-check.js --base http://127.0.0.1:$PORT --only <pages>` (light and dark, desktop and phone, fails on console errors); `node scripts/ui-flows.js --base http://127.0.0.1:$PORT` |
| setup, sign-in, invites, people, permissions | `npm run test:e2e` (its own server and folder, a real headless browser) |
| the agent, its tools, prompts or skills | `npm run test:chat` (a few cheap real model calls; `E2E_ONLY=<check>` for one part); `npm run eval:agent` for a change to how it answers |
| mail or calendar | `npm run test:chat` **with** GreenMail and Radicale installed under `tools/test-servers/` (CONTRIBUTING.md says how); without them those checks are skipped, and that is a "Not verified" |
| outside content, fences, approvals, the browser's guard | the tests for that path with hostile input (an instruction in a page, a fence look-alike, a private address), and a run in the fresh instance that reads such content and shows the approval card |
| a model provider | the provider for real: Ollama in a container, or the service itself; the setup step and Admin → Models |
| installing: Dockerfile, compose.yaml, deploy/, INSTALL.md | Docker with a project name and port of its own: `JESSBOT_PORT=$PORT docker compose -p jessbot-verify-$PORT up -d --build`, the setup code from `docker compose -p jessbot-verify-$PORT logs jessbot`, then `down -v` |
| releases, CHANGELOG parsing | `npm run release -- <version> --dry-run` on a throwaway branch; never `--tag`, never push a tag |
| security-sensitive code | the hostile input in a test, and CodeQL's result on the pull request (fixed or explained in the description) |
| docs only | every link and anchor resolves; every feature, setting and menu name it mentions exists in the code under that name |

Write down what you ran and what you saw: commands, numbers, log lines, before and after.

## 3. Screenshots

Everything visible: before and after, light and dark, and a phone width (390 px) when the layout changed. Use the
fresh instance or the styleguide's demo household, with made-up people only; nothing from a real install. `ui-check.js
--out <dir>` takes the standard set. A change with nothing to see shows its proof (test output, logs) instead and says
so.

## 4. Say what was and wasn't verified

The pull request's description ends its "How it was checked" part with two lines:

```
Verified: <how: a fresh instance in Chromium / test:e2e / test:chat with GreenMail and Radicale / Docker compose / tests only>
Not verified: <what wasn't: a system, a provider, a phone, the mail servers, a real host> (or "nothing left")
```

## 5. Three strikes

If the same check fails three rounds in a row, stop: report what you tried, what you saw and what you think is wrong,
and ask. No fourth blind attempt.

## 6. Clean up

Stop every server you started by its process ID (look it up from your port), never by a command-line pattern: the
owner's Jessbot may be running on the same machine. Stop GreenMail, Radicale and any Ollama container you started,
`docker compose -p jessbot-verify-$PORT down -v`, close the browsers you opened, delete your `JESSBOT_HOME` folder and
`ui-shots/`, and leave the worktree clean.
