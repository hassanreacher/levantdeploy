import { z } from "zod";
import { db } from "@/lib/db";
import { encryptString } from "@/lib/crypto";
import { getSetting, setSetting } from "@/lib/settings";
import { BUILTIN_PROVIDERS, PROVIDER_ID_RE, refOf } from "./catalog";
import { fetchOpenAiModels } from "./openai";
import { invalidateConfig, loadConfig } from "./runtime";
import { LLM_PURPOSES, type LlmModelInfo, type LlmPreferences, type LlmProviderOverride, type LlmPurpose } from "./types";
import { llm } from "./index";

/**
 * Owner-side operations behind Settings → AI providers and /api/v1/platform/ai-providers.
 * Keys are encrypted (encryptString) and never returned — views carry `keyHint` (last 4) only.
 */
const modelSchema = z.object({
  id: z.string().trim().min(1).max(200),
  label: z.string().max(200).optional(),
  tools: z.boolean().default(true),
  vision: z.boolean().default(false),
  contextWindow: z.number().int().min(512).max(10_000_000).default(32_768),
  maxOutput: z.number().int().min(16).max(1_000_000).default(8192),
  tier: z.enum(["fast", "smart"]).default("smart"),
  free: z.boolean().optional(),
  rpm: z.number().int().min(1).max(100_000).optional(),
  rpd: z.number().int().min(1).max(10_000_000).optional(),
});
const limitsSchema = z.object({
  rpm: z.number().int().min(1).max(100_000).optional(),
  rpd: z.number().int().min(1).max(10_000_000).optional(),
  modelRpm: z.number().int().min(1).max(100_000).optional(),
  modelRpd: z.number().int().min(1).max(10_000_000).optional(),
});
const headerName = /^[A-Za-z0-9-]{1,64}$/;
const headersSchema = z
  .record(z.string(), z.string().max(500))
  .refine((h) => Object.keys(h).every((k) => headerName.test(k) && k.toLowerCase() !== "authorization"), "Invalid header name (Authorization is set from the key)");
const urlSchema = z
  .string()
  .trim()
  .url("Enter a valid URL")
  .refine((u) => /^https?:\/\//.test(u), "Must start with http:// or https://")
  .transform((u) => u.replace(/\/+$/, ""));

export const providerPatchSchema = z.object({
  enabled: z.boolean().optional(),
  /** "" clears the stored key (falls back to env) */
  apiKey: z.string().max(4096).optional(),
  baseUrl: urlSchema.nullable().optional(),
  headers: headersSchema.optional(),
  vars: z.record(z.string().regex(/^[A-Z0-9_]+$/), z.string().max(200)).optional(),
  models: z.array(modelSchema).max(500).optional(),
  /** merged per model id; null removes that model's override */
  modelOverrides: z.record(z.string(), modelSchema.partial().extend({ disabled: z.boolean().optional() }).nullable()).optional(),
  limits: limitsSchema.optional(),
  label: z.string().trim().min(1).max(60).optional(),
});
export type ProviderPatch = z.infer<typeof providerPatchSchema>;

export const customProviderSchema = z.object({
  id: z
    .string()
    .trim()
    .toLowerCase()
    .regex(PROVIDER_ID_RE, "Use 2–32 lowercase letters, digits or dashes")
    .refine((id) => !["health", "preferences", "usage", "custom"].includes(id), "This id is reserved"),
  label: z.string().trim().min(1).max(60),
  baseUrl: urlSchema,
  apiKey: z.string().max(4096).optional(),
  headers: headersSchema.optional(),
  models: z.array(modelSchema).max(500).optional(),
  jsonMode: z.enum(["schema", "object", "none"]).optional(),
});

export const preferencesSchema = z.object({
  preferences: z.record(z.enum(LLM_PURPOSES), z.array(z.string().min(3).max(300)).max(100)).optional(),
  routing: z
    .object({ timeoutMs: z.number().int().min(5_000).max(600_000), maxAttempts: z.number().int().min(1).max(20), sameModelRetries: z.number().int().min(0).max(3) })
    .partial()
    .optional(),
  /** reset purposes to the built-in defaults */
  reset: z.array(z.enum(LLM_PURPOSES)).optional(),
});

async function overrides(): Promise<Record<string, LlmProviderOverride>> {
  return (await getSetting("llm.providers")) as Record<string, LlmProviderOverride>;
}
async function saveOverrides(all: Record<string, LlmProviderOverride>) {
  await setSetting("llm.providers", all as Record<string, Record<string, unknown>>);
  invalidateConfig();
}

export const isBuiltin = (id: string) => BUILTIN_PROVIDERS.some((p) => p.id === id);

export async function providerExists(id: string) {
  return isBuiltin(id) || !!(await overrides())[id]?.custom;
}

export async function updateProvider(id: string, patch: ProviderPatch): Promise<{ changed: string[] }> {
  const all = await overrides();
  const cur: LlmProviderOverride = { ...(all[id] ?? {}) };
  const changed: string[] = [];
  if (patch.enabled !== undefined) (cur.enabled = patch.enabled), changed.push("enabled");
  if (patch.apiKey !== undefined) (cur.apiKeyEnc = patch.apiKey.trim() ? encryptString(patch.apiKey.trim()) : null), changed.push(patch.apiKey.trim() ? "apiKey" : "apiKey(cleared)");
  if (patch.baseUrl !== undefined) (cur.baseUrl = patch.baseUrl), changed.push("baseUrl");
  if (patch.headers !== undefined) (cur.headers = patch.headers), changed.push("headers");
  if (patch.vars !== undefined) (cur.vars = patch.vars), changed.push("vars");
  if (patch.models !== undefined) (cur.models = patch.models as LlmModelInfo[]), changed.push("models");
  if (patch.modelOverrides !== undefined) {
    const mo = { ...(cur.modelOverrides ?? {}) };
    for (const [mid, v] of Object.entries(patch.modelOverrides)) {
      if (v === null) delete mo[mid];
      else mo[mid] = { ...(mo[mid] ?? {}), ...v };
    }
    cur.modelOverrides = mo;
    changed.push("modelOverrides");
  }
  if (patch.limits !== undefined) (cur.limits = patch.limits), changed.push("limits");
  if (patch.label !== undefined && cur.custom) (cur.custom = { ...cur.custom, label: patch.label }), changed.push("label");
  all[id] = cur;
  await saveOverrides(all);
  return { changed };
}

export async function addCustomProvider(input: z.infer<typeof customProviderSchema>) {
  const all = await overrides();
  if (isBuiltin(input.id) || all[input.id]?.custom) throw new Error(`A provider with id "${input.id}" already exists`);
  all[input.id] = {
    custom: { label: input.label, jsonMode: input.jsonMode ?? "object", modelsEndpoint: true },
    enabled: true,
    baseUrl: input.baseUrl,
    apiKeyEnc: input.apiKey?.trim() ? encryptString(input.apiKey.trim()) : null,
    headers: input.headers ?? {},
    models: (input.models ?? []) as LlmModelInfo[],
  };
  await saveOverrides(all);
}

/** custom → removed; built-in → overrides reset (key, base URL, models …). */
export async function removeProvider(id: string) {
  const all = await overrides();
  delete all[id];
  await saveOverrides(all);
  const cache = { ...(await getSetting("llm.modelsCache")) };
  delete cache[id];
  await setSetting("llm.modelsCache", cache);
}

export async function refreshModels(id: string): Promise<{ count: number; fetchedAt: string }> {
  const cfg = await loadConfig();
  const p = cfg.providers.find((x) => x.id === id);
  if (!p) throw new Error("Unknown provider");
  if (p.kind !== "openai") throw new Error("This provider has no /models endpoint — edit the model list manually.");
  if (!p.configured) throw new Error("Add an API key (and required variables) first.");
  const models = await fetchOpenAiModels(p);
  const fetchedAt = new Date().toISOString();
  const cache = { ...(await getSetting("llm.modelsCache")) };
  cache[id] = { fetchedAt, models: models.slice(0, 1000) as Record<string, unknown>[] };
  await setSetting("llm.modelsCache", cache);
  invalidateConfig();
  return { count: models.length, fetchedAt };
}

export async function getPreferences(): Promise<{ preferences: LlmPreferences; custom: LlmPurpose[] }> {
  const cfg = await loadConfig();
  const saved = (await getSetting("llm.preferences")) ?? {};
  return { preferences: cfg.preferences, custom: LLM_PURPOSES.filter((p) => saved[p]?.length) };
}

export async function savePreferences(input: z.infer<typeof preferencesSchema>) {
  if (input.preferences || input.reset) {
    const cur = { ...((await getSetting("llm.preferences")) ?? {}) };
    for (const [k, v] of Object.entries(input.preferences ?? {})) cur[k] = [...new Set(v)];
    for (const k of input.reset ?? []) delete cur[k];
    await setSetting("llm.preferences", Object.keys(cur).length ? cur : null);
  }
  if (input.routing) await setSetting("llm.routing", { ...((await getSetting("llm.routing")) ?? {}), ...input.routing });
  invalidateConfig();
}

export type UsageRange = "24h" | "7d" | "30d";
const RANGE_MS: Record<UsageRange, number> = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };

