import { Prisma, type Deployment, type DeploymentStatus, type DeploymentTarget, type DeploymentTrigger } from "@prisma/client";
import { assertCanDeploy } from "@/lib/plans/enforce";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { randomId } from "@/lib/crypto";
import { queues } from "@/lib/queues";
import { appendLog } from "@/lib/logs";
import { emitStatusChange } from "@/lib/hooks";

/**
 * Deployment contract shared by every area (see docs/SPEC.md "Lifecycle").
 *
 *   const d = await createDeployment({ projectId, target: "PREVIEW", source: { branch, commitSha }, trigger: "GIT_PUSH" });
 *   await setStatus(d.id, "BUILDING");                       // build worker
 *   await setStatus(d.id, "DEPLOYING", { imageTag });         // build worker → then queues.deploy.add({deploymentId})
 *   await setStatus(d.id, "READY");                           // deploy worker
 *   await setStatus(d.id, "ERROR", { errorMessage: "…", errorStep: "BUILD" });
 *   await cancelDeployment(d.id, userId);
 *   if (await isCancelRequested(d.id)) throw new Error("canceled");
 */

// ───────────────────────────── URLs ─────────────────────────────

function platformDomain() {
  return (process.env.PLATFORM_DOMAIN || "levant.localhost").toLowerCase();
}
function scheme() {
  return process.env.PLATFORM_SCHEME || (process.env.NODE_ENV === "production" ? "https" : "http");
}

/** DNS-label safe: lowercase [a-z0-9-], no leading/trailing dashes, ≤ max chars. */
export function dnsLabel(s: string, max = 63): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, max)
      .replace(/-$/, "") || "app"
  );
}

/** Short random id for deployment URLs (9 chars [a-z0-9]). */
export const shortId = () => randomId(9);

/** `{project}-{shortid}.{PLATFORM_DOMAIN}` (project part truncated so the label stays ≤ 63 chars). */
export function deploymentHost(projectSlug: string, sid: string): string {
  return `${dnsLabel(projectSlug, 63 - sid.length - 1)}-${sid}.${platformDomain()}`;
}

/** Production host: `{project}.{PLATFORM_DOMAIN}`. */
export function projectHost(projectSlug: string): string {
  return `${dnsLabel(projectSlug)}.${platformDomain()}`;
}

/** Latest preview of a branch: `{project}-git-{branch}.{PLATFORM_DOMAIN}`. */
export function branchHost(projectSlug: string, branch: string): string {
  const b = dnsLabel(branch, 30);
  return `${dnsLabel(projectSlug, 63 - 5 - b.length)}-git-${b}.${platformDomain()}`;
}

/** Full URL for a host (adds PLATFORM_SCHEME). */
export const hostUrl = (host: string) => `${scheme()}://${host}`;

export const deploymentUrl = (d: Pick<Deployment, "url">) => hostUrl(d.url);

// ───────────────────────────── Status machine ─────────────────────────────

export const ACTIVE_STATUSES: DeploymentStatus[] = ["QUEUED", "BUILDING", "DEPLOYING"];
export const FINAL_STATUSES: DeploymentStatus[] = ["READY", "ERROR", "CANCELED", "SUPERSEDED"];

/** Allowed transitions. READY ⇄ SUPERSEDED covers promote / rollback. */
export const TRANSITIONS: Record<DeploymentStatus, DeploymentStatus[]> = {
  QUEUED: ["BUILDING", "DEPLOYING", "ERROR", "CANCELED"],
  BUILDING: ["DEPLOYING", "ERROR", "CANCELED"],
  DEPLOYING: ["READY", "ERROR", "CANCELED"],
  READY: ["SUPERSEDED", "ERROR"],
  SUPERSEDED: ["READY", "DEPLOYING"],
  ERROR: [],
  CANCELED: [],
};

export const canTransition = (from: DeploymentStatus, to: DeploymentStatus) => TRANSITIONS[from].includes(to);

export class TransitionError extends Error {
  constructor(public from: DeploymentStatus, public to: DeploymentStatus) {
    super(`Invalid deployment status transition ${from} → ${to}`);
  }
}

export type StatusEvent = { deploymentId: string; projectId: string; status: DeploymentStatus; from: DeploymentStatus; at: number };
/** Redis pub/sub channel carrying StatusEvent JSON for every transition (live dashboards). */
export const STATUS_CHANNEL = "ld:deployments:status";

// ───────────────────────────── Create ─────────────────────────────

export type DeploymentSource = {
  branch?: string | null;
  commitSha?: string | null;
  commitMessage?: string | null;
  commitAuthor?: string | null;
  commitAuthorAvatar?: string | null;
  prNumber?: number | null;
  uploadId?: string | null;
  /** redeploy / promote / rollback origin */
  sourceDeploymentId?: string | null;
};

