import { effectiveKind } from "@/lib/build/types";
import type { Deployment, Prisma, Project } from "@prisma/client";
import { db } from "@/lib/db";
import { queues } from "@/lib/queues";
import { appendLog, archiveLogs, endLogs, logKey } from "@/lib/logs";
import { redis } from "@/lib/redis";
import { currentProduction, deploymentUrl, isCancelRequested, markCurrentProduction, setStatus, TransitionError } from "@/lib/deployments";
import { getSetting } from "@/lib/settings";
import { syncRoutes } from "@/lib/proxy/sync";
import { ensurePlatformDomain } from "@/lib/domains/platform";
import {
  containerRefs,
  createAppContainer,
  inspectSafe,
  removeContainer,
  startContainer,
  stopContainer,
  type ContainerRef,
} from "./containers";
import { HealthError, waitHealthy } from "./health";
import { drainSeconds, healthConfig, runtimeSettings } from "./settings";
import { withProjectLock } from "./lock";
import { composeDown, composeStart, composeStop, startCompose } from "./compose";

export class RuntimeError extends Error {
  constructor(
    message: string,
    public step: "DEPLOY" | "HEALTHCHECK" | "ROUTING" = "DEPLOY",
    public logs = "",
  ) {
    super(message);
  }
}

type DepWithProject = Deployment & { project: Project };

const logger = (id: string) => async (line: string | string[]) => {
  await appendLog(id, "BUILD", line).catch(() => {});
};

/**
 * The build area ends + archives the BUILD stream when it hands over to deploy; the deploy phase keeps writing to
 * the same stream, so re-open it (drop the end marker) so live viewers keep following until READY/ERROR.
 */
export async function reopenLogs(deploymentId: string, stream: "BUILD" | "RUNTIME" = "BUILD") {
  const r = redis();
  await r.del(`ld:logs:end:${deploymentId}:${stream}`).catch(() => {});
  const key = logKey(deploymentId, stream);
  const tail = (await r.xrevrange(key, "+", "-", "COUNT", 50).catch(() => [])) as Array<[string, string[]]>;
  const ends = tail.filter(([, f]) => f.includes("e")).map(([id]) => id);
  if (ends.length) await r.xdel(key, ...ends).catch(() => {});
  await r.persist(key).catch(() => {});
}

async function load(id: string): Promise<DepWithProject> {
  const d = await db.deployment.findUnique({ where: { id }, include: { project: true } });
  if (!d) throw new RuntimeError("Deployment not found");
  // build area: the kind detected at build time (meta.build.kind, e.g. COMPOSE) wins over Project.kind
  return { ...d, project: { ...d.project, kind: effectiveKind(d.meta, d.project.kind) } };
}

/** Start N replicas and wait until all of them are healthy. Removes everything on failure. */
export async function startReplicas(
  project: Project,
  dep: Deployment,
  replicaNumbers: number[],
  log: (l: string | string[]) => Promise<void>,
): Promise<ContainerRef[]> {
  const created: ContainerRef[] = [];
  const cfg = healthConfig(project);
  try {
    for (const n of replicaNumbers) {
      const ref = await createAppContainer(project, dep, n);
      created.push(ref);
      await log(`Started replica ${n} (${ref.name})`);
    }
    await log(
      cfg.type === "http"
        ? `Waiting for health check: HTTP GET ${cfg.path} on port ${project.port}…`
        : cfg.type === "tcp"
          ? `Waiting for TCP port ${project.port}…`
          : `Waiting for the worker to stay up for ${cfg.stableMs / 1000}s…`,
    );
    await Promise.all(
      created.map(async (ref) => {
        const r = await waitHealthy(ref, cfg, { onLog: (l) => void log(l), isCanceled: () => isCancelRequested(dep.id) });
        await log(`Replica ${ref.replica} healthy in ${(r.ms / 1000).toFixed(1)}s${r.status ? ` (HTTP ${r.status})` : ""}`);
      }),
    );
    return created;
  } catch (e) {
    for (const r of created) await removeContainer(r.id).catch(() => {});
    if (e instanceof HealthError) throw new RuntimeError(e.message, "HEALTHCHECK", e.logs);
    throw e;
  }
}

