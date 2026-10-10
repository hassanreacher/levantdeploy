import { z } from "zod";
import { route, json, body, requirePlatformOwner } from "@/lib/http";
import { getAiConfig } from "@/lib/ai/config";
import { AI_EFFORTS, AI_MODELS } from "@/lib/ai/types";
import { setSetting } from "@/lib/settings";
import { encryptString } from "@/lib/crypto";
import { audit } from "@/lib/audit";

/**
 * Settings → AI (platform owner).
 * GET → { enabled, model, effort, autoDiagnose, keySource: "setting"|"env"|null, keyHint: "••••abcd" }
 * PUT { enabled?, model?, effort?, autoDiagnose?, apiKey?: string | null }   (apiKey null = remove stored key)
 * The key is stored encrypted (AES-256-GCM) and never returned.
 */
async function view() {
  const c = await getAiConfig();
  return { enabled: c.enabled, model: c.model, effort: c.effort, autoDiagnose: c.autoDiagnose, keySource: c.keySource, keyHint: c.keyHint, models: AI_MODELS, efforts: AI_EFFORTS };
}

export const GET = route(async () => {
  await requirePlatformOwner();
  return json(await view());
});

const schema = z.object({
  enabled: z.boolean().optional(),
  model: z.enum(AI_MODELS.map((m) => m.id) as [string, ...string[]]).optional(),
  effort: z.enum(AI_EFFORTS).optional(),
  autoDiagnose: z.boolean().optional(),
  apiKey: z.string().trim().min(20, "That doesn't look like an Anthropic API key").max(400).nullable().optional(),
});

export const PUT = route(async (req) => {
  const actor = await requirePlatformOwner();
  const input = await body(req, schema);
  if (input.enabled !== undefined) await setSetting("ai.enabled", input.enabled);
  if (input.model !== undefined) await setSetting("ai.model", input.model);
  if (input.effort !== undefined) await setSetting("ai.effort", input.effort);
  if (input.autoDiagnose !== undefined) await setSetting("ai.autoDiagnose", input.autoDiagnose);
  if (input.apiKey !== undefined) await setSetting("ai.apiKeyEnc", input.apiKey ? encryptString(input.apiKey) : null);
  const changed = Object.keys(input).map((k) => (k === "apiKey" ? (input.apiKey ? "apiKey(set)" : "apiKey(removed)") : k));
  await audit({ action: "settings.ai.update", actor, targetType: "setting", targetId: "ai", meta: { changed } });
  return json(await view());
});
