// Realtime connection (decision #31): one socket, auto-reconnect with jittered backoff, resume from the last seq.
// The page is rendered at a known seq (<html data-seq>), so nothing between render and connect is missed.
// Frames are re-dispatched as DOM events: 'jb:ws' (all) and 'jb:ws:<type>' (e.g. 'jb:ws:run.delta').
import { h } from './core.js';

let socket = null, backoff = 800, lastSeq = 0, lastFrameAt = 0, pill = null, stopped = false;

const emit = frame => {
  document.dispatchEvent(new CustomEvent('jb:ws', { detail: frame }));
  document.dispatchEvent(new CustomEvent(`jb:ws:${frame.t}`, { detail: frame }));
};

function setOnline(online) {
  document.documentElement.toggleAttribute('data-offline', !online);
  if (online) { pill?.remove(); pill = null; return; }
  if (!pill) {
    pill = h(`<div class="conn-pill" role="status"><span class="spinner size-3"></span> Reconnecting…</div>`);
    document.body.append(pill);
  }
}

function connect() {
  if (stopped) return;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  socket = new WebSocket(url);
  socket.addEventListener('open', () => {
    backoff = 800;
    setOnline(true);
    socket.send(JSON.stringify({ t: 'resume', data: { lastSeq } }));
  });
  socket.addEventListener('message', ev => {
    lastFrameAt = Date.now();
    let frame;
    try { frame = JSON.parse(ev.data); } catch { return; }
    if (frame.t === 'reload') return location.reload();
    if (frame.seq) {
      if (frame.seq <= lastSeq) return; // already applied (replay overlap)
      lastSeq = frame.seq;
    }
    emit(frame);
  });
  socket.addEventListener('close', ev => {
    socket = null;
    if (ev.code === 1008 || stopped) return;          // policy/auth failure: don't hammer
    setOnline(false);
    const wait = Math.min(backoff, 30_000) * (0.7 + Math.random() * 0.6);
    backoff *= 1.8;
    setTimeout(connect, wait);
  });
  socket.addEventListener('error', () => socket?.close());
}

export function initRealtime() {
  // Not on public pages (no session) and not in the styleguide (simulated API).
  const root = document.documentElement;
  if (root.dataset.apiBase || !root.dataset.seq) return;
  lastSeq = Number(root.dataset.seq) || 0;
  connect();
  // Watchdog: the server pings every 25 s; if nothing arrives for 70 s, force a reconnect.
  setInterval(() => { if (socket && lastFrameAt && Date.now() - lastFrameAt > 70_000) socket.close(); }, 15_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !socket) { backoff = 800; connect(); }
  });
  lastFrameAt = Date.now();
}

export const isOnline = () => socket?.readyState === WebSocket.OPEN;
