// WebSocket endpoint /ws (decision #31). One multiplexed socket per client.
// Auth: the same session token — cookie (web) or `Authorization: Bearer` / `?token=` (apps).
// Cookie-authenticated upgrades must come from our own origin (blocks cross-site WebSocket hijacking).
// Protocol (JSON frames): server → { t, seq?, threadId?, runId?, data }; client → { t: 'resume', data: { lastSeq } } | { t: 'ping' }
import { WebSocketServer } from 'ws';
import { resolveSession } from '../services/sessions.js';
import { COOKIE } from '../middleware/auth.js';
import { subscribe, replay, latestSeq } from '../lib/bus.js';
import { agentState } from '../services/runs.js';
import { originAllowed, hostAllowed } from '../lib/origin.js';

const HEARTBEAT_MS = 25_000;

function cookieToken(header = '') {
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function authenticate(req) {
  const url = new URL(req.url, 'http://x');
  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] || url.searchParams.get('token');
  if (bearer) return { session: resolveSession(bearer), via: 'bearer' };
  const cookie = cookieToken(req.headers.cookie);
  if (!cookie) return { session: null };
  // Cross-site WebSocket hijacking guard: browsers always send Origin on WS upgrades.
  if (!originAllowed(req.headers.origin, req.headers.host)) return { session: null, reason: 'origin' }; // #220
  return { session: resolveSession(cookie), via: 'cookie' };
}

export function attachWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws' || !hostAllowed(req.headers.host)) return socket.destroy();
    const { session } = authenticate(req);
    if (!session) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, session));
  });

  wss.on('connection', (ws, session) => {
    const userId = session.user.id;
    const send = frame => { if (ws.readyState === ws.OPEN) ws.send(frame); };
    const unsubscribe = subscribe(userId, send);
    ws.isAlive = true;

    send(JSON.stringify({ t: 'hello', data: { seq: latestSeq(userId), userId } }));
    send(JSON.stringify({ t: 'agent.state', data: agentState(userId) }));

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.t === 'ping') return send(JSON.stringify({ t: 'pong' }));
      if (msg.t === 'resume') {
        const after = Number(msg.data?.lastSeq) || 0;
        const missed = replay(userId, after);
        if (missed.length >= 2000) return send(JSON.stringify({ t: 'reload', data: { reason: 'too far behind' } }));
        for (const e of missed) send(JSON.stringify(e));
        send(JSON.stringify({ t: 'resumed', data: { count: missed.length } }));
      }
    });
    ws.on('close', unsubscribe);
    ws.on('error', unsubscribe);
  });

  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  beat.unref();
  return wss;
}