async function removeRefs(refs: ContainerRef[]) {
  for (const r of refs) await removeContainer(r.id).catch(() => {});
}

/** Deploy job: DEPLOYING (with imageTag) → containers → health → READY → routes. */
export async function runDeploy(deploymentId: string): Promise<void> {
  let dep = await load(deploymentId);
  const log = logger(dep.id);
  if (dep.status !== "DEPLOYING") {
    await log(`Deploy skipped: deployment is ${dep.status}`);
    return;
  }
  const project = dep.project;
  let refs: ContainerRef[] = [];
  await reopenLogs(dep.id);
  try {
    if (!dep.imageTag) throw new RuntimeError("The build did not produce an image");
    if (project.pausedAt) throw new RuntimeError("Project is paused");
    await ensurePlatformDomain(project);
    const replicas = project.kind === "COMPOSE" ? 1 : Math.max(1, project.replicas);
    await log(`Deploying ${dep.imageTag} (${project.kind.toLowerCase()}, ${replicas} replica${replicas > 1 ? "s" : ""})`);
    if (project.kind === "COMPOSE") {
      refs = await startCompose(project, dep, log);
    } else {
      refs = await startReplicas(
        project,
        dep,
        Array.from({ length: replicas }, (_, i) => i + 1),
        log,
      );
    }
    if (await isCancelRequested(dep.id)) throw new RuntimeError("Canceled");
    try {
      dep = { ...(await setStatus(dep.id, "READY", { containerIds: refs as unknown as Prisma.InputJsonValue, message: "Deployment is ready" })), project };
    } catch (e) {
      if (e instanceof TransitionError) {
        await log(`Deployment became ${e.from} meanwhile — removing containers`);
        await cleanupFailed(project, dep, refs);
        return;
      }
      throw e;
    }
    if (dep.target === "PRODUCTION") {
      await switchProduction(project, dep.id, log);
    } else {
      const r = await syncRoutes();
      await log(r.ok ? `Routes updated (${r.sites} sites)` : `⚠ Proxy not updated: ${r.error}`);
      await scheduleOldPreviewStop(project, dep);
    }
    await log(`✓ Ready: ${deploymentUrl(dep)}`);
  } catch (e) {
    const err = e instanceof RuntimeError ? e : new RuntimeError((e as Error).message, "DEPLOY", (e as { logs?: string }).logs ?? "");
    if (err.message !== "Canceled") {
      await log(`✗ ${err.message}`);
      if (err.logs) await log(["── last container logs ──", ...err.logs.split("\n").slice(-60), "──"]).catch(() => {});
    }
    await cleanupFailed(project, dep, refs);
    const msg = err.logs ? `${err.message}\n\nLast logs:\n${err.logs.split("\n").slice(-40).join("\n")}` : err.message;
    if (err.message === "Canceled") {
      // cancelDeployment() already set CANCELED
    } else {
      await setStatus(dep.id, "ERROR", { errorMessage: msg, errorStep: err.step }).catch(() => {});
    }
  } finally {
    await endLogs(dep.id, "BUILD").catch(() => {});
    await archiveLogs(dep.id, "BUILD").catch(() => {});
  }
}

async function cleanupFailed(project: Project, dep: Deployment, refs: ContainerRef[]) {
  if (project.kind === "COMPOSE") await composeDown(dep).catch(() => {});
  else await removeRefs(refs);
}

/**
 * Point production at `newId`: mark current, sync routes (new containers start receiving traffic), mark the previous
 * production SUPERSEDED and stop it after the drain period (kept stopped for instant rollback).
 */
