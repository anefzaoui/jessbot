# Notices and credits

Jessbot is free software under the GNU General Public License, version 3 or (at your option) any later version. See
[LICENSE](LICENSE). This page lists the third-party work it ships with or builds from, under their own licences.

## Bundled at build time

`npm run build` copies these from `node_modules` into `public/` (they are not stored in this repository):

| What | Package | Licence |
|---|---|---|
| Phosphor icons (the icon sprite) | `@phosphor-icons/core` | MIT |
| Geist (the interface font) | `@fontsource-variable/geist` | SIL Open Font License 1.1 |
| Noto Sans Arabic | `@fontsource-variable/noto-sans-arabic` | SIL Open Font License 1.1 |

The server embeds these fonts in the documents and PDFs it makes: Noto Sans, Noto Serif and Noto Naskh Arabic
(`@fontsource/noto-sans`, `@fontsource/noto-serif`, `@fontsource/noto-naskh-arabic`) and STIX Two Math
(`@fontsource/stix-two-math`), all under the SIL Open Font License 1.1. Code highlighting uses `highlight.js`
(BSD-3-Clause) and math uses `temml` (MIT).

Every other dependency is listed in `package.json` and keeps its own licence (MIT, Apache-2.0, BSD, ISC or MPL-2.0;
`npm ls` and each package's `LICENSE` file have the details). The ad and cookie-banner blocking uses
`@ghostery/adblocker` and `@duckduckgo/autoconsent` (both MPL-2.0); PDF rendering uses `pdfjs-dist` (Apache-2.0); the
browser is driven by `playwright-core` (Apache-2.0) and, with the installed Google Chrome, by `patchright-core`
(Apache-2.0). Google Chrome itself is only used where the person installed it; Jessbot never downloads or ships it.
`deploy/seccomp-chromium.json` is Docker's default seccomp profile (`moby/profiles/seccomp/default.json`, Apache-2.0,
© Docker, Inc. and the Moby authors) with one rule added by `scripts/seccomp-profile.js`.

## Skills adapted from other projects

Some skills in `skills/` are adapted from public skill collections. Each of those folders has a `NOTICE.md` naming its
source and the changes, and a `LICENSE.txt` where the licence asks for one. They stay under their original licences
(Apache-2.0 or MIT), which are compatible with the GPL.

## Design skills for contributors

`.claude/skills/` holds design guidance used while developing Jessbot (not part of the running app):
`impeccable` (Apache-2.0, with its NOTICE.md) and `taste-skill` / `redesign-skill` (MIT). See
[.claude/skills/README.md](.claude/skills/README.md).

## Images

The avatar portraits, the sky scenes and the demo covers in `public/img/` were generated for Jessbot with an
image model (OpenAI's image models through OpenRouter) from text prompts written for this project, using
`scripts/generate-avatars.js`. No photographs of real people or stock images were used as input; the prompts, models
and costs are recorded in `assets/*/manifest.json`. They are distributed with Jessbot under the same licence as the
rest of the repository.

The logo files in `docs/images/brand/` are made from the same portrait and night-sky scene by
`scripts/build-brand.js` (cropping, layering and resizing only, no new generation); the wordmark sets "Jessbot" in
Geist (SIL Open Font License 1.1).

## Optional software Jessbot can use

These are not included. If you install them, their own licences apply:

- **CloakBrowser** (a stealth Chromium build). Its npm wrapper (`cloakbrowser`, MIT) is a dependency, but the browser
  binary it downloads is proprietary: it is downloaded per install into `tools/`, never committed or redistributed, and
  its terms cover internal use (yourself, your family, your company), not offering it as a service to others.
- **LibreOffice** (MPL-2.0) for page pictures of office files, **SearXNG** (AGPL-3.0) as a private search engine,
  **GreenMail** and **Radicale** as local mail and calendar servers for the test suite.
