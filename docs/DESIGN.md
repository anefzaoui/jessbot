# Jessbot visual system

The design language after the 2026-09-26 redesign (decision #116), built with the impeccable and taste-skill design
skills (`.claude/skills/`). Product context: `docs/PRODUCT.md`. Components, layout and behaviour rules: `docs/UI.md`.
Everything here lives in `src/styles/input.css` as tokens; the live reference is `/styleguide` (dev).

## Direction
**Preserve Jess, rebuild the rest.** Jess's living avatar and night-sky scene are the brand and stay as they are.
Around her, an Operate-mode interface (impeccable): calm, consistent, familiar controls, one accent, state colours
that only mean state. Personality comes from Jess and from precise details, never from decoration.

## Colour: Harbor
Cool slate neutrals (hue 240–245) and one deep sea-teal accent (hue ~205). Chosen over amber (it collided with the
amber "needs you" state) and cobalt (it collided with the blue "running" state).

| Token | Meaning |
|---|---|
| `canvas` | the work area (main column) |
| `chrome` | the frame around it: rail and right panel (one step off the canvas) |
| `surface`, `surface-2`, `surface-3` | cards and inputs; hover wells; tracks and deeper wells |
| `line`, `line-strong` | hairlines; hover and emphasis borders |
| `ink`, `ink-2`, `ink-3` | text: primary, secondary, tertiary (≥ 4.5:1 on canvas) |
| `accent` (+ `-hover`, `-soft`, `-text`, `-ink`) | act here, selected, current, Jess's own work. Never decoration |
| `run` / `ok` / `warn` / `bad` (+ `-soft`) | working / done / waiting on you / failed. Nothing else |

- Dark mode is its own palette, not an inversion: the accent gets lighter and its ink dark (`accent-ink`), so anything
  drawn on the accent (ticks, selection in your bubble) uses `accent-ink`, never white.
- Shadows are tinted with the neutral hue and fall from above; dark mode uses borders instead.
- User-chosen hues (projects) are identity and stay on the project tile; library file types get a quiet tint.
  Everything else defaults to the neutral or the accent, never violet.
- **Counts** (`.count`): accent = new things to look at; `.count-warn` = waiting on you (approvals, a proposed change);
  `.count-quiet` = a plain tally.

## Type
- **Geist Variable** (OFL, self-hosted from `@fontsource-variable/geist`) for everything; Noto Sans Arabic for RTL.
  One family, fixed rem scale, body 15 px, numbers `.tabular`.
- Headings `text-wrap: balance`, paragraphs `pretty`, prose ≤ 65ch.
- **Sentence case everywhere.** No ALL-CAPS labels and no eyebrow/kicker above a heading: a card's category or a
  page's section sits *under* its title as meta (`text-xs text-ink-3`).

## Icons
Phosphor (MIT), regular weight, one stroke family. Code, the database and model tools use Jessbot's own icon names
(historically Lucide names); `scripts/icon-map.js` maps each to a Phosphor glyph, with `:fill` for solid controls
(play, pause, stop), `:flip` for mirrored glyphs and `:toggle` for icons that turn solid when pressed
(`--icon-fill: 1` on an ancestor, e.g. `.feed-act[aria-pressed="true"]`). Unmapped names fail `npm run assets`.
The sparkle means "creating" (an activity) and Jess's personality; it is not decoration on buttons.

## Shape, depth, motion
- Controls `rounded-lg`, cards `rounded-2xl`, badges `rounded-md` (flags, not pills); chips stay pills (filters).
- Cards exist when they group something; they are `min-w-0` so they shrink with their grid column.
- Transitions 150–250 ms on explicit properties; pressed states scale or darken; `prefers-reduced-motion` stops
  ambient motion. The one authored motion is Jess (presence, run glyphs); no page-load choreography.

## Banned (from the skills, enforced in review)
Em-dashes in UI copy · ALL-CAPS labels and eyebrows · coloured left/top stripes on cards · progress rings (use a number
plus `partials/progress-bar.hbs`) · decorative status dots (only real state) · pills over images · sparkles on buttons ·
a grid of identical icon cards as a layout · gradient text · glass as decoration · "X can make mistakes" footers ·
purple/violet defaults · `transition: all`.

## Checks
`npm run ui:check` screenshots every screen at 1440 and 390 px in both themes and fails on console errors, the window
scrolling, **and the main column being wider than the screen** (it names the widest element).

## Logo
The logo is Jess: the default persona's portrait (`public/img/avatars/female/neutral.webp`) over her night sky
(`public/img/scenes/night-clear.webp`), clipped round, the same layering as the living avatar. Small sizes crop toward the
face the way the app's small avatars do. `node scripts/build-brand.js` (`npm run brand`) makes every file in
`docs/images/brand/` from those two images, with no new image generation:

| File | Use |
|---|---|
| `mark-*.webp`, `mark-512.png` | the round mark (README, site, avatars on other services) |
| `mark-square-*.webp`, `icon-192.png`, `icon-512.png` | the rounded-square app icon |
| `icon-maskable-512.png`, `apple-touch-icon.png` | full-bleed icons for launchers and iOS, which cut their own shape |
| `favicon.ico` (16, 32, 48), `favicon-16.png`, `favicon-32.png`, `favicon.svg` | browser tabs |
| `wordmark-light.png`, `wordmark-dark.png` | the mark with "Jessbot" set in Geist, for light and for dark backgrounds |
| `social-preview.png` | 1280×640 link preview (GitHub's repository card) |

Rules: one portrait and one sky everywhere (never a mood frame or another variant in the logo); never recolour, outline
or stretch it; leave clear space of a quarter of the mark's width around it. The name is set in Geist, weight 620,
tracking -0.035em, in `ink` on light and dark backgrounds alike. A renamed or re-dressed install still uses the Jessbot
logo for the project; the app itself shows the look its admin picked.

## Website
The public site (`website/`, built by `scripts/build-site.js`; see `website/README.md`) uses this same world: the
Harbor tokens copied into `website/styles.css` (keep them in step with `src/styles/input.css`), Geist, Phosphor icons
and the approval card's look. It is the one Persuade surface, so it gets one expressive move the app keeps small: the
first viewport is Jess in her sky at full size, with the scene picked from the visitor's clock as in the app, beside a
live copy of a real approval card the visitor can approve or deny. Below that, the page follows one real request
(the recorded run), then the screens, then safety and privacy, then the install. Screenshots switch with the theme
(`.only-light` / `.only-dark`); the docs pages are the guide's Markdown with a menu and an "On this page" list.
