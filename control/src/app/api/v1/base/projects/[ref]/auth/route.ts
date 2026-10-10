import { route, json, body, throttle, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { updateSettings } from "@/lib/base-ui/adapters";
import { requireBaseRole } from "@/lib/base-ui/access";
import { authSettingsView, dashboardSettingsPatchSchema } from "@/lib/base-ui/settings";

export const dynamic = "force-dynamic";

/** GET /api/v1/base/projects/:ref/auth — auth/SMTP/template settings without secrets (MEMBER). */
export const GET = route<{ ref: string }>(async (_req, { params }) => {
  const { ref } = await params;
  const { base } = await requireBaseRole(ref, "MEMBER", { scope: "base:read" });
  return json({ settings: authSettingsView(base.settings) });
});

/**
 * PATCH /api/v1/base/projects/:ref/auth { auth?, smtp?, providers?, authExtra?, api?, functions?, templates? } — ADMIN.
 * Secrets in plain text are encrypted by the runtime; omitted secrets are kept. Saves + enqueues the settings-apply job.
 */
export const PATCH = route<{ ref: string }>(async (req, { params }) => {
  const { ref } = await params;
  const patch = await body(req, dashboardSettingsPatchSchema);
  const { base, team, actor } = await requireBaseRole(ref, "ADMIN");
  await throttle(`base:settings:${actor.user.id}`, { limit: 30, window: 60 });
  if (patch.functions?.secrets) throw E.bad("Use /secrets to change function secrets");
  const sections = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  await updateSettings(ref, patch, actor.user.id);
  const row = await db.baseProject.findUniqueOrThrow({ where: { id: base.id } });
  await audit({ action: "base.settings.update", teamId: team.id, actor, targetType: "base_project", targetId: base.id, meta: { ref, sections } });
  return json({ settings: authSettingsView(row.settings), applying: base.status === "ACTIVE" });
});
