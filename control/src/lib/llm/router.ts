import { anthropicAdapter } from "./anthropic";
import { parseRef, PURPOSE_TIER, refOf } from "./catalog";
import { Health } from "./health";
import { openAiAdapter } from "./openai";
import type { Adapter, AdapterOutput, ResolvedProvider } from "./provider";
import { scrubSecrets } from "./provider";
import { normalizeToolCalls, parseToolCallsFromText, repairJson } from "./repair";
import {
  LlmError,
  type LlmAttempt,
  type LlmChatRequest,
  type LlmEnsembleItem,
  type LlmEnsembleRequest,
  type LlmErrorCode,
  type LlmEvent,
  type LlmHealth,
  type LlmJudgeVerdict,
  type LlmModelInfo,
  type LlmPreferences,
  type LlmProviderKind,
  type LlmProviderView,
  type LlmPurpose,
  type LlmResult,
  type LlmRoutingSettings,
  type LlmStatus,
  type LlmToolCall,
} from "./types";

export type UsageRow = {
  provider: string;
  model: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  ok: boolean;
  errorCode: string | null;
  error: string | null;
  teamId: string | null;
  runId: string | null;
};

export type LoadedConfig = { providers: ResolvedProvider[]; views: LlmProviderView[]; preferences: LlmPreferences; routing: LlmRoutingSettings };

export type RouterDeps = {
  load: () => Promise<LoadedConfig>;
  health: Health;
  recordUsage?: (row: UsageRow) => Promise<void> | void;
  adapters?: Partial<Record<LlmProviderKind, Adapter>>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
};

export type Candidate = { provider: ResolvedProvider; model: LlmModelInfo; ref: string; native: boolean };

export type ProviderWithStatus = LlmProviderView & { status: LlmStatus; health: LlmHealth };

const TRANSIENT: LlmErrorCode[] = ["SERVER", "STREAM_BROKEN", "NETWORK", "TIMEOUT"];

