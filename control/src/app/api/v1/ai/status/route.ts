import { route, json, requireApiTokenOrSession } from "@/lib/http";
import { getAiConfig } from "@/lib/ai/config";

/** GET /api/v1/ai/status → whether the agent can be used (no secrets). */
export const GET = route(async () => {
  const actor = await requireApiTokenOrSession();
  const c = await getAiConfig();
  return json({
    enabled: c.enabled,
    configured: c.enabled && !!c.keySource,
    model: c.model,
    effort: c.effort,
    autoDiagnose: c.autoDiagnose,
    canConfigure: actor.user.isPlatformOwner,
  });
});
