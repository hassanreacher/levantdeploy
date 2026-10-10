import { db } from "@/lib/db";
import { decryptString, maskSecret } from "@/lib/crypto";
import { redis } from "@/lib/redis";
import { getSetting } from "@/lib/settings";
import { preferencesOf, resolveAll, routingOf, type LlmSnapshot, type ModelsCache } from "./config";
import { Health, MemoryKv, type KvStore } from "./health";
import type { LoadedConfig, RouterDeps, UsageRow } from "./router";
import type { LlmProviderOverride } from "./types";

/**
 * Production wiring: settings from the DB (Setting table, cached), health in Redis (REDIS_URL), usage in LlmUsage.
 * Worker-safe. If Redis is unreachable the router keeps working with in-process health (best effort).
 */
export class RedisKv implements KvStore {
  private mem = new MemoryKv();
  private async safe<T>(fn: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    try {
      const r = redis();
      if (r.status !== "ready" && r.status !== "connect" && r.status !== "connecting" && r.status !== "reconnecting") return fallback();
      return await fn();
    } catch {
      return fallback();
    }
  }
  get(k: string) {
    return this.safe(() => redis().get(k), () => this.mem.get(k));
  }
  set(k: string, v: string, ttlMs?: number) {
    return this.safe(
      async () => {
        if (ttlMs) await redis().set(k, v, "PX", Math.max(1, Math.round(ttlMs)));
        else await redis().set(k, v);
      },
      () => this.mem.set(k, v, ttlMs),
    );
  }
  incr(k: string, ttlMs: number) {
    return this.safe(
      async () => {
        const n = await redis().incr(k);
        if (n === 1) await redis().pexpire(k, ttlMs);
        return n;
      },
      () => this.mem.incr(k, ttlMs),
    );
  }
  del(...keys: string[]) {
    return this.safe(
      async () => {
        if (keys.length) await redis().del(...keys);
      },
      () => this.mem.del(...keys),
    );
  }
  lpush(k: string, v: string, max: number, ttlMs?: number) {
    return this.safe(
      async () => {
        const m = redis().multi().lpush(k, v).ltrim(k, 0, max - 1);
        if (ttlMs) m.pexpire(k, ttlMs);
        await m.exec();
      },
      () => this.mem.lpush(k, v, max, ttlMs),
    );
  }
  lrange(k: string) {
    return this.safe(() => redis().lrange(k, 0, -1), () => this.mem.lrange(k));
  }
  keys(prefix: string) {
    return this.safe(
      async () => {
        const out: string[] = [];
        let cursor = "0";
        do {
          const [next, batch] = await redis().scan(cursor, "MATCH", `${prefix}*`, "COUNT", 500);
          cursor = next;
          out.push(...batch);
        } while (cursor !== "0");
        return out;
      },
      () => this.mem.keys(prefix),
    );
  }
}

export async function loadSnapshot(): Promise<LlmSnapshot> {
  const [providers, preferences, routing, modelsCache, aiApiKeyEnc] = await Promise.all([
    getSetting("llm.providers"),
    getSetting("llm.preferences"),
    getSetting("llm.routing"),
    getSetting("llm.modelsCache"),
    getSetting("ai.apiKeyEnc"),
  ]);
  return {
    providers: providers as Record<string, LlmProviderOverride>,
    preferences: preferences as LlmSnapshot["preferences"],
    routing,
    modelsCache: modelsCache as unknown as ModelsCache,
    aiApiKeyEnc,
  };
}

export function configFromSnapshot(snap: LlmSnapshot, env: Record<string, string | undefined> = process.env): LoadedConfig {
  const { resolved, views } = resolveAll(snap, { env, decrypt: (b) => decryptString(b), mask: maskSecret });
  return { providers: resolved, views, preferences: preferencesOf(snap), routing: routingOf(snap) };
}

/** process-global: Next dev compiles each route separately, so module-level state would not be shared */
const g = globalThis as unknown as { __llmCfgMemo?: { at: number; cfg: Promise<LoadedConfig> } | null };

/** Config with a 3 s in-process memo (settings themselves are Redis-cached for 30 s and invalidated on save). */
export function loadConfig(): Promise<LoadedConfig> {
  const memo = g.__llmCfgMemo;
  if (memo && Date.now() - memo.at < 3000) return memo.cfg;
  const cfg = loadSnapshot().then((s) => configFromSnapshot(s));
  g.__llmCfgMemo = { at: Date.now(), cfg };
  cfg.catch(() => (g.__llmCfgMemo = null));
  return cfg;
}
export function invalidateConfig() {
  g.__llmCfgMemo = null;
}

export async function recordUsage(row: UsageRow) {
  await db.llmUsage.create({ data: row }).catch(() => {});
}

export function defaultDeps(): RouterDeps {
  return { load: loadConfig, health: new Health(new RedisKv()), recordUsage };
}
