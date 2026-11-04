// Per-key token bucket for the posting API. In-memory per instance: good
// enough to stop a runaway poster; a shared limiter can replace it later
// without changing callers.
const buckets = new Map<string, { tokens: number; at: number }>();

export function allow(key: string, perMinute = 300, burst = 60): { ok: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: burst, at: now };
  const refill = ((now - b.at) / 60_000) * perMinute;
  b.tokens = Math.min(burst, b.tokens + refill);
  b.at = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    buckets.set(key, b);
    return { ok: true, retryAfterSeconds: 0 };
  }
  buckets.set(key, b);
  return { ok: false, retryAfterSeconds: Math.ceil(((1 - b.tokens) / perMinute) * 60) };
}

// Keep the map from growing without bound.
setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, v] of buckets) if (v.at < cutoff) buckets.delete(k);
}, 5 * 60_000).unref?.();
