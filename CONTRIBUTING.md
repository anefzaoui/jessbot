# Contributing to Jessbot

Thanks for wanting to help. Jessbot is an early preview, so bug reports with clear steps are as valuable as code.

## Before you start

- Read [README.md](README.md), then [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (how the parts fit and the build
  history), [docs/SECURITY.md](docs/SECURITY.md) (what the safety controls are and why) and, for anything you see on
  screen, [docs/UI.md](docs/UI.md) and [docs/DESIGN.md](docs/DESIGN.md).
- [docs/DECISIONS.md](docs/DECISIONS.md) records why things are the way they are. Search it before changing a behaviour
  that looks odd: it was usually a deliberate choice.
- For anything bigger than a bug fix, open an issue first and describe what you want to change. It saves you from
  building something that doesn't fit.
- Security problems: don't open a public issue. See [SECURITY.md](SECURITY.md).
- Questions and where to ask them: [SUPPORT.md](SUPPORT.md). Everyone taking part follows the
  [Code of Conduct](CODE_OF_CONDUCT.md).

## Set up a development copy

You need Node.js 24.19 or newer (`node --version`).

```bash
npm install
cp .env.example .env        # add a model key if you want to chat (it moves into data/, encrypted, at the first start)
npm run build               # fonts, icons, CSS
npm run dev                 # http://127.0.0.1:3738, its own data in data/dev, restarts when src/ changes
npm run css:watch           # in a second terminal, when you change templates or styles
```

The dev server keeps its data in `data/dev`, so it never touches an install you use day to day (which runs on port
3737 with `data/`). On first start the server log prints a setup code; the setup page asks for it.

## Project conventions

- Node 24 ESM, Express 5, express-handlebars (`.hbs`), Tailwind v4 CLI, the built-in `node:sqlite`.
- Every page is its own Express route. Logic lives in `src/services/`; web routes and `/api/v1` both call services.
- Database changes are a new `src/db/migrations/NNN_name.sql` (or `.js` with `up()`). Never edit one that has shipped:
  applied migrations are checksummed and a changed one stops the server. See [docs/DATABASE.md](docs/DATABASE.md).
- Icons: `{{icon "name"}}` with Jessbot's icon names; `scripts/icon-map.js` maps them to Phosphor, and
  `npm run assets` fails on a name it can't map.
- All browser-side JS and CSS is written in this repo: no front-end frameworks, no CDNs. Server-side libraries are fine
  (look for a maintained one before writing your own).
- Content can be right to left (Arabic): use logical CSS properties (`margin-inline-start`, not `margin-left`).
- Nothing is fire-and-forget: every action shows pending, then success or an error with a way out, and runs survive a
  page refresh.
- Fix root causes rather than patching symptoms, and keep producers and consumers of a data shape in step (a route, the
  service behind it, the template and the client JS that reads it).
- Record a meaningful decision in `docs/DECISIONS.md` (next free number) and in the code that carries it out.
- Never commit secrets. `.env`, `data/` and `tools/` are git-ignored. Test data uses made-up people and `example.com`,
  `.test` or `.example` addresses.

## Checks before a pull request

| Command | What it covers | Needs |
|---|---|---|
| `npm run lint` | A syntax check of every JavaScript file | nothing |
| `npm test` | Unit and integration tests (Node's test runner, throwaway data folders, fake model servers); the real-render tests need `npm run browser:install` | nothing |
| `npm run test:e2e` | Setup, sign-in, invites, two people sharing a list, feed topics, in a real headless browser | Chrome, Edge or Chromium installed |
| `npm run ui:flows` / `npm run ui:check` | UI interaction checks and a screenshot sweep with console-error checks | `npm run dev` running |
| `npm run test:chat` | The chat core against a real model (a few cheap calls), plus mail and calendar when the test servers are installed | a model key in `.env`; internet |
| `npm run eval:agent` | Eleven household questions answered end to end by the real agent ([docs/EVAL.md](docs/EVAL.md)) | a model key |

CI runs `npm run lint`, `npm test` (Linux, Windows and macOS) and `npm audit --audit-level=high` on every pull request,
plus CodeQL; Dependabot opens weekly update pull requests. Run `npm test` yourself for every change, the e2e and UI checks for anything you can see, and `test:chat` for changes to the
agent, its tools or prompts. A flaky test is a bug: find why it fails, don't re-run it until it passes.

Mail and calendar tests use two local servers under the git-ignored `tools/test-servers/`: GreenMail
(`greenmail-standalone.jar`, needs Java) and Radicale (`python -m venv tools/test-servers/radicale-venv`, then
`pip install radicale` in it). `npm run test:chat` starts both when they are present and skips those checks when not.

## Pull requests

- One topic per pull request, with a description of what changed and how you checked it. Screenshots for anything
  visible (light and dark, and a phone width when layout changed).
- Keep the docs current in the same pull request: the feature list, the API notes, the decision log, and a line under
  `[Unreleased]` in CHANGELOG.md (plus a plain `Highlights` line for anything people would notice; see
  docs/RELEASING.md).
- By contributing you agree that your contribution is licensed under the project's licence, GPL-3.0-or-later.
- AI-assisted contributions are welcome. Say so in the description and keep the `Co-Authored-By` lines your tool adds.
