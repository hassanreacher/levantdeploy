import { route, json, body, requirePlatformOwner } from "@/lib/http";
import { audit } from "@/lib/audit";
import { getPreferences, preferencesSchema, savePreferences } from "@/lib/llm/admin";
import { loadConfig } from "@/lib/llm/runtime";

/** GET → { preferences, custom, routing }. PUT { preferences?: { purpose: refs[] }, routing?, reset?: purposes[] }. */
export const GET = route(async () => {
  await requirePlatformOwner();
  const [p, cfg] = await Promise.all([getPreferences(), loadConfig()]);
  return json({ ...p, routing: cfg.routing });
});

export const PUT = route(async (req) => {
  const actor = await requirePlatformOwner();
  const input = await body(req, preferencesSchema);
  await savePreferences(input);
  await audit({ action: "platform.ai_preferences_update", actor, targetType: "platform", meta: { purposes: Object.keys(input.preferences ?? {}), reset: input.reset ?? [], routing: input.routing ?? null } });
  const [p, cfg] = await Promise.all([getPreferences(), loadConfig()]);
  return json({ ...p, routing: cfg.routing });
});
