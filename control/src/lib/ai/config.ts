import Anthropic from "@anthropic-ai/sdk";
import { getSetting } from "@/lib/settings";
import { decryptString, maskSecret } from "@/lib/crypto";
import { AI_MODELS, DEFAULT_EFFORT, DEFAULT_MODEL, type AiEffort } from "./types";

/**
 * AI configuration: Settings → AI (platform owner) with env fallbacks.
 *   key:    setting "ai.apiKeyEnc" (encrypted) > env ANTHROPIC_API_KEY
 *   model:  setting "ai.model" > env ANTHROPIC_MODEL > claude-opus-5-5
 *   effort: setting "ai.effort" > "medium"
 * The API key is never logged or returned to clients (only `maskSecret`).
 * Worker-safe (no next/* imports).
 */
export type AiConfig = {
  enabled: boolean;
  model: string;
  effort: AiEffort;
  autoDiagnose: boolean;
  keySource: "setting" | "env" | null;
  keyHint: string;
};

const KNOWN = new Set<string>(AI_MODELS.map((m) => m.id));

async function resolveKey(): Promise<{ key: string | null; source: AiConfig["keySource"] }> {
  const enc = await getSetting("ai.apiKeyEnc");
  const fromSetting = enc ? decryptString(enc) : null;
  if (fromSetting) return { key: fromSetting, source: "setting" };
  const fromEnv = process.env.ANTHROPIC_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "env" };
  return { key: null, source: null };
}

export async function getAiConfig(): Promise<AiConfig> {
  const [enabled, model, effort, autoDiagnose, key] = await Promise.all([
    getSetting("ai.enabled"),
    getSetting("ai.model"),
    getSetting("ai.effort"),
    getSetting("ai.autoDiagnose"),
    resolveKey(),
  ]);
  const envModel = process.env.ANTHROPIC_MODEL?.trim();
  return {
    enabled,
    model: model || (envModel && KNOWN.has(envModel) ? envModel : null) || DEFAULT_MODEL,
    effort: effort ?? DEFAULT_EFFORT,
    autoDiagnose,
    keySource: key.source,
    keyHint: key.key ? maskSecret(key.key) : "",
  };
}

export class AiNotConfiguredError extends Error {
  constructor(public reason: "disabled" | "no_key") {
    super(reason === "disabled" ? "The AI agent is disabled in Settings → AI." : "No Anthropic API key configured. Add one in Settings → AI or set ANTHROPIC_API_KEY.");
  }
}

/**
 * Anthropic client. `ANTHROPIC_BASE_URL` (tests only: the local fake server, scripts/fake-anthropic.ts) is honoured;
 * the SDK retries 429/5xx itself (maxRetries 2).
 */
export async function getAnthropic(): Promise<{ client: Anthropic; config: AiConfig }> {
  const config = await getAiConfig();
  if (!config.enabled) throw new AiNotConfiguredError("disabled");
  const { key } = await resolveKey();
  if (!key) throw new AiNotConfiguredError("no_key");
  const baseURL = process.env.ANTHROPIC_BASE_URL?.trim() || undefined;
  const client = new Anthropic({ apiKey: key, baseURL, maxRetries: 2, timeout: 10 * 60_000 });
  return { client, config };
}

/**
 * Server-side refusal fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`).
 * Claude Haiku 5.5 has no server-side fallback, so the parameter is omitted there.
 */
export function supportsServerFallback(model: string): boolean {
  return !model.startsWith("claude-haiku");
}
export const FALLBACK_BETA = "server-side-fallback-2026-07-01" as const;
