# Roadmap

What's done before Jessbot's first release, what's being worked on, and what's planned. Each item links to its issue
where there is one; the details and the discussion are there. What each release changed is in
[CHANGELOG.md](CHANGELOG.md), why things are the way they are in [docs/DECISIONS.md](docs/DECISIONS.md), and every
feature with its status in [docs/FEATURES.md](docs/FEATURES.md). Bug reports and ideas are welcome in
[Issues](https://github.com/anefzaoui/jessbot/issues).

✅ done · 🔄 being worked on · 📋 planned · 🔍 looking into it

Jessbot is an early preview: run it at home or on a private network, not on the open internet yet (see
[What's missing before a 1.0](README.md#whats-missing-before-a-10)).

## Done

### The assistant

- ✅ Chat with tools, and background tasks that carry on when the page is closed and survive a refresh or a restart
- ✅ Approvals that show the full text of every outgoing action: it asks before it sends, books, pays or shares
- ✅ Runs that finish and tell the truth: restart recovery, one automatic retry, reply checks, dead-end detection,
  spending limits per task and per person per week
- ✅ Memory that works as documented: recall by meaning in any language, dated memories, past conversations, lessons,
  a weekly tidy you can undo
- ✅ Projects: one continuous chat per project, with its brief, its files and its own expertise
- ✅ Voice notes in and spoken replies out
- ✅ Skills: 90 household skills and the built-ins, skills the assistant drafts and the admin approves
- ✅ The assistant's own name, pronouns, avatar, background and cover, everywhere in the interface
  ([#7](https://github.com/anefzaoui/jessbot/issues/7))
- ✅ Model providers: OpenRouter, Ollama on your own computer, or any OpenAI-compatible service, with a picker; features
  a provider can't serve are switched off and say so ([#11](https://github.com/anefzaoui/jessbot/issues/11))

### The web, the household and the files

- ✅ Its own browser: open-source Chromium by default, the installed Google Chrome where there is one, behind an
  interface for other engines ([#1](https://github.com/anefzaoui/jessbot/issues/1))
- ✅ Research and the web: reading PDFs, feeds, videos' captions and threads, searches by intent, ready-made searches,
  look-alike site warnings, optional ad blocking
- ✅ The Feed, Goals and ideas, reminders and alarms, shared and private lists, weather and holidays
- ✅ Mail (IMAP and SMTP) and calendars (CalDAV), sending only behind an approval
- ✅ The Library: pages, office files and PDFs with versions, previews and forms

### People and accounts

- ✅ People, groups and permissions; per-person instructions and budgets
- ✅ Admin access to other people's chats is a setting, off by default
  ([#2](https://github.com/anefzaoui/jessbot/issues/2))
- ✅ Two-step sign-in, password changes and reset links, stronger password hashing, rate limits that survive a restart
  ([#6](https://github.com/anefzaoui/jessbot/issues/6))
- ✅ Coming back to an unfinished setup signs you in instead of looping
  ([#50](https://github.com/anefzaoui/jessbot/issues/50))

### Security

- ✅ Outside content (pages, mail, files, feeds, background reports) is fenced and screened for instructions aimed at
  the assistant; a review of every untrusted input closed the gaps it found
  ([#8](https://github.com/anefzaoui/jessbot/issues/8), [#40](https://github.com/anefzaoui/jessbot/issues/40)); the
  model is in [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md)
- ✅ Outbound requests: the private-address guard is pinned to the address it checked, and the browser goes through a
  guard proxy that resolves names itself ([#9](https://github.com/anefzaoui/jessbot/issues/9))
- ✅ Saved passwords, two-step seeds, the model key and browser sign-ins are encrypted at rest with a per-install key
  that can be rotated ([#10](https://github.com/anefzaoui/jessbot/issues/10))
- ✅ Origin checks follow `PUBLIC_URL` behind a reverse proxy
  ([#12](https://github.com/anefzaoui/jessbot/issues/12))
- ✅ The browser runs in Chromium's sandbox wherever the system allows it, and Admin → Browser says when it can't
  ([#37](https://github.com/anefzaoui/jessbot/issues/37))
- ✅ Code scanning (CodeQL) on every pull request; all but the last few alerts fixed or explained
  ([#22](https://github.com/anefzaoui/jessbot/issues/22))

### Installing, releasing and the project

- ✅ Install everywhere: Docker (amd64 and arm64) and compose, Node.js, a systemd unit, guides for Windows, macOS and
  Linux ([#3](https://github.com/anefzaoui/jessbot/issues/3))
- ✅ CI on Linux, Windows and macOS, Dependabot and a dependency-audit gate
  ([#4](https://github.com/anefzaoui/jessbot/issues/4)); every dependency brought current
  ([#5](https://github.com/anefzaoui/jessbot/issues/5))
- ✅ CHANGELOG.md, `npm run release` and a release workflow; What's new in the app comes from the changelog
  ([#13](https://github.com/anefzaoui/jessbot/issues/13))
- ✅ A scheduled task whose retry is pending doesn't also fire its next occurrence (found by a test that failed only near
  07:00) ([#57](https://github.com/anefzaoui/jessbot/issues/57))
- ✅ The user guide, the logo, screenshots of every screen and the project site:
  [anefzaoui.github.io/jessbot](https://anefzaoui.github.io/jessbot/)
- ✅ The site's home page redone as "Jess's day": Jess in her sky through a day, one real run, the install; the guide,
  gallery and 404 in the same look
- ✅ The site refined: a still headline, short and eased motion that respects reduced motion, steadier type and spacing,
  no layout shift between the hours
- ✅ The site's screenshots open in [Vitrine](https://github.com/anefzaoui/vitrine), the owner's own lightbox (decision #251): they fly from their place and back, go through
  their group by keys and swipes, zoom and pan, close by Back too; light and dark, reduced motion, no layout shift
- ✅ Node.js 26 (the current LTS) in the Docker image and in CI next to 24; playwright-core and patchright-core kept in
  step, moving together when Patchright follows Playwright ([#43](https://github.com/anefzaoui/jessbot/issues/43))

## Being worked on

- 🔄 The last CodeQL alerts: fix the real ones, explain the rest, then close the issue
  ([#22](https://github.com/anefzaoui/jessbot/issues/22))
- 🔄 Small mismatches between the docs and the code found while writing the user guide: backups and the `.env` file,
  where the model settings live, the `HOST` advice, an empty state's advice and a label ([#55](https://github.com/anefzaoui/jessbot/issues/55))
- 🔄 Translations: a translation layer for the interface and the first languages (the assistant already reads and
  writes many, right to left included) ([#14](https://github.com/anefzaoui/jessbot/issues/14))

## Planned

- 📋 The first tagged release, 0.1.0, with its container image
- 📋 Install Jessbot on a phone's home screen as an app (a web app manifest; the icons are ready), part of
  [#55](https://github.com/anefzaoui/jessbot/issues/55)
- 📋 A published container image for every release, and a Windows installer
- 📋 Prices for model services other than OpenRouter, so budgets can count their spending
- 📋 Voice and pictures with local models
- 📋 Messaging channels, Telegram first
- 📋 MCP tools
- 📋 A mobile app (the `/api/v1` JSON API is built for it)
- 📋 Marketplace and social lookups through the browser

## Looking into it

These are the known limits listed in [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md#what-is-not-defended); each is
mitigated today, not solved.

- 🔍 Time in real use and outside review before Jessbot is recommended on the open internet
- 🔍 Text inside pictures and screenshots reaches the model unscreened
- 🔍 The instruction detector is a set of patterns in five languages; paraphrases and other languages rely on the fence
- 🔍 Hidden-text removal covers the usual tricks, not text in images, canvas, iframes or shadow DOM
- 🔍 Chromium's sandbox on Ubuntu 23.10 and later, checked on a real host
