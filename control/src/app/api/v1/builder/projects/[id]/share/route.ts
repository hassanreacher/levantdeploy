import { z } from "zod";
import { json, body } from "@/lib/http";
import { audit } from "@/lib/audit";
import { builderRoute, requireBuilder } from "@/lib/builder/access";
import { createShareLink, revokeShareLink, shareInfo } from "@/lib/builder/preview";

export const dynamic = "force-dynamic";

/** GET …/share → { enabled, expiresAt, createdAt } (the URL itself is only shown once, on creation) (VIEWER) */
export const GET = builderRoute<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  await requireBuilder(id, "VIEWER");
  return json(await shareInfo(id));
});

/**
 * POST …/share { enabled: true, ttlHours? } → { url, expiresAt } — new read-only preview link (replaces the old one)
 * POST …/share { enabled: false } → { url: null } — revoke. MEMBER.
 */
export const POST = builderRoute<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const input = await body(req, z.object({ enabled: z.boolean().default(true), ttlHours: z.number().int().min(1).max(24 * 90).nullable().optional() }));
  const { user, actor, team } = await requireBuilder(id, "MEMBER");
  if (!input.enabled) {
    await revokeShareLink(id);
    await audit({ action: "builder.share_revoke", teamId: team.id, actor, targetType: "builder_project", targetId: id });
    return json({ url: null, expiresAt: null, enabled: false });
  }
  const r = await createShareLink(id, { ttlHours: input.ttlHours ?? 24 * 7, userId: user.id });
  await audit({ action: "builder.share_create", teamId: team.id, actor, targetType: "builder_project", targetId: id, meta: { expiresAt: r.expiresAt } });
  return json({ ...r, enabled: true }, 201);
});

export const DELETE = builderRoute<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  const { actor, team } = await requireBuilder(id, "MEMBER");
  await revokeShareLink(id);
  await audit({ action: "builder.share_revoke", teamId: team.id, actor, targetType: "builder_project", targetId: id });
  return json({ ok: true });
});