export type CreateDeploymentInput = {
  projectId: string;
  target: DeploymentTarget;
  source?: DeploymentSource;
  trigger?: DeploymentTrigger;
  createdById?: string | null;
  meta?: Prisma.InputJsonObject;
  /** default true: enqueue the build job. Pass false when you enqueue something else yourself (e.g. promote → deploy). */
  enqueue?: boolean;
};

/** Creates a QUEUED deployment (number, shortId, url) and enqueues `build`. */
export async function createDeployment(input: CreateDeploymentInput): Promise<Deployment> {
  const project = await db.project.findUnique({ where: { id: input.projectId }, select: { id: true, slug: true, framework: true, teamId: true } });
  if (!project) throw new Error(`Project ${input.projectId} not found`);
  // plans area: deployments/day, monthly bandwidth, preview deployments, email verification → PlanLimitError (402) / EmailUnverifiedError (403)
  await assertCanDeploy(project.teamId, { userId: input.createdById, preview: input.target === "PREVIEW" });
  const s = input.source ?? {};
  let dep: Deployment | null = null;
  for (let attempt = 0; attempt < 5 && !dep; attempt++) {
    try {
      dep = await db.$transaction(async (tx) => {
        const last = await tx.deployment.findFirst({ where: { projectId: project.id }, orderBy: { number: "desc" }, select: { number: true } });
        const sid = shortId();
        return tx.deployment.create({
          data: {
            projectId: project.id,
            number: (last?.number ?? 0) + 1,
            shortId: sid,
            url: deploymentHost(project.slug, sid),
            target: input.target,
            status: "QUEUED",
            trigger: input.trigger ?? "MANUAL",
            branch: s.branch ?? null,
            commitSha: s.commitSha ?? null,
            commitMessage: s.commitMessage?.slice(0, 2000) ?? null,
            commitAuthor: s.commitAuthor ?? null,
            commitAuthorAvatar: s.commitAuthorAvatar ?? null,
            prNumber: s.prNumber ?? null,
            uploadId: s.uploadId ?? null,
            sourceDeploymentId: s.sourceDeploymentId ?? null,
            framework: project.framework,
            createdById: input.createdById ?? null,
            meta: input.meta ?? {},
            events: { create: { status: "QUEUED", message: "Deployment queued" } },
          },
        });
      });
    } catch (e) {
      // unique (projectId, number) / shortId race → retry
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") continue;
      throw e;
    }
  }
  if (!dep) throw new Error("Could not allocate deployment number");
  await db.project.update({ where: { id: project.id }, data: { lastDeployedAt: new Date() } });
  await publishStatus({ deploymentId: dep.id, projectId: dep.projectId, status: "QUEUED", from: "QUEUED", at: Date.now() });
  if (input.enqueue !== false) {
    await appendLog(dep.id, "BUILD", `Deployment #${dep.number} queued (${dep.target.toLowerCase()})`).catch(() => {});
    await queues.build.add({ deploymentId: dep.id });
  }
  return dep;
}

// ───────────────────────────── Transitions ─────────────────────────────

export type SetStatusExtra = {
  errorMessage?: string;
  errorStep?: string;
  imageTag?: string;
  containerIds?: Prisma.InputJsonValue;
  /** timeline message (DeploymentEvent.message) */
  message?: string;
  meta?: Prisma.InputJsonObject;
};

/**
 * Atomic compare-and-set transition (throws TransitionError if the current status doesn't allow it,
 * e.g. the deployment was CANCELED meanwhile — workers should stop on that error).
 * Sets timestamps: BUILDING→buildStartedAt, DEPLOYING→buildFinishedAt+deployStartedAt, READY→readyAt+duration,
 * ERROR/CANCELED→finishedAt+duration. Writes a DeploymentEvent, publishes on STATUS_CHANNEL and enqueues `notify`
 * for READY / ERROR.
 */
