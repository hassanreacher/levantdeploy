import { registerProcessor, onWorkerStart } from "@/lib/queues";
import { getSetting } from "@/lib/settings";
import { db } from "@/lib/db";
import { buildDeployment } from "@/lib/build/engine";
import { gcWorkDirs } from "@/lib/sources";
import { appendLog, endLogs } from "@/lib/logs";
import { queues } from "@/lib/queues";
import { setStatus } from "@/lib/deployments";
import { buildLimits } from "@/lib/plans/enforce";

/**
 * Build worker: QUEUED → BUILDING → DEPLOYING (+ deploy job) | ERROR | CANCELED.
 * Concurrency: BullMQ runs up to WORKER_CONCURRENCY_BUILD (default 4) jobs; an in-process gate enforces the
 * `build.concurrency` platform setting (read per job, so changes apply without a restart).
 */
const MAX = Number(process.env.WORKER_CONCURRENCY_BUILD) || 4;
let running = 0;
const waiters: Array<() => void> = [];

async function acquire(deploymentId: string) {
  const limit = await getSetting("build.concurrency").catch(() => 2);
  if (running < limit) {
    running++;
    return;
  }
  await appendLog(deploymentId, "BUILD", `Waiting for a free build slot (${running}/${limit} builds running)…`).catch(() => {});
  await new Promise<void>((resolve) => {
    const tryNow = async () => {
      const l = await getSetting("build.concurrency").catch(() => 2);
      if (running < l) {
        running++;
        resolve();
      } else waiters.push(() => void tryNow());
    };
    void tryNow();
  });
}
function release() {
  running = Math.max(0, running - 1);
  waiters.shift()?.();
}

/**
 * plans area: per-team build slots. A team may run `buildLimits(teamId).concurrentBuilds` builds at once (null = no
 * plan limit); further builds of that team stay QUEUED and wait here (polling, so plan changes apply immediately).
 * In-process counter + DB count of BUILDING rows (covers builds started by another worker process).
 */
const teamRunning = new Map<string, number>();
async function acquireTeamSlot(teamId: string, deploymentId: string) {
  let logged = false;
  for (;;) {
    const lim = await buildLimits(teamId).catch(() => null);
    const max = lim?.concurrentBuilds ?? null;
    if (max === null) break;
    const building = await db.deployment.count({ where: { project: { teamId }, status: "BUILDING", id: { not: deploymentId } } });
    // read the in-process counter after the last await → check + increment are atomic within this process
    if (Math.max(teamRunning.get(teamId) ?? 0, building) < max) break;
    const cur = await db.deployment.findUnique({ where: { id: deploymentId }, select: { status: true } });
    if (!cur || cur.status !== "QUEUED") break; // canceled meanwhile → buildDeployment() skips it
    if (!logged) {
      logged = true;
      await appendLog(deploymentId, "BUILD", `Waiting for a build slot — the ${lim!.plan} plan allows ${max} concurrent build${max === 1 ? "" : "s"} per team…`).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  teamRunning.set(teamId, (teamRunning.get(teamId) ?? 0) + 1);
}
function releaseTeamSlot(teamId: string) {
  const n = (teamRunning.get(teamId) ?? 1) - 1;
  if (n <= 0) teamRunning.delete(teamId);
  else teamRunning.set(teamId, n);
}

registerProcessor(
  "build",
  async (job) => {
    const { deploymentId } = job.data;
    // a BUILDING deployment at job start = this job was interrupted (worker crash / stalled job re-run)
    const cur = await db.deployment.findUnique({ where: { id: deploymentId }, select: { status: true } });
    if (cur?.status === "BUILDING") {
      await setStatus(deploymentId, "ERROR", { errorStep: "BUILD", errorMessage: "Build interrupted (worker restarted) — redeploy to try again" }).catch(() => {});
      await appendLog(deploymentId, "BUILD", "Build interrupted (worker restarted).").catch(() => {});
      await endLogs(deploymentId, "BUILD").catch(() => {});
      return { status: "ERROR", reason: "interrupted" };
    }
    // plans area: per-team concurrent builds (extra builds wait) + plan build timeout
    const team = await db.deployment.findUnique({ where: { id: deploymentId }, select: { project: { select: { teamId: true } } } });
    const teamId = team?.project.teamId ?? null;
    const lim = teamId ? await buildLimits(teamId).catch(() => null) : null;
    if (teamId) await acquireTeamSlot(teamId, deploymentId);
    try {
      await acquire(deploymentId);
      try {
        const platformMinutes = await getSetting("build.timeoutMinutes").catch(() => 30);
        const minutes = lim?.timeoutMinutes ? Math.min(lim.timeoutMinutes, platformMinutes) : platformMinutes;
        const res = await buildDeployment(deploymentId, { timeoutMs: minutes * 60_000 });
        return res;
      } finally {
        release();
      }
    } finally {
      if (teamId) releaseTeamSlot(teamId);
    }
  },
  { concurrency: MAX, lockDuration: 10 * 60_000 },
);

// Builds interrupted by a worker crash/restart stay BUILDING forever → mark them failed; drop stale work dirs.
onWorkerStart("build-recover", async () => {
  const stale = await db.deployment.findMany({ where: { status: "BUILDING", buildStartedAt: { lt: new Date(Date.now() - 60_000) } }, select: { id: true } });
  for (const d of stale) {
    // still owned by a job (another worker, or a stalled job BullMQ will hand back to us)? leave it to the processor
    const job = await queues.build.raw.getJob(`build-${d.id}`).catch(() => null);
    const state = job ? await job.getState().catch(() => "unknown") : "missing";
    if (["active", "waiting", "delayed", "prioritized", "waiting-children"].includes(state)) continue;
    await setStatus(d.id, "ERROR", { errorStep: "BUILD", errorMessage: "Build interrupted (worker restarted)" }).catch(() => {});
    await endLogs(d.id, "BUILD").catch(() => {});
  }
  const active = await db.deployment.findMany({ where: { status: { in: ["QUEUED", "BUILDING"] } }, select: { id: true } });
  await gcWorkDirs(6 * 3600_000, new Set(active.map((a) => a.id)));
});
