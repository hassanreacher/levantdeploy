import { route, json, body, requireProjectRole, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { computeNextRun } from "@/lib/runtime/cron";
import { cronDTO, cronUpdateSchema } from "@/lib/runtime/cron-api";

/** PATCH /api/v1/projects/:id/cron/:cronId { name?, schedule?, timezone?, command?, path?, enabled? } */
export const PATCH = route<{ id: string; cronId: string }>(async (req, { params }) => {
  const { id, cronId } = await params;
  const input = await body(req, cronUpdateSchema);
  const { project, team, actor } = await requireProjectRole(id, "MEMBER", { scope: "projects:write" });
  const j = await db.cronJob.findFirst({ where: { id: cronId, projectId: project.id } });
  if (!j) throw E.notFound("Cron job not found");
  const merged = { ...j, ...input };
  if (input.command !== undefined && input.command) merged.path = null;
  if (input.path !== undefined && input.path) merged.command = null;
  if (!merged.command && !merged.path) throw E.validation({ command: "Set a command or a path" });
  const job = await db.cronJob.update({
    where: { id: j.id },
    data: {
      name: merged.name,
      schedule: merged.schedule,
      timezone: merged.timezone,
      command: merged.command,
      path: merged.path,
      enabled: merged.enabled,
      nextRunAt: merged.enabled ? computeNextRun(merged) : null,
    },
  });
  await audit({ action: "cron.update", teamId: team.id, actor, targetType: "cron_job", targetId: job.id, meta: input });
  return json({ job: cronDTO(job) });
});

export const DELETE = route<{ id: string; cronId: string }>(async (_req, { params }) => {
  const { id, cronId } = await params;
  const { project, team, actor } = await requireProjectRole(id, "MEMBER", { scope: "projects:write" });
  const j = await db.cronJob.findFirst({ where: { id: cronId, projectId: project.id } });
  if (!j) throw E.notFound("Cron job not found");
  await db.cronJob.delete({ where: { id: j.id } });
  await audit({ action: "cron.delete", teamId: team.id, actor, targetType: "cron_job", targetId: j.id, meta: { name: j.name } });
  return json({ ok: true });
});
