import { route, json, body, requireProjectRole, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { computeNextRun } from "@/lib/runtime/cron";
import { cronDTO, cronSchema } from "@/lib/runtime/cron-api";

export const dynamic = "force-dynamic";

/** GET /api/v1/projects/:id/cron → { items } */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  const { project } = await requireProjectRole(id, "VIEWER", { scope: "projects:read" });
  const rows = await db.cronJob.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "asc" } });
  return json({ items: rows.map(cronDTO) });
});

/** POST /api/v1/projects/:id/cron { name, schedule, timezone?, command? | path?, enabled? } → 201 { job } */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const input = await body(req, cronSchema);
  const { project, team, actor } = await requireProjectRole(id, "MEMBER", { scope: "projects:write" });
  if (project.kind === "STATIC" && input.command) throw E.validation({ command: "Static projects can only call a path" });
  if ((await db.cronJob.count({ where: { projectId: project.id } })) >= 50) throw E.conflict("A project can have at most 50 cron jobs");
  const data = { projectId: project.id, name: input.name, schedule: input.schedule, timezone: input.timezone, command: input.command ?? null, path: input.path ?? null, enabled: input.enabled };
  const job = await db.cronJob.create({ data: { ...data, nextRunAt: computeNextRun(data) } });
  await audit({ action: "cron.create", teamId: team.id, actor, targetType: "cron_job", targetId: job.id, meta: { name: job.name, schedule: job.schedule } });
  return json({ job: cronDTO(job) }, 201);
});