export function defaultSleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new LlmError("ABORTED", "aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function hasImages(req: LlmChatRequest) {
  return req.messages.some((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"));
}

export function createRouter(deps: RouterDeps) {
  const health = deps.health;
  const sleep = deps.sleep ?? defaultSleep;
  const rand = deps.random ?? Math.random;
  const adapters: Record<LlmProviderKind, Adapter> = { openai: openAiAdapter, anthropic: anthropicAdapter, ...(deps.adapters ?? {}) };

  // ───────────────────────────── candidates ─────────────────────────────

  async function rank(req: Pick<LlmChatRequest, "purpose" | "tools" | "toolChoice" | "messages" | "model" | "providers" | "exclude">, cfg: LoadedConfig): Promise<Candidate[]> {
    const needTools = !!req.tools?.length && req.toolChoice !== "none";
    const needVision = req.purpose === "vision" || hasImages(req as LlmChatRequest);
    const usable = cfg.providers.filter((p) => p.enabled && p.configured);
    const byId = new Map(usable.map((p) => [p.id, p]));
    const allow = req.providers?.length ? req.providers : null;
    const deny = req.exclude ?? [];
    const matches = (list: string[], ref: string, pid: string) => list.some((x) => x === ref || x === pid);

    const out: Candidate[] = [];
    const seen = new Set<string>();
    const add = (p: ResolvedProvider, m: LlmModelInfo) => {
      const ref = refOf(p.id, m.id);
      if (seen.has(ref)) return;
      if (allow && !matches(allow, ref, p.id)) return;
      if (matches(deny, ref, p.id)) return;
      if (needVision && !m.vision) return;
      seen.add(ref);
      out.push({ provider: p, model: m, ref, native: needTools ? m.tools : true });
    };
    const explicit = (ref: string) => {
      const { provider, model } = parseRef(ref);
      const p = byId.get(provider);
      if (!p) return;
      if (!model) return p.models.forEach((m) => add(p, m));
      const m = p.models.find((x) => x.id === model) ?? p.allModels.find((x) => x.id === model);
      if (m) add(p, m);
    };
    if (req.model) explicit(req.model);
    for (const ref of cfg.preferences[req.purpose] ?? []) explicit(ref);
    // fill with everything else that fits: preferred tier first, provider order as in the catalog
    const tier = PURPOSE_TIER[req.purpose];
    const rest: { p: ResolvedProvider; m: LlmModelInfo; k: number }[] = [];
    usable.forEach((p, pi) => p.models.forEach((m, mi) => rest.push({ p, m, k: (m.tier === tier ? 0 : 10_000) + pi * 100 + mi })));
    rest.sort((a, b) => a.k - b.k).forEach(({ p, m }) => add(p, m));

    let list = out;
    if (req.model) {
      const [first, ...others] = list;
      list = first && first.ref === req.model ? [first, ...order(others, needTools)] : order(list, needTools);
    } else list = order(list, needTools);

    // rotation providers: least recently used model first (positions of that provider are kept)
    for (const p of usable.filter((x) => x.rotate)) {
      const idx = list.map((c, i) => (c.provider.id === p.id ? i : -1)).filter((i) => i >= 0);
      if (idx.length < 2) continue;
      const items = await Promise.all(idx.map(async (i) => ({ c: list[i], t: await health.lastUsed(list[i].ref) })));
      items.sort((a, b) => a.t - b.t);
      idx.forEach((i, j) => (list[i] = items[j].c));
    }
    // health: demote models with a bad recent success rate (keep pinned model first)
    const scored = await Promise.all(list.map(async (c) => ({ c, s: await health.score(c.ref) })));
    const bad = (s: { rate: number; n: number }) => s.n >= 4 && s.rate < 0.5;
    const pinned = req.model && list[0]?.ref === req.model ? [scored.shift()!] : [];
    return [...pinned, ...scored.filter((x) => !bad(x.s)), ...scored.filter((x) => bad(x.s))].map((x) => x.c);
  }

  /** native tool-calling models before text-mode ones (stable) */
  function order(list: Candidate[], needTools: boolean) {
    return needTools ? [...list.filter((c) => c.native), ...list.filter((c) => !c.native)] : list;
  }

  async function unavailable(c: Candidate): Promise<string | null> {
    const pc = await health.cooldown(c.provider.id);
    if (pc) return `cooldown: ${pc.reason}`;
    const mc = await health.cooldown(c.ref);
    if (mc) return `cooldown: ${mc.reason}`;
    const pl = await health.overLimit(c.provider.id, c.provider.limits.rpm, c.provider.limits.rpd);
    if (pl) return `rate limit ${pl}`;
    return health.overLimit(c.ref, c.model.rpm ?? c.provider.limits.modelRpm, c.model.rpd ?? c.provider.limits.modelRpd).then((r) => (r ? `rate limit ${r}` : null));
  }

  // ───────────────────────────── one attempt ─────────────────────────────

  async function attempt(c: Candidate, req: LlmChatRequest, timeoutMs: number, onText: (t: string) => void): Promise<AdapterOutput> {
    const ctl = new AbortController();
    const onOuter = () => ctl.abort(new LlmError("ABORTED", "aborted"));
    if (req.signal?.aborted) throw new LlmError("ABORTED", "aborted");
    req.signal?.addEventListener("abort", onOuter, { once: true });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => ctl.abort(new LlmError("TIMEOUT", `${c.ref}: no response for ${Math.round(timeoutMs / 1000)} s`, { provider: c.provider.id, model: c.model.id })), timeoutMs);
    };
    arm();
    await Promise.all([health.countRequest(c.provider.id), health.countRequest(c.ref), c.provider.rotate ? health.markUsed(c.ref) : null]);
    try {
      const out = await adapters[c.provider.kind]({
        provider: c.provider,
        model: c.model,
        req,
        signal: ctl.signal,
        stream: req.stream !== false,
        onText,
        onActivity: arm,
      });
      return out;
    } catch (e) {
      if (ctl.signal.aborted && ctl.signal.reason instanceof LlmError) throw ctl.signal.reason;
      if (e instanceof LlmError) throw e;
      throw new LlmError("NETWORK", `${c.ref}: ${(e as Error).message}`);
    } finally {
      if (timer) clearTimeout(timer);
      req.signal?.removeEventListener("abort", onOuter);
    }
  }

  /** tool-call normalisation + JSON parsing; throws INVALID_OUTPUT when unusable */
  function finish(c: Candidate, req: LlmChatRequest, out: AdapterOutput): { text: string; toolCalls: LlmToolCall[]; json?: unknown } {
    let text = out.text;
    let toolCalls = normalizeToolCalls(out.toolCalls).map((tc, i) => {
      const extra = out.toolCalls[i]?.extra;
      return extra ? { ...tc, extra: { provider: c.provider.id, data: extra } } : tc;
    });
    const wantTools = !!req.tools?.length && req.toolChoice !== "none";
    if (wantTools && !toolCalls.length && text) {
      const parsed = parseToolCallsFromText(text, req.tools!.map((t) => t.name));
      if (parsed.calls.length) {
        toolCalls = parsed.calls;
        text = parsed.text;
      }
    }
    if (!text.trim() && !toolCalls.length) throw new LlmError("INVALID_OUTPUT", `${c.ref}: empty response`, { provider: c.provider.id, model: c.model.id });
    let json: unknown;
    if ((req.json || req.jsonSchema) && !toolCalls.length) {
      const r = repairJson(text);
      if (!r.ok) throw new LlmError("INVALID_OUTPUT", `${c.ref}: response is not valid JSON`, { provider: c.provider.id, model: c.model.id });
      json = r.value;
    }
    return { text, toolCalls, json };
  }

  function usageRow(c: Candidate, req: LlmChatRequest, ok: boolean, latencyMs: number, out?: AdapterOutput, err?: LlmError): UsageRow {
    return {
      provider: c.provider.id,
      model: c.model.id,
      purpose: req.purpose,
      inputTokens: out?.usage.inputTokens ?? 0,
      outputTokens: out?.usage.outputTokens ?? 0,
      latencyMs,
      ok,
      errorCode: err?.code ?? null,
      error: err ? scrubSecrets(err.message, [c.provider.apiKey]).slice(0, 500) : null,
      teamId: req.teamId ?? null,
      runId: req.runId ?? null,
    };
  }

  function record(row: UsageRow) {
    try {
      void Promise.resolve(deps.recordUsage?.(row)).catch(() => {});
    } catch {
      /* accounting never breaks a call */
    }
  }

  // ───────────────────────────── chat ─────────────────────────────

  async function chat(req: LlmChatRequest): Promise<LlmResult> {
    const emit = (e: LlmEvent) => {
      try {
        req.onEvent?.(e);
      } catch {
        /* listener errors are not ours */
      }
    };
    const cfg = await deps.load();
    const routing = cfg.routing;
    const timeoutMs = req.timeoutMs ?? routing.timeoutMs;
    const maxAttempts = req.maxAttempts ?? routing.maxAttempts;
    let cands = await rank(req, cfg);
    if (req.pinOnly && req.model) cands = cands.filter((c) => c.ref === req.model);
    if (!cands.length) {
      const err = new LlmError(
        "NO_PROVIDERS",
        req.pinOnly && req.model ? `Model ${req.model} is not available (disabled, unconfigured or unknown).` : "No AI provider is enabled and configured for this request. Add a key in Settings → AI providers.",
      );
      emit({ type: "error", code: err.code, message: err.message });
      throw err;
    }
    const attempts: LlmAttempt[] = [];
    const skipped: string[] = [];
    let emitted = false;
    let tries = 0;
    const started = Date.now();

    for (const c of cands) {
      if (tries >= maxAttempts) break;
      if (req.signal?.aborted) throw abortErr(emit);
      const why = await unavailable(c);
      if (why) {
        skipped.push(`${c.ref} (${why})`);
        continue;
      }
      const textMode = !!req.tools?.length && req.toolChoice !== "none" && !c.model.tools;
      for (let retry = 0; retry <= routing.sameModelRetries; retry++) {
        if (tries >= maxAttempts) break;
        tries++;
        emit({ type: "provider", provider: c.provider.id, model: c.model.id, attempt: tries });
        const t0 = Date.now();
        let buffered = "";
        try {
          const out = await attempt(c, req, timeoutMs, (t) => {
            if (textMode || req.json || req.jsonSchema) buffered += t;
            else {
              emitted = true;
              emit({ type: "text", text: t });
            }
          });
          const done = finish(c, req, out);
          const latencyMs = Date.now() - t0;
          if (buffered && done.text) emit({ type: "text", text: done.text });
          for (const call of done.toolCalls) emit({ type: "tool_call", call });
          emit({ type: "usage", usage: out.usage });
          attempts.push({ provider: c.provider.id, model: c.model.id, ok: true, latencyMs });
          await health.recordSuccess(c.provider.id, c.model.id, latencyMs);
          record(usageRow(c, req, true, latencyMs, out));
          const result: LlmResult = {
            text: done.text,
            toolCalls: done.toolCalls,
            finishReason: done.toolCalls.length ? "tool_calls" : out.finishReason,
            json: done.json,
            provider: c.provider.id,
            model: c.model.id,
            ref: c.ref,
            usage: out.usage,
            latencyMs: Date.now() - started,
            attempts,
          };
          emit({ type: "done", result });
          return result;
        } catch (e) {
          const err = e instanceof LlmError ? e : new LlmError("NETWORK", (e as Error).message);
          const latencyMs = Date.now() - t0;
          if (err.code === "ABORTED" || req.signal?.aborted) {
            record(usageRow(c, req, false, latencyMs, undefined, new LlmError("ABORTED", "aborted")));
            throw abortErr(emit);
          }
          const message = scrubSecrets(err.message, [c.provider.apiKey]);
          attempts.push({ provider: c.provider.id, model: c.model.id, ok: false, latencyMs, errorCode: err.code, error: message });
          record(usageRow(c, req, false, latencyMs, undefined, err));
          const cooled = await health.recordFailure(c.provider.id, c.model.id, err.code, message, err.extra.retryAfterMs);
          const sameAgain = TRANSIENT.includes(err.code) && err.code !== "TIMEOUT" && retry < routing.sameModelRetries && !cooled && tries < maxAttempts;
          const delayMs = sameAgain ? Math.round(Math.min(8000, 400 * 2 ** retry) * (0.5 + rand())) : 0;
          const restart = emitted;
          emitted = false;
          emit({ type: "retry", provider: c.provider.id, model: c.model.id, code: err.code, message, restart, attempt: tries, delayMs });
          if (!sameAgain) break;
          await sleep(delayMs, req.signal).catch(() => {
            throw abortErr(emit);
          });
        }
      }
    }
    const tried = attempts.map((a) => `${a.provider}/${a.model}: ${a.errorCode}`).join("; ");
    const msg = attempts.length
      ? `All AI providers failed (${tried}${skipped.length ? `; skipped ${skipped.length} unavailable` : ""}).`
      : `Every candidate model is cooling down or over its rate limit (${skipped.slice(0, 5).join("; ")}). Try again shortly.`;
    const err = new LlmError(attempts.length ? "ALL_FAILED" : "RATE_LIMITED", msg, { attempts });
    emit({ type: "error", code: err.code, message: err.message });
    throw err;
  }

  function abortErr(emit: (e: LlmEvent) => void) {
    const err = new LlmError("ABORTED", "The request was canceled.");
    emit({ type: "error", code: err.code, message: err.message });
    return err;
  }

  /** async iterator over the events; the generator's return value is the result (throws LlmError like chat()) */
  async function* stream(req: LlmChatRequest): AsyncGenerator<LlmEvent, LlmResult> {
    const queue: LlmEvent[] = [];
    let wake: (() => void) | null = null;
    let settled = false;
    let result: LlmResult | undefined;
    let error: unknown;
    const p = chat({
      ...req,
      onEvent: (e) => {
        req.onEvent?.(e);
        queue.push(e);
        wake?.();
      },
    }).then(
      (r) => {
        result = r;
        settled = true;
        wake?.();
      },
      (e) => {
        error = e;
        settled = true;
        wake?.();
      },
    );
    for (;;) {
      while (queue.length) yield queue.shift()!;
      if (settled) break;
      await new Promise<void>((r) => (wake = r));
      wake = null;
    }
    await p;
    if (error) throw error;
    return result!;
  }

  // ───────────────────────────── ensemble / judge ─────────────────────────────

  async function ensemble(req: LlmEnsembleRequest): Promise<LlmEnsembleItem[]> {
    const cfg = await deps.load();
    const all = await rank(req, cfg);
    const avail: Candidate[] = [];
    for (const c of all) if (!(await unavailable(c))) avail.push(c);
    const n = Math.max(1, req.candidates);
    const picks: Candidate[] = [];
    for (const c of avail) if (picks.length < n && !picks.some((p) => p.provider.id === c.provider.id)) picks.push(c);
    for (const c of avail) if (picks.length < n && !picks.includes(c)) picks.push(c);
    if (!picks.length) {
      return [{ index: 0, ok: false, ref: null, error: { code: "NO_PROVIDERS", message: "No AI provider is available for this request." } }];
    }
    const sameProvider = req.sameProviderFallback !== false;
    const { onEvent, candidates: _n, sameProviderFallback: _s, ...base } = req;
    return Promise.all(
      picks.map(async (c, index): Promise<LlmEnsembleItem> => {
        try {
          const result = await chat({
            ...base,
            model: c.ref,
            providers: sameProvider ? [c.provider.id] : req.providers,
            exclude: [...(req.exclude ?? []), ...picks.filter((p) => p !== c).map((p) => p.ref)],
            onEvent: onEvent ? (e) => onEvent(index, e) : undefined,
          });
          return { index, ok: true, result };
        } catch (e) {
          const err = e instanceof LlmError ? e : new LlmError("NETWORK", (e as Error).message);
          return { index, ok: false, ref: c.ref, error: { code: err.code, message: err.message } };
        }
      }),
    );
  }

  async function judge(
    task: string,
    candidates: string[],
    opts: { criteria?: string; signal?: AbortSignal; teamId?: string | null; runId?: string | null; exclude?: string[]; maxTokens?: number } = {},
  ): Promise<LlmJudgeVerdict> {
    if (!candidates.length) throw new LlmError("BAD_REQUEST", "judge() needs at least one candidate");
    if (candidates.length === 1) return { winner: 0, scores: [10], reasoning: "Only one candidate.", judge: { provider: "-", model: "-" } };
    const schema = {
      type: "object",
      properties: {
        scores: { type: "array", items: { type: "number" }, description: "0-10 score per candidate, same order" },
        winner: { type: "integer", description: "index (0-based) of the best candidate" },
        reasoning: { type: "string" },
      },
      required: ["scores", "winner", "reasoning"],
    };
    const body = candidates.map((c, i) => `<candidate index="${i}">\n${c}\n</candidate>`).join("\n\n");
    const r = await chat({
      purpose: "judge",
      messages: [
        {
          role: "system",
          content:
            "You are a strict, impartial reviewer. Compare the candidate solutions for the task and pick the best one. Judge correctness first, then completeness, then quality. Ignore length and style unless the criteria say otherwise. Return JSON only.",
        },
        { role: "user", content: `Task:\n${task}\n\n${opts.criteria ? `Criteria: ${opts.criteria}\n\n` : ""}${body}\n\nReturn {"scores": [...], "winner": <index>, "reasoning": "..."}.` },
      ],
      jsonSchema: { name: "verdict", schema },
      maxTokens: opts.maxTokens ?? 2000,
      temperature: 0,
      signal: opts.signal,
      teamId: opts.teamId,
      runId: opts.runId,
      exclude: opts.exclude,
    });
    const v = (r.json ?? {}) as { scores?: unknown; winner?: unknown; reasoning?: unknown };
    const scores = candidates.map((_c, i) => {
      const s = Array.isArray(v.scores) ? Number(v.scores[i]) : NaN;
      return Number.isFinite(s) ? Math.max(0, Math.min(10, s)) : 0;
    });
    let winner = Number.isInteger(v.winner) ? (v.winner as number) : -1;
    if (winner < 0 || winner >= candidates.length) winner = scores.indexOf(Math.max(...scores));
    return { winner, scores, reasoning: typeof v.reasoning === "string" ? v.reasoning : "", judge: { provider: r.provider, model: r.model } };
  }

  // ───────────────────────────── admin helpers ─────────────────────────────

  async function candidates(q: { purpose: LlmPurpose; tools?: boolean; vision?: boolean; providers?: string[]; exclude?: string[] }) {
    const cfg = await deps.load();
    const req: LlmChatRequest = {
      purpose: q.purpose,
      messages: q.vision ? [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:," } }] }] : [],
      tools: q.tools ? [{ name: "x", description: "", parameters: {} }] : undefined,
      providers: q.providers,
      exclude: q.exclude,
    };
    const list = await rank(req, cfg);
    return Promise.all(list.map(async (c) => ({ ref: c.ref, provider: c.provider.id, model: c.model.id, tier: c.model.tier, nativeTools: c.native, unavailable: await unavailable(c) })));
  }

  async function statusOf(v: LlmProviderView): Promise<{ status: LlmStatus; health: LlmHealth }> {
    const h = await health.get(v.id);
    let status: LlmStatus;
    if (!v.enabled) status = "disabled";
    else if (!v.configured) status = "unconfigured";
    else if (h.cooldownUntil) status = "cooldown";
    else if (!h.success && !h.failure) status = "unknown";
    else if (h.successRate >= 0.8) status = "ok";
    else if (h.successRate >= 0.4) status = "degraded";
    else status = "down";
    return { status, health: h };
  }

  async function providers(): Promise<ProviderWithStatus[]> {
    const cfg = await deps.load();
    return Promise.all(cfg.views.map(async (v) => ({ ...v, ...(await statusOf(v)) })));
  }

  /** 1-token connectivity test (ignores enabled flag and cooldowns; still records health + usage). */
  async function test(providerId: string, modelId?: string): Promise<{ ok: boolean; provider: string; model: string | null; latencyMs: number; text?: string; error?: string; code?: LlmErrorCode }> {
    const cfg = await deps.load();
    const p = cfg.providers.find((x) => x.id === providerId);
    if (!p) return { ok: false, provider: providerId, model: null, latencyMs: 0, error: "Unknown provider", code: "NOT_FOUND" };
    if (!p.configured) return { ok: false, provider: providerId, model: null, latencyMs: 0, error: p.apiKey ? "Base URL is incomplete (missing variables)." : "No API key configured.", code: "AUTH" };
    const m = (modelId ? p.allModels.find((x) => x.id === modelId) : null) ?? (modelId ? { id: modelId, tools: true, vision: false, contextWindow: 8192, maxOutput: 1024, tier: "fast" as const } : null) ?? p.models.find((x) => x.tier === "fast") ?? p.models[0];
    if (!m) return { ok: false, provider: providerId, model: null, latencyMs: 0, error: "No models configured.", code: "NOT_FOUND" };
    const c: Candidate = { provider: p, model: m, ref: refOf(p.id, m.id), native: true };
    const req: LlmChatRequest = { purpose: "fast", messages: [{ role: "user", content: "Reply with the single word: ok" }], maxTokens: 64, stream: false };
    const t0 = Date.now();
    try {
      const out = await attempt(c, req, 30_000, () => {});
      const latencyMs = Date.now() - t0;
      await health.recordSuccess(p.id, m.id, latencyMs);
      record(usageRow(c, req, true, latencyMs, out));
      return { ok: true, provider: p.id, model: m.id, latencyMs, text: out.text.slice(0, 80) };
    } catch (e) {
      const err = e instanceof LlmError ? e : new LlmError("NETWORK", (e as Error).message);
      const latencyMs = Date.now() - t0;
      const message = scrubSecrets(err.message, [p.apiKey]);
      await health.recordFailure(p.id, m.id, err.code, message, err.extra.retryAfterMs);
      record(usageRow(c, req, false, latencyMs, undefined, err));
      return { ok: false, provider: p.id, model: m.id, latencyMs, error: message, code: err.code };
    }
  }

  async function healthAll(): Promise<LlmHealth[]> {
    const cfg = await deps.load();
    const scopes = cfg.views.flatMap((v) => [v.id, ...v.models.filter((m) => m.source !== "fetched").map((m) => refOf(v.id, m.id))]);
    return Promise.all(scopes.map((s) => health.get(s)));
  }

  return { chat, stream, ensemble, judge, candidates, providers, test, healthAll, health, statusOf };
}

export type Router = ReturnType<typeof createRouter>;
