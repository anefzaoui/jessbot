// Launching a browser as a server we hold on to (decision #218): Chromium's own shutdown can hang on some systems (seen on
// Windows with Chromium, Chrome and Edge alike), and a server can always be stopped by killing its process. Its control
// socket listens on 127.0.0.1 only. Used by the Chromium-family engines, with playwright-core or patchright-core.
const servers = new WeakMap();

// No UDP from WebRTC outside a proxy: a page's peer connection or mDNS socket can't reach the network, and no firewall
// prompt pops up on a desktop for a browser that has no firewall rule of its own.
export const COMMON_ARGS = ['--webrtc-ip-handling-policy=disable_non_proxied_udp'];

// ---- Chromium's sandbox (#37, docs/SECURITY-MODEL.md → Browser sandbox) ---------------------------------------------------
// Playwright and Patchright launch Chromium with --no-sandbox unless asked otherwise, and CloakBrowser adds it itself. The
// sandbox keeps a page that breaks the renderer inside a process that can't read files or start programs, so it is on
// wherever the system allows it. JESSBOT_BROWSER_SANDBOX:
//   auto (default) — on; if this system can't start it (Linux without unprivileged user namespaces, running as root, a
//                    container's default seccomp profile), the browser starts without it and Admin → Browser and
//                    Admin → System say so, with the reason;
//   on             — on, or the browser doesn't start (for installs that must never run without it);
//   off            — never (as before #37).
const MODES = ['auto', 'on', 'off'];
export function sandboxMode() {
  const v = String(process.env.JESSBOT_BROWSER_SANDBOX || 'auto').trim().toLowerCase();
  return MODES.includes(v) ? v : 'auto';
}

// What Chromium prints when its sandbox can't start (Linux; Windows and macOS don't fail this way in practice).
const SANDBOX_FAILURE = /no usable sandbox|running as root without --no-sandbox|setuid sandbox|zygote|credentials\.cc|namespaces? (?:sandbox|are not supported)|move to new namespace|sandbox_linux/i;
/** A short reason when a launch error is the sandbox failing to start, else null. */
export function sandboxFailure(message) {
  const m = String(message || '');
  if (!SANDBOX_FAILURE.test(m)) return null;
  if (/running as root/i.test(m)) return 'Jessbot runs as root, and Chromium won’t sandbox itself as root';
  if (/no usable sandbox|namespace|credentials\.cc/i.test(m)) return 'this system doesn’t let programs create user namespaces (or a container blocks it)';
  return 'Chromium couldn’t start its sandbox on this system';
}

let state = null; // the last launch: all of Jessbot's browsers run on the same system
/** Whether the browser last launched with its sandbox: { on, mode, reason }, or null before the first launch. */
export const sandboxState = () => state;

/** launch(sandbox: boolean) → Browser, with the sandbox when this mode and system allow it (see above). */
export async function withSandbox(launch, label = 'Chromium') {
  const mode = sandboxMode();
  if (mode === 'off') {
    const b = await launch(false);
    state = { on: false, mode, reason: 'switched off (JESSBOT_BROWSER_SANDBOX=off)' };
    return b;
  }
  try {
    const b = await launch(true);
    state = { on: true, mode, reason: null };
    return b;
  } catch (err) {
    const reason = sandboxFailure(err?.message);
    if (!reason) throw err;
    state = { on: false, mode, reason };
    if (mode === 'on') throw new Error(`Chromium’s sandbox can’t start here (${reason}), and JESSBOT_BROWSER_SANDBOX=on doesn’t allow running without it. See docs/SECURITY-MODEL.md → Browser sandbox.`);
    console.warn(`[browser] ${label} can't use its sandbox here (${reason}); starting it without. See docs/SECURITY-MODEL.md → Browser sandbox.`);
    return launch(false);
  }
}

/** lib: playwright-core's or patchright-core's `chromium`. Returns a connected Browser. */
export async function launchViaServer(lib, options, label = 'Chromium') {
  return withSandbox(async sandbox => {
    const server = await lib.launchServer({ headless: true, ...options, chromiumSandbox: sandbox, host: '127.0.0.1',
      args: [...COMMON_ARGS, ...(options.args || [])] });
    const browser = await lib.connect(server.wsEndpoint());
    servers.set(browser, server);
    return browser;
  }, label);
}

/** Stop a browser launched above for good (its process, not just our connection to it). */
export async function stopServer(browser) {
  const server = servers.get(browser);
  servers.delete(browser);
  await browser.close().catch(() => {}); // a connected browser: this only disconnects
  await server?.kill().catch(() => {});
}