export async function switchProduction(project: Project, newId: string, log: (l: string | string[]) => Promise<void>) {
  await withProjectLock(project.id, async () => {
    const prev = await currentProduction(project.id);
    await markCurrentProduction(project.id, newId);
    const r = await syncRoutes({ immediate: true });
    await log(r.ok ? `Production traffic switched to this deployment (${r.sites} sites routed)` : `⚠ Proxy not updated: ${r.error}`);
    if (prev && prev.id !== newId) {
      if (prev.status === "READY") {
        const nd = await db.deployment.findUnique({ where: { id: newId }, select: { number: true } });
        await setStatus(prev.id, "SUPERSEDED", { message: `Superseded by #${nd?.number ?? "?"}` }).catch(() => {});
      }
      const drain = await drainSeconds(project);
      await log(`Previous production #${prev.number} keeps serving in-flight requests for ${drain}s, then stops`);
      await queues.cleanup.add({ kind: "drain", deploymentId: prev.id }, { delay: drain * 1000, jobId: `drain-${prev.id}-${Date.now()}` });
    }
  });
}

/** Older live previews of the same branch are stopped after the drain period (keepPreviewsPerBranch, default 1). */
async function scheduleOldPreviewStop(project: Project, dep: Deployment) {
  if (!dep.branch) return;
  const keep = runtimeSettings(project).keepPreviewsPerBranch ?? 1;
  const live = await db.deployment.findMany({
    where: { projectId: project.id, branch: dep.branch, target: "PREVIEW", status: "READY", stoppedAt: null, isCurrentProduction: false },
    orderBy: [{ readyAt: "desc" }, { createdAt: "desc" }],
    select: { id: true },
  });
  const drain = await drainSeconds(project);
  for (const old of live.slice(Math.max(keep, 1))) {
    await queues.cleanup.add({ kind: "drain", deploymentId: old.id }, { delay: drain * 1000, jobId: `drain-${old.id}-${Date.now()}` });
  }
}

/** Drain job: stop a deployment that no longer receives production/alias traffic. */
export async function drainStop(deploymentId: string) {
  const d = await db.deployment.findUnique({ where: { id: deploymentId }, include: { project: true } });
  if (!d || d.isCurrentProduction || d.stoppedAt) return { skipped: true };
  await stopDeployment(d.id, { reason: "drained" });
  await queues.cleanup.add({ kind: "deployments", projectId: d.projectId }, { jobId: `prune-${d.projectId}-${Date.now()}` }).catch(() => {});
  return { stopped: true };
}

/** Stop containers (routes first, then containers). Keeps containers for instant restart/rollback. */
export async function stopDeployment(deploymentId: string, opts: { reason?: string } = {}) {
  const d = await load(deploymentId);
  const log = logger(d.id);
  await db.deployment.update({ where: { id: d.id }, data: { stoppedAt: new Date() } });
  await syncRoutes({ immediate: true });
  if (d.project.kind === "COMPOSE" && containerRefs(d).length) await composeStop(d).catch(() => {});
  else for (const r of containerRefs(d)) await stopContainer(r.id).catch(() => {});
  await log(`Containers stopped${opts.reason ? ` (${opts.reason})` : ""}`);
}

