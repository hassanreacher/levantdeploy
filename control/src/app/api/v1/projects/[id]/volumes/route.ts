import { route, json, body, requireProjectRole, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { volumeDockerName } from "@/lib/runtime/containers";
import { volumeDTO, volumeSchema } from "@/lib/runtime/volumes";

export const dynamic = "force-dynamic";

/** GET /api/v1/projects/:id/volumes → { items } (sizeBytes from `docker system df` when available) */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  const { project } = await requireProjectRole(id, "VIEWER", { scope: "projects:read" });
  const rows = await db.volume.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "asc" } });
  return json({ items: await Promise.all(rows.map(volumeDTO)) });
});

/** POST /api/v1/projects/:id/volumes { name, mountPath, sizeHint? } → 201 { volume }  (applies on the next deploy) */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const input = await body(req, volumeSchema);
  const { project, team, actor } = await requireProjectRole(id, "ADMIN", { scope: "projects:write" });
  if (await db.volume.findUnique({ where: { projectId_name: { projectId: project.id, name: input.name } } })) throw E.conflict(`A volume named "${input.name}" already exists`);
  if (await db.volume.findFirst({ where: { projectId: project.id, mountPath: input.mountPath } })) throw E.conflict(`Another volume is already mounted at ${input.mountPath}`);
  const v = await db.volume.create({ data: { projectId: project.id, name: input.name, mountPath: input.mountPath, sizeHint: input.sizeHint ?? null, dockerName: volumeDockerName(project.id, input.name) } });
  await audit({ action: "volume.create", teamId: team.id, actor, targetType: "volume", targetId: v.id, meta: { name: v.name, mountPath: v.mountPath } });
  return json({ volume: await volumeDTO(v) }, 201);
});

