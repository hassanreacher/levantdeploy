import { BUILTIN_PROVIDERS, DEFAULT_PREFERENCES } from "./catalog";
import type { ResolvedProvider } from "./provider";
import { LLM_PURPOSES, type LlmModelInfo, type LlmPreferences, type LlmProviderDef, type LlmProviderOverride, type LlmProviderView, type LlmRoutingSettings } from "./types";

/**
 * Pure config resolution: built-in catalog + owner overrides (Setting "llm.providers") + fetched /models cache +
 * env keys → providers ready for the router, and masked views for the UI. No I/O here (see runtime.ts).
 */
export type FetchedModel = { id: string; contextWindow?: number; maxOutput?: number; vision?: boolean; tools?: boolean; free?: boolean };
export type ModelsCache = Record<string, { fetchedAt: string; models: FetchedModel[] }>;

export type LlmSnapshot = {
  providers: Record<string, LlmProviderOverride>;
  preferences: Partial<LlmPreferences> | null;
  routing: Partial<LlmRoutingSettings> | null;
  modelsCache: ModelsCache;
  /** Settings → AI encrypted Anthropic key (fallback for the anthropic provider) */
  aiApiKeyEnc?: string | null;
};

export const DEFAULT_ROUTING: LlmRoutingSettings = { timeoutMs: 60_000, maxAttempts: 6, sameModelRetries: 1 };

export function routingOf(s: LlmSnapshot): LlmRoutingSettings {
  return { ...DEFAULT_ROUTING, ...(s.routing ?? {}) };
}

export function preferencesOf(s: LlmSnapshot): LlmPreferences {
  const out = {} as LlmPreferences;
  for (const p of LLM_PURPOSES) out[p] = s.preferences?.[p]?.length ? [...s.preferences[p]!] : [...DEFAULT_PREFERENCES[p]];
  return out;
}

/** Built-in definition or the synthesized definition of an owner-added provider. */
export function definitionsOf(s: LlmSnapshot): LlmProviderDef[] {
  const defs = [...BUILTIN_PROVIDERS];
  for (const [id, o] of Object.entries(s.providers)) {
    if (!o.custom || defs.some((d) => d.id === id)) continue;
    defs.push({
      id,
      label: o.custom.label,
      kind: "openai",
      baseUrl: o.baseUrl ?? "",
      envKey: null,
      defaultEnabled: true,
      modelsEndpoint: o.custom.modelsEndpoint ?? true,
      jsonMode: o.custom.jsonMode ?? "object",
      limits: {},
      models: [],
      custom: true,
    });
  }
  return defs;
}

const FAST_RE = /lite|mini|small|nano|tiny|instant|haiku|flash(?!-?pro)|[^0-9](?:1|3|7|8|9|12|14|17|20|24|27)b\b|scout/i;
const VISION_RE = /vision|[-/]vl|gemini|llama-4|gpt-4o|gpt-4\.1|pixtral|scout|maverick|gemma-3|claude|qwen2\.5-vl|llava|mistral-(?:medium|small|large)/i;

/** Capabilities for a model we only know from /models. */
export function guessModel(f: FetchedModel): LlmModelInfo {
  return {
    id: f.id,
    tools: f.tools ?? true,
    vision: f.vision ?? VISION_RE.test(f.id),
    contextWindow: f.contextWindow ?? 32_768,
    maxOutput: f.maxOutput ?? 8192,
    tier: FAST_RE.test(f.id) ? "fast" : "smart",
    free: f.free,
  };
}

function substitute(url: string, vars: Record<string, string>, env: Record<string, string | undefined>): { url: string; missing: string[] } {
  const missing: string[] = [];
  const out = url.replace(/\{([A-Z0-9_]+)\}/g, (_m, name: string) => {
    const v = vars[name] ?? env[name];
    if (!v) missing.push(name);
    return v ?? `{${name}}`;
  });
  return { url: out, missing };
}

export type ResolveDeps = { env: Record<string, string | undefined>; decrypt: (blob: string | null | undefined) => string | null; mask: (s: string) => string };

