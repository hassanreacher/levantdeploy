/**
 * Runtime area worker processors: deploy, domains, metrics, cron, cleanup, backups.
 * Start hooks: sync Caddy routes, follow runtime logs, tail the Caddy access log.
 */
import { onWorkerStart, queues, registerProcessor, registerSchedule } from "@/lib/queues";
import { db } from "@/lib/db";
import { syncRoutes } from "@/lib/proxy/sync";
import { drainStop, restartDeployment, rollbackTo, runDeploy, scaleProject, stopDeployment } from "@/lib/runtime/deploy";
import { checkDomain, dueDomains } from "@/lib/domains/verify";
import { sampleContainers } from "@/lib/runtime/metrics";
import { startAccessLogTailer } from "@/lib/runtime/metrics";
import { startLogFollowers } from "@/lib/runtime/log-follower";
import { cronTick, runCronJob } from "@/lib/runtime/cron";
import { runCleanup } from "@/lib/runtime/cleanup";
import { deleteDatabase, provisionDatabase, restoreBackup, runBackup, scheduledBackups, setDatabaseRunning } from "@/lib/runtime/databases";
import { appendLog } from "@/lib/logs";

const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[runtime]", ...a);

// ── deploy (build → DEPLOYING → here) + actions ──
registerProcessor(
  "deploy",
  async (job) => {
    const { deploymentId, action = "deploy", replicas } = job.data;
    try {
      switch (action) {
        case "deploy":
          return await runDeploy(deploymentId);
        case "rollback":
          return await rollbackTo(deploymentId, job.data.byUserId);
        case "restart":
        case "start":
          return await restartDeployment(deploymentId);
        case "stop":
          return await stopDeployment(deploymentId, { reason: "stopped by user" });
        case "scale": {
          const d = await db.deployment.findUnique({ where: { id: deploymentId }, select: { projectId: true } });
          if (d) return await scaleProject(d.projectId, replicas ?? 1);
          return;
        }
      }
    } catch (e) {
      if (action !== "deploy") await appendLog(deploymentId, "BUILD", `✗ ${action} failed: ${(e as Error).message}`).catch(() => {});
      throw e;
    }
  },
  { concurrency: 4, lockDuration: 15 * 60_000 },
);

// ── domains: DNS checks ──
registerProcessor(
  "domains",
  async (job) => {
    if (job.data.domainId) return checkDomain(job.data.domainId, { manual: !job.data.tick });
    const due = await dueDomains();
    for (const d of due) await checkDomain(d.id).catch((e) => log("domain check failed", d.id, (e as Error).message));
    return { checked: due.length };
  },
  { concurrency: 2 },
);
registerSchedule("domains", "domains-check-due", { every: 60_000 }, { tick: true });

// ── metrics: docker stats every 30 s (access log is tailed continuously) ──
registerProcessor("metrics", async () => sampleContainers(), { concurrency: 1 });
registerSchedule("metrics", "metrics-sample", { every: 30_000 }, { tick: true });

// ── cron ──
registerProcessor(
  "cron",
  async (job) => {
    if (job.data.cronJobId) return runCronJob(job.data.cronJobId, job.data.manual ? "MANUAL" : "SCHEDULED", job.data.runId);
    return cronTick(new Date(), (id) => queues.cron.add({ cronJobId: id }, { jobId: `cron-${id}-${Date.now()}` }));
  },
  { concurrency: 4, lockDuration: 2 * 3600_000 },
);
registerSchedule("cron", "cron-tick", { pattern: "* * * * *" }, { tick: true });

// ── cleanup (+ drain stops) ──
registerProcessor(
  "cleanup",
  async (job) => {
    const { kind = "all", deploymentId, projectId } = job.data;
    if (kind === "drain" && deploymentId) return drainStop(deploymentId);
    return runCleanup(kind, projectId);
  },
  { concurrency: 1, lockDuration: 30 * 60_000 },
);
registerSchedule("cleanup", "cleanup-nightly", { pattern: "17 3 * * *" }, { kind: "all" });
registerSchedule("cleanup", "cleanup-hourly-deployments", { pattern: "41 * * * *" }, { kind: "deployments" });

// ── backups: database add-on lifecycle + backups ──
registerProcessor(
  "backups",
  async (job) => {
    const { action, databaseId, backupId, tick } = job.data;
    if (tick) {
      const ids = await scheduledBackups();
      for (const id of ids) await queues.backups.add({ backupId: id, action: "backup" }, { jobId: `backup-${id}` });
      return { scheduled: ids.length };
    }
    switch (action) {
      case "provision":
      case "reconfigure":
        return databaseId && provisionDatabase(databaseId);
      case "start":
        return databaseId && setDatabaseRunning(databaseId, true);
      case "stop":
        return databaseId && setDatabaseRunning(databaseId, false);
      case "restart":
        if (!databaseId) return;
        await setDatabaseRunning(databaseId, false);
        return setDatabaseRunning(databaseId, true);
      case "delete":
        return databaseId && deleteDatabase(databaseId);
      case "backup":
        return backupId && runBackup(backupId);
      case "restore":
        return backupId && restoreBackup(backupId);
    }
  },
  { concurrency: 2, lockDuration: 2 * 3600_000 },
);
registerSchedule("backups", "backups-tick", { pattern: "* * * * *" }, { tick: true });

// ── start hooks ──
onWorkerStart("runtime:sync-routes", async () => {
  const r = await syncRoutes({ immediate: true });
  log(r.ok ? `routes synced (${r.sites} sites, ${r.redirects} redirects)` : `route sync failed: ${r.error}`);
});
onWorkerStart("runtime:log-followers", () => startLogFollowers());
onWorkerStart("runtime:access-log", () => startAccessLogTailer());
