import "server-only";
import { db } from "@/lib/db";
import { E } from "@/lib/http";
import { queues, type JobData } from "@/lib/queues";
import { DomainError } from "@/lib/domains/service";

/** Next-only helpers shared by the runtime API routes (never import from the worker). */

export async function findDeployment(idOrShort: string) {
  const d = await db.deployment.findFirst({ where: { OR: [{ id: idOrShort }, { shortId: idOrShort }] }, include: { project: true } });
  if (!d) throw E.notFound("Deployment not found");
  return d;
}

export function domainErr(e: unknown): never {
  if (e instanceof DomainError) {
    if (e.code === "NOT_FOUND") throw E.notFound(e.message);
    if (e.code === "CONFLICT") throw E.conflict(e.message);
    throw E.validation({ [e.field]: e.message }, e.message);
  }
  throw e;
}

/** Enqueue a runtime action on the deploy queue (unique job id per call). */
export async function enqueueAction(deploymentId: string, action: NonNullable<JobData["deploy"]["action"]>, extra: Partial<JobData["deploy"]> = {}) {
  const job = await queues.deploy.add({ deploymentId, action, ...extra }, { jobId: `${action}-${deploymentId}-${Date.now()}` });
  return job.id!;
}

// ───────────────────────────── databases ─────────────────────────────
import type { TeamRole } from "@prisma/client";
import { requireTeamRole } from "@/lib/http";

export async function requireDatabase(id: string, min: TeamRole, scope: string) {
  const database = await db.database.findUnique({ where: { id }, include: { project: { select: { id: true, slug: true, name: true } } } });
  if (!database) throw E.notFound("Database not found");
  const access = await requireTeamRole(database.teamId, min, { scope });
  return { ...access, database };
}
