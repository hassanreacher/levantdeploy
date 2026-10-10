import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { docker, LABELS } from "@/lib/docker";
import { env } from "@/lib/env";
import { getSetting } from "@/lib/settings";
import { deleteLogs } from "@/lib/logs";
import { removeDeploymentContainers } from "./deploy";
import { syncRoutes } from "@/lib/proxy/sync";
import { containerRefs } from "./containers";

/**
 * Cleanup jobs (worker `cleanup` queue):
 *  - deployments: per project keep the last N (deploy.keepStoppedDeployments, default 5) stopped deployments with their
 *    containers (instant rollback); older ones lose their containers and — when no kept deployment uses it — their image
 *  - images: dangling images
 *  - workdirs: build work dirs older than 6 h whose deployment is not building
 *  - uploads: expired uploads (file + status EXPIRED)
 *  - logs: log archives / live streams older than logs.retentionDays
 *  - metrics: MetricSample older than metrics.retentionDays
 */

export async function pruneDeployments(projectId?: string) {
  const keep = await getSetting("deploy.keepStoppedDeployments");
  const projects = projectId ? [{ id: projectId }] : await db.project.findMany({ select: { id: true } });
  let removed = 0;
  let images = 0;
  for (const p of projects) {
    const stopped = await db.deployment.findMany({
      where: { projectId: p.id, stoppedAt: { not: null }, isCurrentProduction: false },
      orderBy: { stoppedAt: "desc" },
      include: { project: true },
    });
    const withContainers = stopped.filter((d) => containerRefs(d).length > 0);
    for (const d of withContainers.slice(keep)) {
      await removeDeploymentContainers(d);
      removed++;
    }
    // images not referenced by any deployment that still has (or may need) containers
    const candidates = stopped.slice(keep).map((d) => d.imageTag).filter(Boolean) as string[];
    for (const tag of new Set(candidates)) {
      const inUse = await db.deployment.count({
        where: {
          imageTag: tag,
          OR: [{ stoppedAt: null, status: { in: ["READY", "SUPERSEDED", "DEPLOYING", "QUEUED", "BUILDING"] } }, { isCurrentProduction: true }],
        },
      });
      const keptStopped = stopped.slice(0, keep).some((d) => d.imageTag === tag);
      if (inUse || keptStopped) continue;
      try {
        await docker().getImage(tag).remove({ force: false });
        images++;
      } catch {
        /* in use by another container or already gone */
      }
    }
  }
  // ERROR / CANCELED deployments never keep containers
  const failed = await db.deployment.findMany({
    where: { status: { in: ["ERROR", "CANCELED"] }, NOT: { containerIds: { equals: [] } }, ...(projectId ? { projectId } : {}) },
    include: { project: true },
    take: 200,
  });
  for (const d of failed) if (containerRefs(d).length) await removeDeploymentContainers(d);
  return { removedContainers: removed, removedImages: images };
}

export async function pruneDanglingImages() {
  const r = await docker().pruneImages({ filters: { dangling: { true: true } } as never });
  // build cache / stopped one-off containers left behind by crashes
  const stale = await docker().listContainers({
    all: true,
    filters: { label: [`${LABELS.managed}=true`, "levant.role=cron"], status: ["exited", "dead", "created"] },
  });
  for (const c of stale) await docker().getContainer(c.Id).remove({ force: true }).catch(() => {});
  return { imagesDeleted: r.ImagesDeleted?.length ?? 0, spaceReclaimed: r.SpaceReclaimed ?? 0, staleContainers: stale.length };
}

export async function pruneWorkdirs(maxAgeMs = 6 * 3600_000) {
  const dir = path.resolve(env.WORK_DIR);
  let removed = 0;
  let entries: string[] = [];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return { removed };
  }
  const active = new Set(
    (await db.deployment.findMany({ where: { status: { in: ["QUEUED", "BUILDING", "DEPLOYING"] } }, select: { id: true } })).map((d) => d.id),
  );
  for (const e of entries) {
    if (active.has(e)) continue;
    const p = path.join(dir, e);
    try {
      const st = await fs.promises.stat(p);
      if (Date.now() - st.mtimeMs < maxAgeMs) continue;
      await fs.promises.rm(p, { recursive: true, force: true });
      removed++;
    } catch {}
  }
  return { removed };
}

