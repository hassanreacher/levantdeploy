import { redis } from "@/lib/redis";

/** Simple Redis mutex (per project) for route switches / scaling. Waits up to `waitMs`, auto-expires after `ttlMs`. */
export async function withProjectLock<T>(projectId: string, fn: () => Promise<T>, opts: { waitMs?: number; ttlMs?: number } = {}): Promise<T> {
  const key = `ld:runtime:lock:${projectId}`;
  const token = Math.random().toString(36).slice(2);
  const ttl = opts.ttlMs ?? 120_000;
  const deadline = Date.now() + (opts.waitMs ?? 120_000);
  const r = redis();
  for (;;) {
    if ((await r.set(key, token, "PX", ttl, "NX")) === "OK") break;
    if (Date.now() > deadline) throw new Error("Another runtime operation is in progress for this project");
    await new Promise((res) => setTimeout(res, 200));
  }
  try {
    return await fn();
  } finally {
    if ((await r.get(key).catch(() => null)) === token) await r.del(key).catch(() => {});
  }
}
