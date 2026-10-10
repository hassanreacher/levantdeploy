import { z } from "zod";
import { route, json, body, query, requireProjectRole, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { docker } from "@/lib/docker";
import { volumeDTO, volumeSchema } from "@/lib/runtime/volumes";

/** PATCH /api/v1/projects/:id/volumes/:volumeId { mountPath?, sizeHint? } (name is immutable: it's the docker volume) */
export const PATCH = route<{ id: string; volumeId: string }>(async (req, { params }) => {
  const { id, volumeId } = await params;
  const input = await body(req, volumeSchema.pick({ mountPath: true, sizeHint: true }).partial());
  const { project, team, actor } = await requireProjectRole(id, "ADMIN", { scope: "projects:write" });
  const v = await db.volume.findFirst({ where: { id: volumeId, projectId: project.id } });
  if (!v) throw E.notFound("Volume not found");
  if (input.mountPath && (await db.volume.findFirst({ where: { projectId: project.id, mountPath: input.mountPath, NOT: { id: v.id } } })))
    throw E.conflict(`Another volume is already mounted at ${input.mountPath}`);
  const u = await db.volume.update({ where: { id: v.id }, data: { ...(input.mountPath ? { mountPath: input.mountPath } : {}), ...(input.sizeHint !== undefined ? { sizeHint: input.sizeHint || null } : {}) } });
  await audit({ action: "volume.update", teamId: team.id, actor, targetType: "volume", targetId: v.id, meta: input });
  return json({ volume: await volumeDTO(u) });
});

/** DELETE /api/v1/projects/:id/volumes/:volumeId?purge=1  (purge also deletes the docker volume = data, when unused) */
export const DELETE = route<{ id: string; volumeId: string }>(async (req, { params }) => {
  const { id, volumeId } = await params;
  const { purge } = query(req, z.object({ purge: z.enum(["0", "1"]).default("0") }));
  const { project, team, actor } = await requireProjectRole(id, "ADMIN", { scope: "projects:write" });
  const v = await db.volume.findFirst({ where: { id: volumeId, projectId: project.id } });
  if (!v) throw E.notFound("Volume not found");
  let purged = false;
  if (purge === "1" && v.dockerName) {
    try {
      await docker().getVolume(v.dockerName).remove();
      purged = true;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 409) throw E.conflict("The volume is still used by running containers — the next deploy detaches it; delete again afterwards to purge the data");
      if (code !== 404) throw e;
    }
  }
  await db.volume.delete({ where: { id: v.id } });
  await audit({ action: "volume.delete", teamId: team.id, actor, targetType: "volume", targetId: v.id, meta: { name: v.name, purged } });
  return json({ ok: true, purged });
});