/** Make sure a deployment's containers run (start stopped ones, recreate missing ones) and are healthy. */
async function ensureRunning(d: DepWithProject, log: (l: string | string[]) => Promise<void>): Promise<ContainerRef[]> {
  const project = d.project;
  const refs = containerRefs(d);
  if (project.kind === "COMPOSE") {
    if (!refs.length) throw new RuntimeError("This compose deployment's containers were removed — redeploy it instead", "DEPLOY");
    await composeStart(d);
    const pub = refs.find((r) => r.public) ?? refs[0]!;
    const cfg = healthConfig(project);
    await waitHealthy(pub, { ...cfg, timeoutMs: cfg.timeoutMs }).catch((e) => {
      throw new RuntimeError((e as Error).message, "HEALTHCHECK", (e as HealthError).logs);
    });
    return refs;
  }
  const existing: ContainerRef[] = [];
  for (const r of refs) if (await inspectSafe(r.id)) existing.push(r);
  if (existing.length) {
    await log(`Starting ${existing.length} stopped container(s)…`);
    for (const r of existing) await startContainer(r.id);
    const cfg = healthConfig(project);
    try {
      await Promise.all(existing.map((r) => waitHealthy(r, cfg, { onLog: (l) => void log(l) })));
    } catch (e) {
      if (e instanceof HealthError) throw new RuntimeError(e.message, "HEALTHCHECK", e.logs);
      throw e;
    }
    return existing;
  }
  if (!d.imageTag) throw new RuntimeError("No image to start from — redeploy instead");
  const { imageExists } = await import("./containers");
  if (!(await imageExists(d.imageTag))) throw new RuntimeError(`Image ${d.imageTag} was removed by cleanup — redeploy instead`);
  await log(`Recreating ${Math.max(1, project.replicas)} replica(s) from ${d.imageTag}…`);
  const fresh = await startReplicas(project, d, Array.from({ length: Math.max(1, project.replicas) }, (_, i) => i + 1), log);
  await db.deployment.update({ where: { id: d.id }, data: { containerIds: fresh as unknown as Prisma.InputJsonValue } });
  return fresh;
}

/** Rollback / instant promote of a previous production deployment. */
export async function rollbackTo(deploymentId: string, byUserId?: string | null) {
  const d = await load(deploymentId);
  const log = logger(d.id);
  if (!["READY", "SUPERSEDED"].includes(d.status)) throw new RuntimeError(`Cannot roll back to a ${d.status} deployment`);
  const by = byUserId ? await db.user.findUnique({ where: { id: byUserId }, select: { name: true } }) : null;
  await log(`Rollback: making #${d.number} the production deployment again${by ? ` (requested by ${by.name})` : ""}`);
  try {
    const refs = await ensureRunning(d, log);
    await db.deployment.update({ where: { id: d.id }, data: { stoppedAt: null, containerIds: refs as unknown as Prisma.InputJsonValue } });
    if (d.status === "SUPERSEDED") await setStatus(d.id, "READY", { message: "Rolled back to this deployment" });
    await switchProduction(d.project, d.id, log);
    await log(`✓ Rollback complete: production now serves #${d.number}`);
  } catch (e) {
    const err = e instanceof RuntimeError ? e : new RuntimeError((e as Error).message);
    await log(`✗ Rollback failed: ${err.message}`);
    if (err.logs) await log(err.logs.split("\n").slice(-40));
    throw err;
  }
}

/** Rolling restart (replica by replica, health between) — or start, when the deployment was stopped. */
export async function restartDeployment(deploymentId: string) {
  const d = await load(deploymentId);
  const log = logger(d.id);
  if (!["READY", "SUPERSEDED"].includes(d.status)) throw new RuntimeError(`Cannot restart a ${d.status} deployment`);
  if (d.stoppedAt) {
    await log("Starting stopped deployment…");
    const refs = await ensureRunning(d, log);
    await db.deployment.update({ where: { id: d.id }, data: { stoppedAt: null, containerIds: refs as unknown as Prisma.InputJsonValue } });
    await syncRoutes({ immediate: true });
    await log("✓ Started");
    return;
  }
  const refs = containerRefs(d);
  const cfg = healthConfig(d.project);
  if (d.project.kind === "COMPOSE") {
    await log(`Restarting ${refs.length} compose container(s)…`);
    for (const r of refs) {
      const { docker } = await import("@/lib/docker");
      await docker().getContainer(r.id).restart({ t: 10 });
      if (!r.public) continue;
      try {
        await waitHealthy(r, cfg, { onLog: (l) => void log(l) });
      } catch (e) {
        throw new RuntimeError((e as Error).message, "HEALTHCHECK", (e as HealthError).logs);
      }
    }
  } else {
    // rolling replace: start a fresh replica, wait for health, swap it into the routes, then remove the old one
    await log(`Rolling restart of ${refs.length} replica(s)…`);
    let current = [...refs];
    for (const old of refs) {
      const nextNo = current.reduce((m, r) => Math.max(m, r.replica), 0) + 1;
      const [fresh] = await startReplicas(d.project, d, [nextNo], log);
      current = [...current.filter((r) => r.id !== old.id), fresh!];
      await withProjectLock(d.projectId, async () => {
        await db.deployment.update({ where: { id: d.id }, data: { containerIds: current as unknown as Prisma.InputJsonValue } });
        await syncRoutes({ immediate: true });
      });
      await new Promise((res) => setTimeout(res, 1500)); // in-flight requests on the old replica
      await stopContainer(old.id, 10).catch(() => {});
      await removeContainer(old.id).catch(() => {});
      await log(`  replica ${old.replica} replaced by replica ${fresh!.replica}`);
    }
  }
  await log("✓ Restart complete");
}