export async function usageStats(range: UsageRange) {
  const since = new Date(Date.now() - RANGE_MS[range]);
  const [groups, okGroups, recentErrors, byPurpose] = await Promise.all([
    db.llmUsage.groupBy({
      by: ["provider", "model"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true },
      _avg: { latencyMs: true },
    }),
    db.llmUsage.groupBy({ by: ["provider", "model"], where: { createdAt: { gte: since }, ok: true }, _count: { _all: true }, _avg: { latencyMs: true } }),
    db.llmUsage.findMany({
      where: { createdAt: { gte: since }, ok: false },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, createdAt: true, provider: true, model: true, purpose: true, errorCode: true, error: true },
    }),
    db.llmUsage.groupBy({ by: ["purpose"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
  ]);
  const okMap = new Map(okGroups.map((g) => [refOf(g.provider, g.model), g]));
  const rows = groups
    .map((g) => {
      const ok = okMap.get(refOf(g.provider, g.model));
      const requests = g._count._all;
      const okCount = ok?._count._all ?? 0;
      return {
        provider: g.provider,
        model: g.model,
        requests,
        ok: okCount,
        errors: requests - okCount,
        inputTokens: g._sum.inputTokens ?? 0,
        outputTokens: g._sum.outputTokens ?? 0,
        avgLatencyMs: Math.round(ok?._avg.latencyMs ?? g._avg.latencyMs ?? 0),
      };
    })
    .sort((a, b) => b.requests - a.requests);
  const totals = rows.reduce((t, r) => ({ requests: t.requests + r.requests, errors: t.errors + r.errors, inputTokens: t.inputTokens + r.inputTokens, outputTokens: t.outputTokens + r.outputTokens }), { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0 });
  return {
    range,
    since: since.toISOString(),
    totals,
    rows,
    byPurpose: Object.fromEntries(byPurpose.map((g) => [g.purpose, g._count._all])),
    errors: recentErrors.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
  };
}

/** Everything the settings page needs in one call. */
export async function overview() {
  const [providers, prefs, cfg] = await Promise.all([llm.providers(), getPreferences(), loadConfig()]);
  return { providers, preferences: prefs.preferences, customPreferences: prefs.custom, routing: cfg.routing, purposes: LLM_PURPOSES };
}
