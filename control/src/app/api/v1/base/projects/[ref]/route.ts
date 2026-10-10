import { z } from "zod";
import { route, json, body, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { stackAction } from "@/lib/base-ui/adapters";
import { requireBaseRole } from "@/lib/base-ui/access";
import { baseInclude, toBaseDTO } from "@/lib/base-ui/dto";
import { BASE_NAME_RE } from "@/lib/base-ui/shared";

export const dynamic = "force-dynamic";

/** GET /api/v1/base/projects/:ref — VIEWER. Never returns secrets. */
export const GET = route<{ ref: string }>(async (_req, { params }) => {
  const { ref } = await params;
  const { base } = await requireBaseRole(ref, "VIEWER");
  return json({ project: toBaseDTO(base) });
});

const patchSchema = z.object({ name: z.string().trim().min(1).max(63).regex(BASE_NAME_RE, "Use letters, digits, spaces, dots, dashes or underscores") });

/** PATCH /api/v1/base/projects/:ref { name } — ADMIN. */
export const PATCH = route<{ ref: string }>(async (req, { params }) => {
  const { ref } = await params;
  const input = await body(req, patchSchema);
  const { base, team, actor } = await requireBaseRole(ref, "ADMIN");
  const row = await db.baseProject.update({ where: { id: base.id }, data: { name: input.name }, include: baseInclude });
  await audit({ action: "base.update", teamId: team.id, actor, targetType: "base_project", targetId: base.id, meta: { ref, from: base.name, to: input.name } });
  return json({ project: toBaseDTO(row) });
});

/** DELETE /api/v1/base/projects/:ref?confirm=<ref> — ADMIN. Stops + removes the stack and all data (runtime job). */
export const DELETE = route<{ ref: string }>(async (req, { params }) => {
  const { ref } = await params;
  const confirm = new URL(req.url).searchParams.get("confirm")?.trim();
  const { base, team, actor } = await requireBaseRole(ref, "ADMIN");
  if (confirm !== base.ref && confirm !== base.name) throw E.validation({ confirm: `Type "${base.name}" to confirm` });
  if (base.status === "DELETING") return json({ ok: true });
  await stackAction(ref, "delete", { actorId: actor.user.id });
  await audit({ action: "base.delete", teamId: team.id, actor, targetType: "base_project", targetId: base.id, meta: { ref, name: base.name } });
  return json({ ok: true });
});
