# Getting help

Jessbot is an early preview, run by one maintainer. Here's where to look and where to ask.

## Read first

- **[The user guide](https://anefzaoui.github.io/jessbot/docs/)** (also in [docs/guide](docs/guide/README.md)): setup,
  models and costs, the assistant's name and look, approvals and safety, mail and calendar, the Feed, the Library,
  people and admin, backups and updates.
- **[Troubleshooting](docs/guide/troubleshooting.md)**: the common problems with a new install, with what you'll see and
  how to fix each. Start with the health check: `npm run doctor` on the server, or Admin → System.
- **[FAQ](docs/guide/faq.md)**: costs, privacy, and what the assistant can and can't do.
- **[Installing](docs/INSTALL.md)**: Docker, Node.js and systemd, on Linux, Windows and macOS.

## Ask

- **Something doesn't work**: open a [bug report](https://github.com/anefzaoui/jessbot/issues/new?template=bug.yml).
  It asks for your system, how Jessbot was installed, its version and the log, which is usually what it takes to find
  the cause.
- **An idea**: open a [feature request](https://github.com/anefzaoui/jessbot/issues/new?template=feature.yml). Look
  at [ROADMAP.md](ROADMAP.md) first; what's planned already has an issue you can add to.
- **A question the guide doesn't answer**: open a bug report and say it's a question; the answer goes into the guide
  so the next person finds it there.
- **A security problem**: never in public. [SECURITY.md](SECURITY.md) says how to report it privately.

Answers come as soon as the maintainer can, usually within a few days. Please be kind: see the
[Code of Conduct](CODE_OF_CONDUCT.md).
