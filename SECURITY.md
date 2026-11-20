# Security policy

Jessbot runs an AI agent that can browse the web, read mail and act for the people who use it, so security reports are
very welcome.

## Reporting a vulnerability

Please report it privately through GitHub: open the repository's **Security** tab and choose **Report a
vulnerability** (a private security advisory). Don't open a public issue, discussion or pull request for it.

Helpful to include: what an attacker can do, the steps or a proof of concept, the version or commit, and how Jessbot
was set up (Node or Docker, behind a proxy or not, which model provider).

You'll get an answer as soon as the maintainer can, usually within a few days. Once a fix is out, the advisory is
published with credit to you, unless you'd rather stay anonymous.

## Supported versions

Jessbot is an early preview. Only the latest commit on `main` gets security fixes.

## What's in scope

Anything that lets someone do what they shouldn't: get into an account or the setup, read another person's chats,
memories or files, make the agent send, spend, delete or post without the approval it should ask for, reach the
server's local network through the agent's browser or fetches, leak secrets (API keys, mail passwords), or escape the
Library page sandbox. Prompt injection that gets past the approval gates counts. Injection that only changes what the
agent says, with no action behind it, is a known limit (see [docs/SECURITY.md](docs/SECURITY.md)) but still worth a
report if you found a pattern the guards miss.

How Jessbot protects the people who use it, and its known limits, are described in
[docs/SECURITY.md](docs/SECURITY.md).
