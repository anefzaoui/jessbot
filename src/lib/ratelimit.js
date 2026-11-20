// Tiny in-memory sliding-window limiter (login, invite accept, setup). Per process; good enough for one server.
const buckets = new Map();

export function hit(key, { limit, windowMs }) {
  const now = Date.now();
  const list = (buckets.get(key) || []).filter(t => now - t < windowMs);
  list.push(now);
  buckets.set(key, list);
  if (buckets.size > 10_000) for (const [k, v] of buckets) if (!v.some(t => now - t < windowMs)) buckets.delete(k);
  return { allowed: list.length <= limit, retryInMs: list.length > limit ? windowMs - (now - list[0]) : 0 };
}

export const reset = key => buckets.delete(key);
