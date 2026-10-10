import { route, json, throttle, E } from "@/lib/http";
import { audit } from "@/lib/audit";
import { studioSsoUrl, studioState } from "@/lib/base-ui/adapters";
import { requireBaseRole } from "@/lib/base-ui/access";

export const dynamic = "force-dynamic";

/** GET — Studio state (VIEWER). */
export const GET = route<{ ref: string }>(async (_req, { params }) => {
  const { ref } = await params;
  await requireBaseRole(ref, "VIEWER");
  return json({ state: await studioState(ref).catch(() => "stopped") });
});

/**
 * POST /api/v1/base/projects/:ref/studio — MEMBER (VIEWER can't use Studio: it has no read-only mode); session or token (base:write).
 * Starts Studio if needed and returns a one-time SSO URL `{ url, starting }` to open in a new tab. Audited.
 */
export const POST = route<{ ref: string }>(async (_req, { params }) => {
  const { ref } = await params;
  // sessions or API tokens with the base:write scope (CLI `levant base studio`) — MEMBER+ either way
  const { base, team, actor } = await requireBaseRole(ref, "MEMBER", { scope: "base:write" });
  if (base.status !== "ACTIVE") throw E.conflict(base.status === "PAUSED" ? "The project is paused. Restore it first." : "The project is not running yet");
  await throttle(`base:studio:${actor.user.id}`, { limit: 30, window: 300 });
  const r = await studioSsoUrl(ref, actor.user.id);
  await audit({ action: "base.studio_open", teamId: team.id, actor, targetType: "base_project", targetId: base.id, meta: { ref } });
  return json(r, { headers: { "cache-control": "no-store" } });
});
