import type { LlmHealth, LlmErrorCode } from "./types";

/**
 * Health, cooldown and rate-limit bookkeeping on a tiny KV interface (Redis in the app/worker, memory in tests).
 * Scopes: "provider" or "provider/model". Keys live under `ld:llm:`.
 */
export interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  incr(key: string, ttlMs: number): Promise<number>;
  del(...keys: string[]): Promise<void>;
  /** push to the head and keep `max` items */
  lpush(key: string, value: string, max: number, ttlMs?: number): Promise<void>;
  lrange(key: string): Promise<string[]>;
  /** keys starting with prefix */
  keys(prefix: string): Promise<string[]>;
}

export class MemoryKv implements KvStore {
  private m = new Map<string, { v: string | string[]; exp: number | null }>();
  constructor(private now: () => number = Date.now) {}
  private live(key: string) {
    const e = this.m.get(key);
    if (!e) return null;
    if (e.exp !== null && e.exp <= this.now()) {
      this.m.delete(key);
      return null;
    }
    return e;
  }
  async get(key: string) {
    const e = this.live(key);
    return e && typeof e.v === "string" ? e.v : null;
  }
  async set(key: string, value: string, ttlMs?: number) {
    this.m.set(key, { v: value, exp: ttlMs ? this.now() + ttlMs : null });
  }
  async incr(key: string, ttlMs: number) {
    const e = this.live(key);
    const n = (e && typeof e.v === "string" ? Number(e.v) : 0) + 1;
    this.m.set(key, { v: String(n), exp: e?.exp ?? this.now() + ttlMs });
    return n;
  }
  async del(...keys: string[]) {
    for (const k of keys) this.m.delete(k);
  }
  async lpush(key: string, value: string, max: number, ttlMs?: number) {
    const e = this.live(key);
    const arr = e && Array.isArray(e.v) ? e.v : [];
    arr.unshift(value);
    arr.length = Math.min(arr.length, max);
    this.m.set(key, { v: arr, exp: ttlMs ? this.now() + ttlMs : (e?.exp ?? null) });
  }
  async lrange(key: string) {
    const e = this.live(key);
    return e && Array.isArray(e.v) ? [...e.v] : [];
  }
  async keys(prefix: string) {
    return [...this.m.keys()].filter((k) => k.startsWith(prefix) && this.live(k));
  }
}

const P = "ld:llm:";
const WINDOW = 20;

type HealthRec = { success: number; failure: number; recent: string; latency: number | null; lastOkAt: string | null };
type Cool = { until: number; reason: string };

/** Base cooldown per error class (ms); repeated strikes double it (capped). */
const COOLDOWN: Partial<Record<LlmErrorCode, { scope: "model" | "provider"; base: number; max: number }>> = {
  RATE_LIMITED: { scope: "model", base: 60_000, max: 30 * 60_000 },
  OVERLOADED: { scope: "model", base: 30_000, max: 10 * 60_000 },
  AUTH: { scope: "provider", base: 10 * 60_000, max: 60 * 60_000 },
  NOT_FOUND: { scope: "model", base: 60 * 60_000, max: 24 * 60 * 60_000 },
  TIMEOUT: { scope: "model", base: 20_000, max: 5 * 60_000 },
  NETWORK: { scope: "provider", base: 20_000, max: 5 * 60_000 },
  SERVER: { scope: "model", base: 15_000, max: 5 * 60_000 },
  STREAM_BROKEN: { scope: "model", base: 10_000, max: 2 * 60_000 },
};

export class Health {
  constructor(
    public kv: KvStore,
    private now: () => number = Date.now,
  ) {}

  async recordSuccess(provider: string, model: string, latencyMs: number) {
    for (const scope of [provider, `${provider}/${model}`]) {
      const h = await this.read(scope);
      h.success++;
      h.recent = ("1" + h.recent).slice(0, WINDOW);
      h.latency = h.latency === null ? latencyMs : Math.round(h.latency * 0.7 + latencyMs * 0.3);
      h.lastOkAt = new Date(this.now()).toISOString();
      await this.kv.set(`${P}h:${scope}`, JSON.stringify(h), 7 * 86_400_000);
    }
    await this.kv.del(`${P}strikes:${provider}/${model}`, `${P}strikes:${provider}`);
  }

