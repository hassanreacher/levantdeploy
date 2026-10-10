import { z } from "zod";
import { route, json, body, requirePlatformOwner } from "@/lib/http";
import { audit } from "@/lib/audit";
import { llm } from "@/lib/llm";

/** POST { scope? } → clear cooldowns/health counters (all, a provider, or "provider/model"). */
export const POST = route(async (req) => {
  const actor = await requirePlatformOwner();
  const input = await body(req, z.object({ scope: z.string().min(1).max(300).optional() }).default({}));
  await llm.health.reset(input.scope);
  await audit({ action: "platform.ai_provider_health_reset", actor, targetType: "ai_provider", targetId: input.scope ?? null });
  return json({ ok: true });
});
