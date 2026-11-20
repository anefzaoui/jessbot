// Launching a browser as a server we hold on to (decision #218): Chromium's own shutdown can hang on some systems (seen on
// Windows with Chromium, Chrome and Edge alike), and a server can always be stopped by killing its process. Its control
// socket listens on 127.0.0.1 only. Used by the Chromium-family engines, with playwright-core or patchright-core.
const servers = new WeakMap();

// No UDP from WebRTC outside a proxy: a page's peer connection or mDNS socket can't reach the network, and no firewall
// prompt pops up on a desktop for a browser that has no firewall rule of its own.
export const COMMON_ARGS = ['--webrtc-ip-handling-policy=disable_non_proxied_udp'];

/** lib: playwright-core's or patchright-core's `chromium`. Returns a connected Browser. */
export async function launchViaServer(lib, options) {
  const server = await lib.launchServer({ headless: true, ...options, host: '127.0.0.1', args: [...COMMON_ARGS, ...(options.args || [])] });
  const browser = await lib.connect(server.wsEndpoint());
  servers.set(browser, server);
  return browser;
}

/** Stop a browser launched above for good (its process, not just our connection to it). */
export async function stopServer(browser) {
  const server = servers.get(browser);
  servers.delete(browser);
  await browser.close().catch(() => {}); // a connected browser: this only disconnects
  await server?.kill().catch(() => {});
}