export async function pruneUploads() {
  const expired = await db.upload.findMany({ where: { expiresAt: { lt: new Date() }, status: { not: "EXPIRED" } }, take: 500 });
  for (const u of expired) {
    await fs.promises.rm(path.resolve(env.STORAGE_DIR, u.path), { force: true, recursive: true }).catch(() => {});
    await db.upload.update({ where: { id: u.id }, data: { status: "EXPIRED" } });
  }
  return { expired: expired.length };
}

export async function pruneLogs() {
  const days = await getSetting("logs.retentionDays");
  const cutoff = new Date(Date.now() - days * 86400_000);
  const old = await db.deployment.findMany({
    where: { createdAt: { lt: cutoff }, isCurrentProduction: false, OR: [{ stoppedAt: { not: null } }, { status: { in: ["ERROR", "CANCELED"] } }] },
    select: { id: true },
    take: 1000,
  });
  for (const d of old) await deleteLogs(d.id).catch(() => {});
  return { deployments: old.length };
}

export async function pruneMetrics() {
  const days = await getSetting("metrics.retentionDays");
  const r = await db.metricSample.deleteMany({ where: { bucket: { lt: new Date(Date.now() - days * 86400_000) } } });
  return { deleted: r.count };
}

/**
 * Project deleted (row already gone): remove everything Docker still holds for it, by the `levant.project` label —
 * app / compose / cron containers, project volumes (`levant_vol_{projectId}_*`), project images, compose specs — then
 * re-sync routes. Database add-ons survive (they belong to the team; Database.projectId is set to null).
 */
export async function purgeProject(projectId: string) {
  const d = docker();
  const label = `${LABELS.project}=${projectId}`;
  const containers = await d.listContainers({ all: true, filters: { label: [label] } });
  const deploymentIds = new Set<string>();
  let removed = 0;
  for (const c of containers) {
    if (c.Labels["levant.role"] === "db") continue;
    if (c.Labels[LABELS.deployment]) deploymentIds.add(c.Labels[LABELS.deployment]!);
    await d.getContainer(c.Id).remove({ force: true }).catch(() => {});
    removed++;
  }
  const imageIds = new Set(containers.filter((c) => c.Labels["levant.role"] !== "db").map((c) => c.ImageID));
  for (const img of await d.listImages({ filters: { label: [label] } })) imageIds.add(img.Id);
  let images = 0;
  for (const id of imageIds) {
    try {
      await d.getImage(id).remove({ force: false });
      images++;
    } catch {
      /* shared with another project / base image */
    }
  }
  const vols = (await d.listVolumes({ filters: { label: [label] } })).Volumes ?? [];
  const byName = ((await d.listVolumes()).Volumes ?? []).filter((v) => v.Name.startsWith(`levant_vol_${projectId}_`));
  let volumes = 0;
  for (const v of [...vols, ...byName]) {
    if (v.Labels?.["levant.database"]) continue;
    try {
      await d.getVolume(v.Name).remove();
      volumes++;
    } catch {}
  }
  const dirs = [...deploymentIds].map((id) => path.resolve(env.STORAGE_DIR, "compose", id));
  for (const dir of dirs) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  await syncRoutes({ immediate: true }).catch(() => {});
  return { containers: removed, images, volumes };
}

export async function runCleanup(kind: string = "all", projectId?: string) {
  const out: Record<string, unknown> = {};
  if (projectId && !(await db.project.findUnique({ where: { id: projectId }, select: { id: true } }))) {
    out.purged = await purgeProject(projectId);
    if (kind !== "all") return out;
  }
  if (kind === "all" || kind === "deployments") out.deployments = await pruneDeployments(projectId);
  if (kind === "all" || kind === "images") out.images = await pruneDanglingImages();
  if (kind === "all" || kind === "workdirs") out.workdirs = await pruneWorkdirs();
  if (kind === "all" || kind === "uploads") out.uploads = await pruneUploads();
  if (kind === "all" || kind === "logs") out.logs = await pruneLogs();
  if (kind === "all" || kind === "metrics") out.metrics = await pruneMetrics();
  return out;
}
