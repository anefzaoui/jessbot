# Installing Jessbot

Jessbot is an early preview. Run it on your own computer or home network, or behind a VPN, and read
[What's missing](../README.md#whats-missing-before-a-10) before you put it on the open internet.

Whichever way you install it, the first start prints a **setup code** in the log. The setup page asks for it when you
create the admin account, so nobody else who reaches the page first can claim your install.

- [Docker (any system)](#docker)
- [Node.js on Linux, with a systemd service](#linux-nodejs-and-a-systemd-service)
- [Node.js on Windows](#windows)
- [Node.js on macOS](#macos)
- [Behind a reverse proxy (HTTPS)](#behind-a-reverse-proxy)
- [Backups, updates and moving](#backups-updates-and-moving)

## Docker

You need Docker with Compose (Docker Desktop on Windows and macOS). The image runs as a non-root user with a read-only
root filesystem; everything Jessbot writes (its database, files, and the `.env` the setup page fills in) lives in the
`jessbot-data` volume. It includes open-source Chromium for the agent's browser.

```bash
git clone <this repository> jessbot && cd jessbot
docker compose up -d --build
docker compose logs jessbot | grep "setup code"
```

Open http://127.0.0.1:3737. The port is published on this machine only; reach it from other devices through a reverse
proxy (below) or a VPN rather than by publishing it on every interface. To use another port on this machine:
`JESSBOT_PORT=3800 docker compose up -d`.

Settings go in `compose.yaml` under `environment` (see [.env.example](../.env.example) for all of them), for example
`PUBLIC_URL` behind a proxy. The container's health is checked every 30 s (`docker compose ps` shows it).

The agent's browser runs in Chromium's sandbox: `compose.yaml` gives the container `deploy/seccomp-chromium.json`
(Docker's default seccomp rules plus the calls the sandbox needs) and no capabilities. With plain `docker run`, pass
`--security-opt seccomp=deploy/seccomp-chromium.json`, or the browser runs without its sandbox and Admin → Browser
says so. Details: [SECURITY-MODEL.md → Browser sandbox](SECURITY-MODEL.md#browser-sandbox).

## Linux: Node.js and a systemd service

You need Node.js 26 (the current LTS) or 24.19 or newer (from [nodejs.org](https://nodejs.org) or your distribution) and git.

```bash
sudo useradd --system --home /var/lib/jessbot --create-home --shell /usr/sbin/nologin jessbot
sudo git clone <this repository> /opt/jessbot && cd /opt/jessbot
sudo npm ci && sudo npm run build && sudo npm prune --omit=dev
# The browser: Chromium and the libraries it needs (Debian/Ubuntu; other distributions: see Playwright's docs).
sudo npx playwright-core install-deps chromium
sudo -u jessbot JESSBOT_HOME=/var/lib/jessbot JESSBOT_TOOLS=/var/lib/jessbot/tools node scripts/browser-install.js --engine chromium
sudo cp deploy/jessbot.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now jessbot
journalctl -u jessbot | grep "setup code"
```

The unit (`deploy/jessbot.service`) runs Jessbot as its own user with a read-only system and only `/var/lib/jessbot`
writable. If Google Chrome is installed on the machine, Jessbot uses it instead of Chromium (Admin → Browser).

Chromium's sandbox needs unprivileged user namespaces. Most distributions allow them; Ubuntu 23.10 and later block them
for programs without an AppArmor profile, so Admin → Browser shows the sandbox as off until you add the profile in
[SECURITY-MODEL.md → Browser sandbox](SECURITY-MODEL.md#browser-sandbox) (or use Google Chrome's `.deb`). Check with
`sudo -u jessbot JESSBOT_TOOLS=/var/lib/jessbot/tools node scripts/sandbox-probe.mjs`.

## Windows

Install Node.js 26 LTS from [nodejs.org](https://nodejs.org) and Git, then in PowerShell:

```powershell
git clone <this repository> jessbot; cd jessbot
npm ci; npm run build
npm start
```

If Google Chrome is installed, the agent's browser is your Chrome (nothing to download); otherwise the setup page
downloads Chromium. To start Jessbot when you sign in, create a scheduled task that runs `node server.js` in the
`jessbot` folder:

```powershell
$a = New-ScheduledTaskAction -Execute (Get-Command node).Source -Argument 'server.js' -WorkingDirectory (Get-Location)
$t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
Register-ScheduledTask -TaskName 'Jessbot' -Action $a -Trigger $t -Description 'Jessbot, a self-hosted household AI agent'
```

(Remove it with `Unregister-ScheduledTask -TaskName Jessbot`.) Node may report a fixed-offset time zone on Windows; set
`JESSBOT_TIMEZONE` in `.env` (for example `Europe/Berlin`) if times look an hour off.

## macOS

Install Node.js 26 LTS ([nodejs.org](https://nodejs.org) or `brew install node@26`), then:

```bash
git clone <this repository> jessbot && cd jessbot
npm ci && npm run build
npm start
```

macOS should work but hasn't been tested by a person yet (CI runs the unit tests on macOS). To keep it running, a
`launchd` agent that runs `node server.js` in the folder works like the Windows scheduled task above.

## Behind a reverse proxy

Put a reverse proxy with HTTPS in front when other devices reach Jessbot, and tell Jessbot the address people use:

```
PUBLIC_URL=https://jessbot.example.org
```

With `PUBLIC_URL` set, invite links use it and Jessbot refuses requests for other host names. A proxy on the same
machine is trusted for the client's address by default (`TRUST_PROXY=loopback`). A minimal Caddy site:

```
jessbot.example.org {
  reverse_proxy 127.0.0.1:3737
}
```

Caddy passes the Host header and WebSocket upgrades as they are. With nginx, pass `Host`, `Upgrade` and `Connection`
(`proxy_set_header Host $host; proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`).

## Backups, updates and moving

- Jessbot makes a full backup a day and keeps a week, in `data/backups/` (the `jessbot-data` volume in Docker).
  `npm run restore` lists and restores them (with Jessbot stopped). Copy the backups somewhere else too.
- To update: `git pull`, then `npm ci && npm run build` (or `docker compose up -d --build`). Database changes are
  applied at start after a backup; a change that fails stops the start instead of half-applying.
- To move an install: stop it and copy the folder with its `data/` (or the Docker volume), and its `.env`.
- **The install key.** Passwords, two-step sign-in seeds and the model key are stored encrypted with a key that is
  not in the backups: `JESSBOT_SECRET` in `.env`, or the file `JESSBOT_SECRET_FILE` names. Keep a copy of it with your
  backups (somewhere else); a backup restored without it keeps everything except those secrets, which then have to be
  entered again. In Docker you can keep it out of the volume entirely with a secret (see `compose.yaml`). To change it:
  `npm run secrets:rotate` with Jessbot stopped ([SECURITY.md → Secrets and data](SECURITY.md#secrets-and-data)).