/** Scale the current production deployment to N replicas (new replicas are health-checked before receiving traffic). */
export async function scaleProject(projectId: string, replicas: number) {
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
  const max = (await getSetting("limits.defaults")).maxReplicas;
  const n = Math.max(1, Math.min(replicas, max));
  await db.project.update({ where: { id: projectId }, data: { replicas: n } });
  if (project.kind === "COMPOSE") return { replicas: 1, applied: false };
  const cur = await currentProduction(projectId);
  if (!cur || cur.stoppedAt || cur.status !== "READY") return { replicas: n, applied: false };
  const log = logger(cur.id);
  const refs = containerRefs(cur);
  if (refs.length === n) return { replicas: n, applied: true };
  if (refs.length < n) {
    const maxNo = refs.reduce((m, r) => Math.max(m, r.replica), 0);
    const numbers = Array.from({ length: n - refs.length }, (_, i) => maxNo + i + 1);
    await log(`Scaling up to ${n} replicas…`);
    const added = await startReplicas({ ...project, replicas: n }, cur, numbers, log);
    await withProjectLock(projectId, async () => {
      const fresh = await db.deployment.findUniqueOrThrow({ where: { id: cur.id } });
      await db.deployment.update({ where: { id: cur.id }, data: { containerIds: [...containerRefs(fresh), ...added] as unknown as Prisma.InputJsonValue } });
      await syncRoutes({ immediate: true });
    });
  } else {
    const running = new Set<string>();
    for (const r of refs) if ((await inspectSafe(r.id))?.State.Running) running.add(r.id);
    // keep running replicas first (lowest numbers), drop dead/extra ones
    const sorted = [...refs].sort((a, b) => Number(running.has(b.id)) - Number(running.has(a.id)) || a.replica - b.replica);
    const keep = sorted.slice(0, n);
    const drop = sorted.slice(n);
    await log(`Scaling down to ${n} replicas…`);
    await withProjectLock(projectId, async () => {
      await db.deployment.update({ where: { id: cur.id }, data: { containerIds: keep as unknown as Prisma.InputJsonValue } });
      await syncRoutes({ immediate: true });
    });
    await new Promise((r) => setTimeout(r, 2000)); // let in-flight requests finish
    for (const r of drop) await removeContainer(r.id).catch(() => {});
  }
  await log(`✓ Scaled to ${n} replica${n > 1 ? "s" : ""}`);
  return { replicas: n, applied: true };
}

/** Remove a deployment's containers entirely (cleanup / project delete). */
export async function removeDeploymentContainers(d: Deployment & { project?: Pick<Project, "kind"> | null }) {
  const project = d.project ?? (await db.project.findUnique({ where: { id: d.projectId } }));
  if (project && effectiveKind(d.meta, project.kind) === "COMPOSE") await composeDown(d).catch(() => {});
  for (const r of containerRefs(d)) await removeContainer(r.id).catch(() => {});
  await db.deployment.update({
    where: { id: d.id },
    data: { containerIds: [], stoppedAt: d.stoppedAt ?? new Date(), meta: { ...((d.meta as object) ?? {}), containersRemoved: true } },
  });
}