export function resolveAll(s: LlmSnapshot, deps: ResolveDeps): { resolved: ResolvedProvider[]; views: LlmProviderView[] } {
  const resolved: ResolvedProvider[] = [];
  const views: LlmProviderView[] = [];
  for (const def of definitionsOf(s)) {
    const o = s.providers[def.id] ?? {};
    // key: setting > env (> Settings → AI for anthropic)
    let key: string | null = null;
    let keySource: LlmProviderView["keySource"] = null;
    const fromSetting = o.apiKeyEnc ? deps.decrypt(o.apiKeyEnc) : null;
    if (fromSetting) {
      key = fromSetting;
      keySource = "setting";
    } else if (def.envKey && deps.env[def.envKey]?.trim()) {
      key = deps.env[def.envKey]!.trim();
      keySource = "env";
    } else if (def.kind === "anthropic" && s.aiApiKeyEnc) {
      key = deps.decrypt(s.aiApiKeyEnc);
      keySource = key ? "setting" : null;
    }
    const vars = { ...(o.vars ?? {}) };
    for (const v of def.extraVars ?? []) if (!vars[v] && deps.env[v]) vars[v] = deps.env[v]!;
    let base = o.baseUrl || def.baseUrl;
    if (def.kind === "anthropic" && !o.baseUrl && deps.env.ANTHROPIC_BASE_URL) base = deps.env.ANTHROPIC_BASE_URL;
    const { url, missing } = substitute(base, vars, deps.env);
    // anonymous tier only when the owner explicitly enabled the provider (never by default)
    const configured = (!!key || (!!def.keyOptional && o.enabled === true)) && !missing.length && /^https?:\/\//.test(url);
    const enabled = o.enabled ?? def.defaultEnabled;

    // models: manual list (or built-in) + fetched; overrides; disabled flags
    const fetched = s.modelsCache[def.id];
    const baseModels = (o.models?.length ? o.models : def.models).map((m) => ({ ...m, source: (o.models?.length ? "manual" : "builtin") as "manual" | "builtin" }));
    const all: LlmProviderView["models"] = [...baseModels];
    for (const f of fetched?.models ?? []) {
      const i = all.findIndex((m) => m.id === f.id);
      if (i >= 0) {
        all[i] = { ...all[i], contextWindow: f.contextWindow ?? all[i].contextWindow, maxOutput: f.maxOutput ?? all[i].maxOutput, free: all[i].free ?? f.free };
      } else all.push({ ...guessModel(f), source: "fetched" });
    }
    const models = all.map((m) => {
      const ov = o.modelOverrides?.[m.id];
      return ov ? { ...m, ...ov, id: m.id } : m;
    });
    const limits = { ...def.limits, ...(o.limits ?? {}) };
    const headers = { ...(def.headers ?? {}), ...(o.headers ?? {}) };
    views.push({
      id: def.id,
      label: o.custom?.label ?? def.label,
      kind: def.kind,
      custom: !!def.custom,
      enabled,
      configured,
      keySource,
      keyHint: key ? deps.mask(key) : "",
      baseUrl: url,
      defaultBaseUrl: def.baseUrl,
      headers,
      vars,
      extraVars: def.extraVars ?? [],
      warning: def.warning,
      notes: def.notes,
      docsUrl: def.docsUrl,
      jsonMode: def.jsonMode,
      modelsEndpoint: def.modelsEndpoint,
      rotate: !!def.rotate,
      limits,
      models,
      modelsFetchedAt: fetched?.fetchedAt ?? null,
    });
    // Router candidates: curated (builtin/manual) models; fetched-only models join for rotation providers and
    // whenever the owner listed them in a preference (handled in the router via `extraModels`).
    resolved.push({
      id: def.id,
      label: o.custom?.label ?? def.label,
      kind: def.kind,
      baseUrl: url,
      apiKey: key,
      headers,
      enabled,
      configured,
      jsonMode: def.jsonMode,
      modelsEndpoint: def.modelsEndpoint,
      rotate: !!def.rotate,
      limits,
      models: models.filter((m) => !(m as { disabled?: boolean }).disabled && (m.source !== "fetched" || def.rotate)).map(stripView),
      allModels: models.filter((m) => !(m as { disabled?: boolean }).disabled).map(stripView),
      warning: def.warning,
    });
  }
  return { resolved, views };
}

function stripView(m: LlmProviderView["models"][number]): LlmModelInfo {
  const { source: _s, disabled: _d, ...rest } = m as LlmProviderView["models"][number] & { disabled?: boolean };
  return rest;
}
