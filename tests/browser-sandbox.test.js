// Chromium's sandbox (#37): on wherever the system allows it; auto falls back (and says why) only for a sandbox failure;
// "on" never runs without it; "off" never asks for it. The real browser's sandbox is checked by
// `node scripts/sandbox-probe.mjs` (Windows, macOS, Linux, the Docker image). Run: npm test.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const S = await import('../src/browser/engines/server.js');
const saved = process.env.JESSBOT_BROWSER_SANDBOX;
afterEach(() => { if (saved === undefined) delete process.env.JESSBOT_BROWSER_SANDBOX; else process.env.JESSBOT_BROWSER_SANDBOX = saved; });

// Chromium's own words when its sandbox can't start (Linux), as they reach us in Playwright's launch error.
const NO_USERNS = 'Failed to launch browser.\n[FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:128] No usable sandbox! '
  + 'If you are running on Ubuntu 23.10+ or another Linux distro that has disabled unprivileged user namespaces with AppArmor…';
const AS_ROOT = 'Failed to launch browser.\n[FATAL:zygote_host_impl_linux.cc:128] Running as root without --no-sandbox is not supported.';

test('sandboxFailure: Chromium’s sandbox messages are named; other launch errors are not', () => {
  assert.match(S.sandboxFailure(NO_USERNS), /user namespaces/);
  assert.match(S.sandboxFailure(AS_ROOT), /root/);
  assert.match(S.sandboxFailure('Check failed: sys_chroot("/proc/self/fdinfo/") == 0 … Zygote process exited prematurely'), /couldn’t start its sandbox/);
  assert.equal(S.sandboxFailure('Executable doesn’t exist at /opt/chrome'), null);
  assert.equal(S.sandboxFailure('net::ERR_PROXY_CONNECTION_FAILED'), null);
});

test('mode: auto unless set to on or off', () => {
  delete process.env.JESSBOT_BROWSER_SANDBOX;
  assert.equal(S.sandboxMode(), 'auto');
  for (const [v, m] of [['on', 'on'], [' OFF ', 'off'], ['auto', 'auto'], ['yes', 'auto']]) {
    process.env.JESSBOT_BROWSER_SANDBOX = v;
    assert.equal(S.sandboxMode(), m, v);
  }
});

// A fake launcher: records what it was asked for, fails with `fail` when asked for the sandbox.
const launcher = fail => {
  const calls = [];
  const fn = async sandbox => { calls.push(sandbox); if (sandbox && fail) throw new Error(fail); return { sandbox }; };
  return { fn, calls };
};

test('auto: the sandbox when it starts; without it (and the reason kept) only when the sandbox itself failed', async () => {
  delete process.env.JESSBOT_BROWSER_SANDBOX;
  const ok = launcher(null);
  assert.deepEqual(await S.withSandbox(ok.fn), { sandbox: true });
  assert.deepEqual(ok.calls, [true]);
  assert.deepEqual(S.sandboxState(), { on: true, mode: 'auto', reason: null });

  const blocked = launcher(NO_USERNS);
  assert.deepEqual(await S.withSandbox(blocked.fn), { sandbox: false });
  assert.deepEqual(blocked.calls, [true, false]);
  assert.equal(S.sandboxState().on, false);
  assert.match(S.sandboxState().reason, /user namespaces/);

  const broken = launcher('Executable doesn’t exist');
  await assert.rejects(S.withSandbox(broken.fn), /Executable doesn’t exist/);
  assert.deepEqual(broken.calls, [true], 'no retry without the sandbox for an unrelated failure');
});

test('on: never without the sandbox; off: never asks for it', async () => {
  process.env.JESSBOT_BROWSER_SANDBOX = 'on';
  const blocked = launcher(AS_ROOT);
  await assert.rejects(S.withSandbox(blocked.fn), /JESSBOT_BROWSER_SANDBOX=on/);
  assert.deepEqual(blocked.calls, [true]);
  assert.deepEqual(S.sandboxState(), { on: false, mode: 'on', reason: 'Jessbot runs as root, and Chromium won’t sandbox itself as root' });

  process.env.JESSBOT_BROWSER_SANDBOX = 'off';
  const off = launcher(null);
  assert.deepEqual(await S.withSandbox(off.fn), { sandbox: false });
  assert.deepEqual(off.calls, [false]);
  assert.equal(S.sandboxState().on, false);
});

test('launchViaServer asks Playwright for the sandbox (no --no-sandbox) and keeps the control socket on 127.0.0.1', async () => {
  delete process.env.JESSBOT_BROWSER_SANDBOX;
  const seen = [];
  const fakeLib = {
    launchServer: async opts => { seen.push(opts); return { wsEndpoint: () => 'ws://127.0.0.1:1/x', kill: async () => {} }; },
    connect: async () => ({ close: async () => {} }),
  };
  await S.launchViaServer(fakeLib, { channel: 'chromium', args: ['--user-agent=x'] });
  assert.equal(seen[0].chromiumSandbox, true);
  assert.equal(seen[0].host, '127.0.0.1');
  assert.ok(!seen[0].args.includes('--no-sandbox'));
  assert.ok(seen[0].args.includes('--user-agent=x') && seen[0].args.includes(S.COMMON_ARGS[0]));
});
