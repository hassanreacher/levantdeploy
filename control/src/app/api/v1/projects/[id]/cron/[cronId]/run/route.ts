import { route, json, requireProjectRole, throttle, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { queues } from "@/lib/queues";

/** POST /api/v1/projects/:id/cron/:cronId/run → 202 { runId }  ("Run now") */
export const POST = route<{ id: string; cronId: string }>(async (_req, { params }) => {
  const { id, cronId } = await params;
  const { project, team, actor } = await requireProjectRole(id, "MEMBER", { scope: "projects:write" });
  await throttle(`cron-run:${cronId}`, { limit: 6, window: 60 });
  const j = await db.cronJob.findFirst({ where: { id: cronId, projectId: project.id } });
  if (!j) throw E.notFound("Cron job not found");
  const run = await db.cronRun.create({ data: { cronJobId: j.id, status: "RUNNING", trigger: "MANUAL" } });
  await queues.cron.add({ cronJobId: j.id, manual: true, runId: run.id }, { jobId: `cron-${j.id}-manual-${run.id}` });
  await audit({ action: "cron.run", teamId: team.id, actor, targetType: "cron_job", targetId: j.id, meta: { name: j.name } });
  return json({ runId: run.id }, 202);
});
