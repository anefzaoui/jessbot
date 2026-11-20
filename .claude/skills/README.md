# Skills

`verify/` is Jessbot's own: how to check a change for real before it's called done (isolation, tests, a fresh
instance in a real browser, the e2e and chat checks, Docker, cleanup). The others are vendored design skills.

## Design skills (vendored)

Owner decision (2026-09-26): UI work in Jessbot follows these two skills. Copied here so every session (and every
agent working on the repo) loads them; see `docs/DESIGN.md` for how they were applied and `docs/DECISIONS.md` #116.

| Skill | Source | Version | Licence |
|---|---|---|---|
| `impeccable/` | https://github.com/pbakaus/impeccable (`.agent/skills/impeccable`) | 4.4.0 @ `9d715cc` | Apache-2.0 (+ NOTICE.md) |
| `taste-skill/` | https://github.com/Leonxlnx/taste-skill (`skills/taste-skill`) | @ `c184364` | MIT |
| `redesign-skill/` | same repo (`skills/redesign-skill`) | @ `c184364` | MIT |

Trimmed: impeccable's `scripts/` (its launcher downloads a binary; the live-browser tools inject third-party JS).
Its SKILL.md already covers this: "Launcher unavailable" → read the project context directly. Here that is
`docs/PRODUCT.md` (who and what) and `docs/DESIGN.md` (the visual system); `docs/UI.md` holds components and rules.

## How they apply here

- **Mode:** Jessbot is impeccable's **Operate** mode (an app you work in). Impeccable leads the direction; taste-skill's
  redesign audit and its "AI tells" list are the checklist (taste-skill itself says it is for landing pages, not apps).
- **Project rules win** where a skill conflicts with `CLAUDE.md`: all browser JS/CSS is in-house (ignore suggestions to
  install shadcn, Motion, GSAP, icon packages at runtime, CDNs or Google Fonts); icons come from Phosphor through
  `scripts/icon-map.js`; fonts are self-hosted.
- **Jess is the brand.** Her living avatar and night-sky scene are preserved, not "redesigned".
