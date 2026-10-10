import type { Deployment } from "@prisma/client";
import { db } from "@/lib/db";
import { docker, LABELS } from "@/lib/docker";
import { stopDeployment as runtimeStop } from "@/lib/runtime/deploy";

/**
 * Bridge to the runtime area for preview cleanup (PR closed / branch deleted): runtime's stopDeployment()
 * (routes first, then containers; containers are kept for instant restart). If that fails (e.g. Caddy unreachable),
 * falls back to stopping the containers labelled `levant.deployment=<id>` and marking the deployment stopped.
 */
export async function stopDeployment(d: Pick<Deployment, "id">): Promise<void> {
  try {
    await runtimeStop(d.id, { reason: "pull request closed / branch deleted" });
    return;
  } catch (e) {
    console.warn("[git] runtime stopDeployment failed, stopping containers directly:", (e as Error).message);
  }
  try {
    const list = await docker().listContainers({ all: false, filters: { label: [`${LABELS.deployment}=${d.id}`] } });
    for (const c of list) await docker().getContainer(c.Id).stop({ t: 10 }).catch(() => {});
  } catch (e) {
    console.warn("[git] docker stop failed:", (e as Error).message);
  }
  await db.deployment.update({ where: { id: d.id }, data: { stoppedAt: new Date() } }).catch(() => {});
}

/** Stops READY preview deployments of a PR or a branch (never the current production one). */
export async function stopPreviews(projectId: string, by: { prNumber?: number; branch?: string }): Promise<string[]> {
  const where = {
    projectId,
    target: "PREVIEW" as const,
    isCurrentProduction: false,
    stoppedAt: null,
    status: { in: ["READY" as const, "QUEUED" as const, "BUILDING" as const, "DEPLOYING" as const] },
    ...(by.prNumber ? { prNumber: by.prNumber } : { branch: by.branch }),
  };
  const deps = await db.deployment.findMany({ where, select: { id: true, status: true } });
  const stopped: string[] = [];
  for (const d of deps) {
    if (d.status !== "READY") {
      const { cancelDeployment } = await import("@/lib/deployments");
      await cancelDeployment(d.id).catch(() => {});
    } else {
      await stopDeployment(d);
    }
    stopped.push(d.id);
  }
  return stopped;
}
