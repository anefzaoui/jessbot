// Rate limits that survive a restart (decision #223, issue #6). Counters live in SQLite (table rate_limits): a fixed window
// per key, so a restart (or a crash an attacker provokes) never hands out a fresh set of attempts.
//   hit(key, { limit, windowMs })   one attempt inside a handler (sign-in per address and email, invite, setup, …)
//   limiter({ name, limit, windowMs, key?, message? })   the one middleware for routes (express-rate-limit with this store)
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { get, run } from '../db/index.js';
import { tooMany } from './errors.js';

let sinceSweep = 0;
function sweep(now) {
  if (++sinceSweep < 500) return;
  sinceSweep = 0;
  run('DELETE FROM rate_limits WHERE reset_at <= ?', now);
}

/** Count one hit on key. → { hits, resetAt } (the window starts at the first hit and lasts windowMs). */
function count(key, windowMs, now = Date.now()) {
  sweep(now);
  const row = get(`INSERT INTO rate_limits (key, hits, reset_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET
      hits = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.hits + 1 END,
      reset_at = CASE WHEN rate_limits.reset_at <= ? THEN excluded.reset_at ELSE rate_limits.reset_at END
    RETURNING hits, reset_at`, key, now + windowMs, now, now);
  return { hits: row.hits, resetAt: row.reset_at };
}

/** One attempt. → { allowed, retryInMs }. */
export function hit(key, { limit, windowMs }) {
  const now = Date.now();
  const { hits, resetAt } = count(String(key), windowMs, now);
  return { allowed: hits <= limit, retryInMs: hits > limit ? Math.max(0, resetAt - now) : 0 };
}

/** Forget a key (a successful sign-in clears its failed attempts). */
export const reset = key => { run('DELETE FROM rate_limits WHERE key = ?', String(key)); };

// express-rate-limit's store interface, on the same table.
class SqliteStore {
  constructor(name) { this.prefix = `rl:${name}:`; this.localKeys = false; }
  init(options) { this.windowMs = options.windowMs; }
  async get(key) {
    const row = get('SELECT hits, reset_at FROM rate_limits WHERE key = ? AND reset_at > ?', this.prefix + key, Date.now());
    return row ? { totalHits: row.hits, resetTime: new Date(row.reset_at) } : undefined;
  }
  async increment(key) {
    const { hits, resetAt } = count(this.prefix + key, this.windowMs);
    return { totalHits: hits, resetTime: new Date(resetAt) };
  }
  async decrement(key) { run('UPDATE rate_limits SET hits = MAX(0, hits - 1) WHERE key = ?', this.prefix + key); }
  async resetKey(key) { run('DELETE FROM rate_limits WHERE key = ?', this.prefix + key); }
}

/** The client a limit counts against: the signed-in person, else the address (IPv6 by its /56, so one host can't rotate). */
export const clientKey = req => (req.user ? `u${req.user.id}` : ipKeyGenerator(req.ip || ''));

const inMinutes = ms => Math.max(1, Math.ceil(ms / 60e3));

/**
 * The one rate-limiting middleware. name: the bucket (its keys never mix with another limiter's). key(req): what to count
 * against (default clientKey). message(minutes): the 429 text. Over the limit → a 429 through the normal error handler
 * (JSON for the API and fetch, the error page otherwise), with RateLimit and Retry-After headers.
 */
export function limiter({ name, limit, windowMs, key = clientKey, message = m => `Too many requests. Try again in ${m} min.`, skip }) {
  return rateLimit({
    windowMs, limit, store: new SqliteStore(name), keyGenerator: key, skip,
    standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (req, res, next, options) => {
      const resetTime = req.rateLimit?.resetTime;
      const ms = resetTime ? resetTime.getTime() - Date.now() : options.windowMs;
      res.set('Retry-After', String(Math.max(1, Math.ceil(ms / 1000))));
      next(tooMany(message(inMinutes(ms))));
    },
  });
}

/** Everything that takes a password or a one-time code from someone not signed in yet, per address: 30 tries in 15
 *  minutes across sign-in, setup and invites (on top of each route's own per-account limit). */
export const signInLimit = limiter({ name: 'sign-in', limit: 30, windowMs: 15 * 60e3, key: req => ipKeyGenerator(req.ip || ''),
  message: m => `Too many attempts from this address. Try again in ${m} min.` });
