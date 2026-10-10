import { z } from "zod";
import { json, body } from "@/lib/http";
import { audit } from "@/lib/audit";
import { builderRoute, requireBuilder } from "@/lib/builder/access";
import { getPreviewErrors, issuePreviewToken, previewState, requestPreview, touchPreview } from "@/lib/builder/preview";

export const dynamic = "force-dynamic";

async function state(id: string, userId: string, role: string) {
  const st = await previewState(id);
  // iframe URL: short-lived SSO link that sets the preview cookie (MEMBER+); VIEWERs get the plain URL
  const sso = role !== "VIEWER" ? await issuePreviewToken(id, userId).catch(() => null) : null;
  const errors = await getPreviewErrors(id, { limit: 20 });
  return { ...st, url: sso?.url ?? st.publicUrl, ssoExpiresIn: sso?.expiresIn ?? null, errors };
}

/** GET …/preview → { status, url (SSO iframe URL), publicUrl, host, error, errors[], startedAt, lastActiveAt, container } (VIEWER) */
export const GET = builderRoute<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  const { user, role } = await requireBuilder(id, "VIEWER");
  if (role !== "VIEWER") await touchPreview(id);
  return json(await state(id, user.id, role));
});

/** POST …/preview { action: "start" | "restart" | "stop" } → state (MEMBER). The worker does the work (queue builder-preview). */
export const POST = builderRoute<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const input = await body(req, z.object({ action: z.enum(["start", "restart", "stop"]).default("start") }));
  const { user, role, actor, team } = await requireBuilder(id, "MEMBER");
  await requestPreview(id, input.action, { byUserId: user.id, reason: "requested" });
  if (input.action !== "start") await audit({ action: `builder.preview_${input.action}`, teamId: team.id, actor, targetType: "builder_project", targetId: id });
  return json(await state(id, user.id, role), 202);
});
