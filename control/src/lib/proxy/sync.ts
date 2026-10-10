import { env } from "@/lib/env";
import { redis } from "@/lib/redis";
import { buildCaddyConfig, buildHostMap, type HostInfo } from "./config";
import { loadProxyState } from "./state";

/**
 * syncRoutes(): rebuild the whole Caddy config from DB state and POST it to the admin API (/load).
 * Idempotent and debounced: concurrent callers within the debounce window share one sync.
 * Cross-process safety: a Redis lock serialises loads so the last writer always read the newest DB state.
 *
 *   await syncRoutes();                 // debounced (≈150 ms), resolves after the config was applied
 *   await syncRoutes({ immediate: true })
 *   requestSync()                       // fire-and-forget (API routes)
 */

export const HOSTMAP_KEY = "ld:proxy:hostmap";
const LOCK_KEY = "ld:proxy:lock";
const LAST_KEY = "ld:proxy:last";

export type SyncResult = { ok: boolean; sites: number; redirects: number; error?: string; ms: number };

const g = globalThis as unknown as {
  __ldSync?: { timer: NodeJS.Timeout | null; waiters: Array<(r: SyncResult) => void>; running: Promise<void> | null; again: boolean };
};
const st = (g.__ldSync ??= { timer: null, waiters: [], running: null, again: false });

export async function caddyRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const base = env.CADDY_ADMIN_URL.replace(/\/$/, "");
  // undici sends Sec-Fetch-Mode, which makes Caddy enforce the Origin check → send our own (listed in admin.origins)
  const headers = new Headers(init.headers);
  headers.set("origin", new URL(base).origin);
  return fetch(base + path, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(15_000) });
}

export async function getCaddyConfig(): Promise<unknown> {
  const r = await caddyRequest("/config/");
  if (!r.ok) throw new Error(`Caddy admin ${r.status}`);
  return r.json();
}

export async function caddyReachable(): Promise<boolean> {
  try {
    return (await caddyRequest("/config/", { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const r = redis();
  const token = Math.random().toString(36).slice(2);
  const deadline = Date.now() + 20_000;
  for (;;) {
    const ok = await r.set(LOCK_KEY, token, "PX", 30_000, "NX").catch(() => "OK");
    if (ok === "OK") break;
    if (Date.now() > deadline) break; // stale lock → proceed anyway
    await new Promise((res) => setTimeout(res, 100));
  }
  try {
    return await fn();
  } finally {
    const cur = await r.get(LOCK_KEY).catch(() => null);
    if (cur === token) await r.del(LOCK_KEY).catch(() => {});
  }
}

/** Do one sync now (no debounce). */
export async function applyRoutes(): Promise<SyncResult> {
  const t0 = Date.now();
  return withLock(async () => {
    const state = await loadProxyState();
    const config = buildCaddyConfig(state);
    const hostMap: Record<string, HostInfo> = buildHostMap(state);
    await redis()
      .set(HOSTMAP_KEY, JSON.stringify(hostMap))
      .catch(() => {});
    let res: SyncResult;
    try {
      const r = await caddyRequest("/load", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(config) });
      if (!r.ok) {
        const text = (await r.text()).slice(0, 2000);
        res = { ok: false, sites: state.sites.length, redirects: state.redirects.length, error: `Caddy /load ${r.status}: ${text}`, ms: Date.now() - t0 };
      } else {
        res = { ok: true, sites: state.sites.length, redirects: state.redirects.length, ms: Date.now() - t0 };
      }
    } catch (e) {
      res = { ok: false, sites: state.sites.length, redirects: state.redirects.length, error: `Caddy admin API unreachable (${env.CADDY_ADMIN_URL}): ${(e as Error).message}`, ms: Date.now() - t0 };
    }
    await redis()
      .set(LAST_KEY, JSON.stringify({ ...res, at: Date.now() }))
      .catch(() => {});
    if (!res.ok) console.warn("[proxy] sync failed:", res.error);
    return res;
  });
}

async function runLoop() {
  do {
    st.again = false;
    const waiters = st.waiters.splice(0);
    let res: SyncResult;
    try {
      res = await applyRoutes();
    } catch (e) {
      res = { ok: false, sites: 0, redirects: 0, error: (e as Error).message, ms: 0 };
      console.warn("[proxy] sync error:", (e as Error).message);
    }
    for (const w of waiters) w(res);
  } while (st.again || st.waiters.length);
  st.running = null;
}

export function syncRoutes(opts: { immediate?: boolean; debounceMs?: number } = {}): Promise<SyncResult> {
  return new Promise((resolve) => {
    st.waiters.push(resolve);
    if (st.running) {
      st.again = true;
      return;
    }
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(
      () => {
        st.timer = null;
        if (st.running) {
          st.again = true;
          return;
        }
        st.running = runLoop();
      },
      opts.immediate ? 0 : (opts.debounceMs ?? 150),
    );
  });
}

/** Fire-and-forget variant for API routes. */
export function requestSync() {
  void syncRoutes().catch(() => {});
}

export async function lastSync(): Promise<(SyncResult & { at: number }) | null> {
  const raw = await redis()
    .get(LAST_KEY)
    .catch(() => null);
  return raw ? JSON.parse(raw) : null;
}

export async function hostMap(): Promise<Record<string, HostInfo>> {
  const raw = await redis()
    .get(HOSTMAP_KEY)
    .catch(() => null);
  return raw ? JSON.parse(raw) : {};
}