  async recordFailure(provider: string, model: string, code: LlmErrorCode, message: string, retryAfterMs?: number): Promise<{ scope: string; ms: number } | null> {
    const err = JSON.stringify({ at: new Date(this.now()).toISOString(), code, message: message.slice(0, 300) });
    for (const scope of [provider, `${provider}/${model}`]) {
      const h = await this.read(scope);
      h.failure++;
      h.recent = ("0" + h.recent).slice(0, WINDOW);
      await this.kv.set(`${P}h:${scope}`, JSON.stringify(h), 7 * 86_400_000);
      await this.kv.lpush(`${P}err:${scope}`, err, 5, 7 * 86_400_000);
    }
    const rule = COOLDOWN[code];
    if (!rule) return null;
    const scope = rule.scope === "provider" ? provider : `${provider}/${model}`;
    const strikes = await this.kv.incr(`${P}strikes:${scope}`, 60 * 60_000);
    const ms = Math.min(rule.max, Math.max(retryAfterMs ?? 0, rule.base * 2 ** Math.min(strikes - 1, 6)));
    // transient classes only cool down after repeated failures (first one just fails over)
    if ((code === "TIMEOUT" || code === "SERVER" || code === "STREAM_BROKEN" || code === "NETWORK") && strikes < 2) return null;
    await this.setCooldown(scope, ms, `${code}: ${message.slice(0, 160)}`);
    return { scope, ms };
  }

  async setCooldown(scope: string, ms: number, reason: string) {
    const c: Cool = { until: this.now() + ms, reason };
    await this.kv.set(`${P}cool:${scope}`, JSON.stringify(c), ms);
  }

  async cooldown(scope: string): Promise<Cool | null> {
    const raw = await this.kv.get(`${P}cool:${scope}`);
    if (!raw) return null;
    const c = JSON.parse(raw) as Cool;
    return c.until > this.now() ? c : null;
  }

  async reset(scope?: string) {
    const keys = await this.kv.keys(P);
    const doomed = scope ? keys.filter((k) => k.endsWith(`:${scope}`) || k.includes(`:${scope}/`) || k.includes(`:${scope}:`)) : keys;
    if (doomed.length) await this.kv.del(...doomed);
  }

  // ── rate limits ──
  private minute() {
    return Math.floor(this.now() / 60_000);
  }
  private day() {
    return Math.floor(this.now() / 86_400_000);
  }
  async counts(scope: string): Promise<{ rpm: number; rpd: number }> {
    const [a, b] = await Promise.all([this.kv.get(`${P}rpm:${scope}:${this.minute()}`), this.kv.get(`${P}rpd:${scope}:${this.day()}`)]);
    return { rpm: Number(a ?? 0), rpd: Number(b ?? 0) };
  }
  async countRequest(scope: string) {
    await Promise.all([this.kv.incr(`${P}rpm:${scope}:${this.minute()}`, 120_000), this.kv.incr(`${P}rpd:${scope}:${this.day()}`, 2 * 86_400_000)]);
  }
  /** null = allowed, else the reason */
  async overLimit(scope: string, rpm?: number, rpd?: number): Promise<string | null> {
    if (!rpm && !rpd) return null;
    const c = await this.counts(scope);
    if (rpm && c.rpm >= rpm) return `${scope}: ${c.rpm}/${rpm} requests this minute`;
    if (rpd && c.rpd >= rpd) return `${scope}: ${c.rpd}/${rpd} requests today`;
    return null;
  }

  // ── rotation ──
  async lastUsed(scope: string): Promise<number> {
    return Number((await this.kv.get(`${P}lru:${scope}`)) ?? 0);
  }
  async markUsed(scope: string) {
    await this.kv.set(`${P}lru:${scope}`, String(this.now()), 86_400_000);
  }

  // ── read ──
  private async read(scope: string): Promise<HealthRec> {
    const raw = await this.kv.get(`${P}h:${scope}`);
    if (!raw) return { success: 0, failure: 0, recent: "", latency: null, lastOkAt: null };
    try {
      return JSON.parse(raw) as HealthRec;
    } catch {
      return { success: 0, failure: 0, recent: "", latency: null, lastOkAt: null };
    }
  }

  async get(scope: string): Promise<LlmHealth> {
    const [h, errs, cool, counts] = await Promise.all([this.read(scope), this.kv.lrange(`${P}err:${scope}`), this.cooldown(scope), this.counts(scope)]);
    const n = h.recent.length;
    const ok = [...h.recent].filter((c) => c === "1").length;
    return {
      scope,
      success: h.success,
      failure: h.failure,
      successRate: n ? ok / n : 1,
      latencyMs: h.latency,
      lastErrors: errs.map((e) => JSON.parse(e) as LlmHealth["lastErrors"][number]),
      lastOkAt: h.lastOkAt,
      cooldownUntil: cool ? new Date(cool.until).toISOString() : null,
      cooldownReason: cool?.reason ?? null,
      rpm: counts.rpm,
      rpd: counts.rpd,
    };
  }

  /** recent success rate + sample count (for ranking) */
  async score(scope: string): Promise<{ rate: number; n: number; latency: number | null }> {
    const h = await this.read(scope);
    const n = h.recent.length;
    return { rate: n ? [...h.recent].filter((c) => c === "1").length / n : 1, n, latency: h.latency };
  }
}