export async function setStatus(deploymentId: string, to: DeploymentStatus, extra: SetStatusExtra = {}): Promise<Deployment> {
  const cur = await db.deployment.findUnique({ where: { id: deploymentId } });
  if (!cur) throw new Error(`Deployment ${deploymentId} not found`);
  if (!canTransition(cur.status, to)) throw new TransitionError(cur.status, to);
  const now = new Date();
  const data: Prisma.DeploymentUpdateManyMutationInput = { status: to };
  if (to === "BUILDING") data.buildStartedAt = now;
  if (to === "DEPLOYING") {
    if (cur.status === "BUILDING") data.buildFinishedAt = now;
    data.deployStartedAt = now;
  }
  if (to === "READY") {
    data.readyAt = now;
    data.finishedAt = now;
    data.duration = now.getTime() - cur.createdAt.getTime();
    data.errorMessage = null;
    data.stoppedAt = null;
  }
  if (to === "ERROR" || to === "CANCELED") {
    data.finishedAt = now;
    data.duration = now.getTime() - cur.createdAt.getTime();
    if (cur.status === "BUILDING" && !cur.buildFinishedAt) data.buildFinishedAt = now;
  }
  if (extra.errorMessage !== undefined) data.errorMessage = extra.errorMessage.slice(0, 4000);
  if (extra.errorStep !== undefined) data.errorStep = extra.errorStep;
  if (extra.imageTag !== undefined) data.imageTag = extra.imageTag;
  if (extra.containerIds !== undefined) data.containerIds = extra.containerIds;
  if (extra.meta) data.meta = { ...((cur.meta as Prisma.JsonObject) ?? {}), ...extra.meta };

  const res = await db.deployment.updateMany({ where: { id: deploymentId, status: cur.status }, data });
  if (res.count === 0) {
    const now2 = await db.deployment.findUnique({ where: { id: deploymentId }, select: { status: true } });
    throw new TransitionError(now2?.status ?? cur.status, to);
  }
  await db.deploymentEvent.create({
    data: { deploymentId, fromStatus: cur.status, status: to, message: extra.message ?? extra.errorMessage?.slice(0, 500) ?? null },
  });
  const updated = (await db.deployment.findUnique({ where: { id: deploymentId } }))!;
  await publishStatus({ deploymentId, projectId: cur.projectId, status: to, from: cur.status, at: now.getTime() });
  void emitStatusChange(updated, cur.status); // git area: GitHub commit statuses / deployments / PR comment (src/lib/hooks.ts)
  if (to === "READY" || to === "ERROR") {
    await queues.notify
      .add({ event: to === "READY" ? "deployment.ready" : "deployment.error", projectId: cur.projectId, deploymentId })
      .catch((e) => console.warn("[deployments] notify enqueue failed", (e as Error).message));
  }
  return updated;
}

async function publishStatus(ev: StatusEvent) {
  await redis()
    .publish(STATUS_CHANNEL, JSON.stringify(ev))
    .catch(() => {});
}

// ───────────────────────────── Cancel ─────────────────────────────

const cancelKey = (id: string) => `ld:cancel:${id}`;

/** Workers poll this between steps (and may SUBSCRIBE to `ld:cancel` for instant aborts). */
export async function isCancelRequested(deploymentId: string): Promise<boolean> {
  return (await redis().exists(cancelKey(deploymentId))) === 1;
}

/**
 * Cancels a QUEUED/BUILDING/DEPLOYING deployment: removes waiting jobs, sets a cancel flag the
 * build/deploy workers check (`isCancelRequested`), publishes on `ld:cancel` and marks it CANCELED.
 */
export async function cancelDeployment(deploymentId: string, byUserId?: string | null): Promise<Deployment> {
  const cur = await db.deployment.findUnique({ where: { id: deploymentId } });
  if (!cur) throw new Error("Deployment not found");
  if (!ACTIVE_STATUSES.includes(cur.status)) throw new TransitionError(cur.status, "CANCELED");
  const r = redis();
  await r.set(cancelKey(deploymentId), byUserId || "1", "EX", 86400);
  await r.publish("ld:cancel", deploymentId).catch(() => {});
  await queues.build.remove(`build-${deploymentId}`).catch(() => false);
  await queues.deploy.remove(`deploy-${deploymentId}`).catch(() => false);
  const d = await setStatus(deploymentId, "CANCELED", { message: "Canceled by user" });
  await appendLog(deploymentId, "BUILD", "Deployment canceled.").catch(() => {});
  return d;
}

// ───────────────────────────── Queries ─────────────────────────────

/** Current production deployment of a project (or null). */
export function currentProduction(projectId: string) {
  return db.deployment.findFirst({ where: { projectId, isCurrentProduction: true }, orderBy: { createdAt: "desc" } });
}

/** Mark one deployment as the current production one (clears the flag on the others) — used by runtime on promote/rollback. */
export async function markCurrentProduction(projectId: string, deploymentId: string) {
  await db.$transaction([
    db.deployment.updateMany({ where: { projectId, isCurrentProduction: true, NOT: { id: deploymentId } }, data: { isCurrentProduction: false } }),
    db.deployment.update({ where: { id: deploymentId }, data: { isCurrentProduction: true } }),
  ]);
}
