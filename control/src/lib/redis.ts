import Redis, { type RedisOptions } from "ioredis";

/**
 * Redis connections.
 *  - `redis()`      shared command connection (cache, rate limit, XADD, PUBLISH).
 *  - `redisReady()` the shared connection only if it is connected (null otherwise) — for best-effort features.
 *  - `newRedis()`   a NEW dedicated connection: use for blocking reads (XREAD BLOCK), SUBSCRIBE, and BullMQ.
 *                   Callers must `.quit()` it.
 */
const g = globalThis as unknown as { __redis?: Redis };

function url() {
  return process.env.REDIS_URL || "redis://localhost:6379";
}

export function redis(): Redis {
  if (g.__redis) return g.__redis;
  const client = new Redis(url(), { maxRetriesPerRequest: 2, connectTimeout: 3000, lazyConnect: false });
  client.on("error", (e) => {
    if (process.env.NODE_ENV !== "test") console.warn("[redis]", e.message);
  });
  g.__redis = client;
  return client;
}

export function redisReady(): Redis | null {
  const r = redis();
  return r.status === "ready" ? r : null;
}

export function newRedis(opts: RedisOptions = {}): Redis {
  const c = new Redis(url(), { maxRetriesPerRequest: null, connectTimeout: 3000, ...opts });
  c.on("error", () => {});
  return c;
}

/** Small JSON cache helper (Redis, falls back to calling fn). */
export async function cached<T>(key: string, ttlSec: number, fn: () => Promise<T>): Promise<T> {
  const r = redisReady();
  const k = `ld:cache:${key}`;
  if (r) {
    try {
      const hit = await r.get(k);
      if (hit !== null) return JSON.parse(hit) as T;
    } catch {}
  }
  const v = await fn();
  if (r && v !== undefined) await r.set(k, JSON.stringify(v), "EX", ttlSec).catch(() => {});
  return v;
}

export async function invalidate(...keys: string[]) {
  const r = redisReady();
  if (r && keys.length) await r.del(...keys.map((k) => `ld:cache:${k}`)).catch(() => {});
}
