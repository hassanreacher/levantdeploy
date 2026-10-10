import { redisReady } from "./redis";

// Fixed-window rate limiter backed by Redis (shared across instances) with in-memory fallback.
const mem = new Map<string, { n: number; reset: number }>();

export type RateResult = { ok: boolean; remaining: number; resetIn: number };

export async function rateLimit(key: string, limit: number, windowSec: number): Promise<RateResult> {
  const r = redisReady();
  const k = `ld:rl:${key}`;
  if (r) {
    try {
      const res = await r.multi().incr(k).expire(k, windowSec, "NX").ttl(k).exec();
      const n = Number(res?.[0]?.[1] ?? 0);
      const ttl = Number(res?.[2]?.[1] ?? windowSec);
      return { ok: n <= limit, remaining: Math.max(0, limit - n), resetIn: ttl };
    } catch {}
  }
  const now = Date.now();
  const e = mem.get(k);
  if (!e || e.reset < now) {
    mem.set(k, { n: 1, reset: now + windowSec * 1000 });
    if (mem.size > 50_000) for (const [kk, v] of mem) if (v.reset < now) mem.delete(kk);
    return { ok: true, remaining: limit - 1, resetIn: windowSec };
  }
  e.n++;
  return { ok: e.n <= limit, remaining: Math.max(0, limit - e.n), resetIn: Math.ceil((e.reset - now) / 1000) };
}

export const LIMITS = {
  login: { limit: 10, window: 900 }, // per ip+email / 15 min
  register: { limit: 5, window: 3600 }, // per ip / hour
  reset: { limit: 5, window: 900 },
  totp: { limit: 8, window: 900 },
  api: { limit: 600, window: 60 }, // per ip / minute (general)
  write: { limit: 120, window: 60 }, // mutations per actor / minute
  deploy: { limit: 30, window: 60 },
  ai: { limit: 30, window: 300 },
  upload: { limit: 60, window: 600 },
} as const;
