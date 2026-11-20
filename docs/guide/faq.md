# Frequently asked questions

Short, honest answers to what a household usually asks before and just after setting Jessbot up. Each answer links to
the guide page with the details.

## What does it cost?

Jessbot itself is free. What costs money is the AI model: your provider (OpenRouter by default) charges for what the
assistant reads and writes, and a little extra for spoken replies, pictures and reading scans. Jessbot has no account
with us and no subscription.

To keep that in check, each person has a weekly budget, $2 by default, which an admin can change per person or group in
Admin → Permissions or on the person's page. A single task that would spend more than its cap stops and asks. You see
your own spending in **You → Usage**, admins see everyone's in **Admin → Usage**, and alerts come as a budget fills up.
See [Models and costs](providers.md) and [People and admin](people-and-admin.md#what-it-may-do).

## Does my data leave my machine?

Your chats, memories, files and settings stay in Jessbot's `data/` folder on your machine. There's no telemetry. What
does leave:

- what you and the assistant send to **your model provider** (the conversation, and the pages or files it's working
  on);
- **web traffic from the assistant's browser** when it looks things up (search engines, the sites it visits, weather and
  map services), and feed checks;
- your **mail and calendar servers**, if you connect them, and **notifications**, which go through your browser's push
  service.

## Can it run fully local, without a cloud model?

Partly. Jessbot works with any OpenAI-compatible endpoint, including a server on your own network such as Ollama or LM
Studio: set the Base URL on the setup page or in Admin → Models. The model needs to support tool calls. Without
OpenRouter you lose spoken replies, making pictures, search of your memories by meaning (it falls back to keyword
search) and the small second-opinion model, and budgets may not count everything. With Ollama, a 7B model is the
smallest that copes, and it needs a 32,768-token context set on the Ollama server (`OLLAMA_CONTEXT_LENGTH=32768`; on an
8 GB graphics card also `OLLAMA_FLASH_ATTENTION=1` and `OLLAMA_KV_CACHE_TYPE=q8_0`): with Ollama's default, it loses
Jessbot's instructions. Local models are slower and less careful than the default one, so expect rough edges. The
assistant's browser still goes out to the internet when it looks things up. See
[Models and costs](providers.md#give-ollama-a-context-of-32768-tokens).

## Can it pay for things on its own?

No. Jessbot has no payment details and no tool that pays. When a step on a website looks like paying, booking, ordering
or subscribing, it stops at an approval card that shows exactly what will happen, and a payment page is handed to you
to complete yourself. The one way around the card is if someone picks **Always allow** on such a card; even then it
asks again whenever the task has read a web page or an email first. Admins see every standing "Always allow" on each
person's page and in the health check, and can revoke it. See [Approvals and safety](approvals-and-safety.md).

## Can it read my email without asking?

Only your own, and only if you connect it. Once you add your mailbox in You → Connections, the assistant can read it
when you ask without asking each time, the same way it reads a web page. Sending mail always stops at an approval card
first. Nobody else in the household can have it use your mailbox, and an admin can turn
Email off for anyone. See [Mail and calendar](mail-and-calendar.md).

## Can other people in the house read my chats?

Not by default. Each person's chats, projects, Library and voice notes are theirs. An admin can read them only if
"Let admins read other people's chats" is turned on; then it's read-only, every chat they open is logged, and you see a
line saying so under your chat box and on your You page. See [People and admin](people-and-admin.md).

## Is it safe to put on the internet?

Not yet. Jessbot is an early preview. Run it on your own computer or home network, or reach it from outside through a
VPN such as Tailscale or WireGuard. If other devices reach it through a reverse proxy, use HTTPS and set `PUBLIC_URL`
(see [INSTALL.md](../INSTALL.md#behind-a-reverse-proxy)). Do turn on two-step sign-in for admins
([People and admin](people-and-admin.md#signing-in-safely)).

## Is there a phone app?

Not yet: a mobile app is planned for later. Today you use it in your phone's browser, which gets a phone layout with
tabs at the bottom. Alarms, reminders and messages can reach the phone as notifications while Jessbot is closed too, if
you reach it over HTTPS and the phone's browser supports web notifications (see
[Troubleshooting](troubleshooting.md#notifications-dont-arrive)).

## What languages does it speak?

The interface is in English only for now. The assistant itself reads and writes many languages, including
right-to-left ones such as Arabic, and right-to-left text is shown the right way round.

## Can I rename the assistant?

Yes. Every Jessbot starts as Jess, and you can give yours its own name, look and tone at setup or later in
**Admin → Identity**. See [Name and look](name-and-look.md).

## What happens if I lose everything on the computer?

Jessbot makes a full backup every day and keeps a week of them in `data/backups/`, but on the same disk. Copy them, and
your `.env` file, somewhere else now and then. See [Backups and updates](backups-and-updates.md).

## Does it work with Telegram, WhatsApp or MCP tools?

Not yet. Messaging channels (Telegram first) and MCP tools are on the list for later.

## Who made it? Is it written by AI?

Jessbot is designed by its maintainer, and most of its code is written with Claude Code, Anthropic's coding tool, from
the maintainer's plans and decisions. Every change is checked by running Jessbot for real. The details, area by area,
are in [AI-DECLARATION.md](../../AI-DECLARATION.md).

## What's the licence?

Jessbot is free software under the GNU General Public License, version 3 or (at your option) any later version
(GPL-3.0-or-later). See [LICENSE](../../LICENSE), and [NOTICE.md](../../NOTICE.md) for the third-party work it uses.

Related: [Guide index](README.md) · [Getting started](getting-started.md) · [Models and costs](providers.md) ·
[Approvals and safety](approvals-and-safety.md) · [People and admin](people-and-admin.md) ·
[Backups and updates](backups-and-updates.md) · [Troubleshooting](troubleshooting.md)
