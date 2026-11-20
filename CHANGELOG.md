# Changelog

What changed in each release of Jessbot. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [Semantic Versioning](https://semver.org/) (while it is 0.x, a minor version can change how things work;
the notes say so). How releases are made: [docs/RELEASING.md](docs/RELEASING.md).

Each release starts with **Highlights**: a few plain lines for the people who use it. After an update, the admin finds
them as a draft in Admin → System → What's new, edits them if they like and publishes them; everyone then sees them once
in their chat.

## [Unreleased]

### Highlights

- Jessbot is a self-hosted assistant for a household: chat with it, and it carries on with tasks in the background.
- It asks before it sends, books, pays or shares anything, and shows you exactly what it will do.
- It reads the web with its own browser, writes you a daily Feed, and keeps your files in a Library.
- Mail, calendar, shopping lists, reminders and goals are shared by the household or kept private, person by person.
- Give it any name and look, and use OpenRouter, Ollama on your own computer, or another AI service.

### Added

- A translation layer for the interface (English first; right-to-left ready): docs/TRANSLATING.md.
- Chat with tools and background tasks that carry on when the page is closed; approvals with the full text of every
  outgoing action.
- An agent browser (open-source Chromium, or the installed Google Chrome) behind a guard proxy, in Chromium's sandbox.
- The Feed, Goals and ideas, the Library (pages, office files, PDFs), lists, reminders, mail and calendar.
- People, groups and permissions; two-step sign-in, password reset links; per-person weekly budgets.
- The assistant's own name, pronouns, avatar, background and cover.
- Model providers: OpenRouter, Ollama, or any OpenAI-compatible service.
- Docker image and compose file, a systemd unit, install guides for Windows, macOS and Linux. The image runs Node.js
  26 (the current LTS); a Node.js install needs 26, or 24.19 or newer.
- The project site, with the user guide and screenshots: https://anefzaoui.github.io/jessbot/. Its home page is "Jess's
  day": Jess in her sky through four hours of a day, what she does at each, one real run with its timeline, and the
  install; the guide, the gallery and the 404 share its look.
- The site is calmer: the home page's headline no longer swells from thin to heavy as it loads (it's there, still, from
  the first frame), the pictures fade up as they arrive, her line arrives like a message, and changing the hour never
  moves the page; the type, buttons and links of the whole site are steadier.

### Security

- Saved passwords, two-step seeds, the model key and browser sign-ins are encrypted with a per-install key that can be
  rotated (`npm run secrets:rotate`).
- Outside content (pages, mail, files) is fenced and screened for instructions aimed at the assistant; see
  [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md).
- The last code-scanning findings are fixed or explained: addresses are cleaned in linear time, and site-icon badges
  are served with a strict content policy.
