/**
 * base-runtime area (LevantBase): queue `base`.
 *   actions: provision, pause, resume, restart(service?), upgrade(versions?), delete, backup(backupId), restore(backupId),
 *            studio-start, studio-stop, settings, functions
 *   schedules: usage-sample (15 min), auto-pause-inactive (hourly), studio-idle (5 min), backup-tick (daily 03:41)
 *   start hooks: Caddy access-log tailer for base hosts (usage counters + lastActivityAt)
 */
import crypto from "node:crypto";
import { registerProcessor, registerSchedule, onWorkerStart, queues } from "@/lib/queues";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { STUDIO_IDLE_MS } from "@/lib/base/config";
import { baseEvent } from "@/lib/base/events";
import { baseLimitsForTeam } from "@/lib/base/limits";
import { readSettings } from "@/lib/base/settings";
import {
  applySettings, destroy, pause, provision, reloadFunctions, restart, restoreBackup, resume, runBackup, studioIdleSweep, studioStart, studioStop, upgrade,
} from "@/lib/base/stack";
import { inactiveProjects, sampleUsage, startBaseAccessTailer } from "@/lib/base/usage";

const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[base]", ...a);

/**
 * Stack operations of ONE project must never overlap: two `docker compose up` for the same project (e.g. a function
 * secret change and an auth-settings change a second apart) race on container recreation ("container name already in
 * use") and the loser marks the project ERROR. The queue runs 3 jobs at once, so jobs of the same ref take a Redis lock
 * (works across several workers) and wait for each other; different projects still run in parallel. (compat area)
 */
const LOCKED_ACTIONS = new Set(["provision", "pause", "resume", "restart", "upgrade", "delete", "restore", "studio-start", "studio-stop", "settings", "functions"]);
const LOCK_TTL_MS = 35 * 60_000;
export async function withProjectLock<T>(ref: string, fn: () => Promise<T>, waitMs = 30 * 60_000): Promise<T> {
  const key = `lb:lock:${ref}`;
  const token = crypto.randomBytes(12).toString("hex");
  const deadline = Date.now() + waitMs;
  while ((await redis().set(key, token, "PX", LOCK_TTL_MS, "NX")) !== "OK") {
    if (Date.now() > deadline) throw new Error(`another operation on ${ref} is still running`);
    await new Promise((r) => setTimeout(r, 500));
  }
  try {
    return await fn();
  } finally {
    await redis()
      .eval(`if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`, 1, key, token)
      .catch(() => {});
  }
}

registerProcessor(
  "base",
  async (job) => {
    const { action, backupId } = job.data;
    let lockRef = job.data.ref;
    if (!lockRef && action === "restore" && backupId) {
      lockRef = (await db.baseBackup.findUnique({ where: { id: backupId }, select: { baseProject: { select: { ref: true } } } }))?.baseProject.ref;
    }
    return lockRef && LOCKED_ACTIONS.has(action) ? withProjectLock(lockRef, () => run(job.data)) : run(job.data);
  },
  { concurrency: 3, lockDuration: 30 * 60_000 },
);

type BaseJob = Parameters<typeof queues.base.add>[0];
async function run(data: BaseJob) {
    const { action, ref, service, backupId, byUserId, options } = data;
    log(`${action}${ref ? ` ${ref}` : ""}`);
    switch (action) {
      case "provision":
        return provision(ref!, byUserId);
      case "pause":
        return pause(ref!, byUserId, (options?.reason as string) ?? "Paused");
      case "resume":
        return resume(ref!, byUserId);
      case "restart":
        return restart(ref!, service ?? null, byUserId);
      case "upgrade":
        return upgrade(ref!, options?.versions as Record<string, string> | undefined, byUserId);
      case "delete":
        return destroy(ref!, byUserId);
      case "backup":
        return runBackup(backupId!);
      case "restore":
        return restoreBackup(backupId!, byUserId);
      case "studio-start":
        return studioStart(ref!, byUserId);
      case "studio-stop":
        return studioStop(ref!);
      case "settings":
        return applySettings(ref!, byUserId);
      case "functions":
        return reloadFunctions(ref!, byUserId);
      case "usage-sample": {
        const refs = ref ? [ref] : (await db.baseProject.findMany({ where: { status: { in: ["ACTIVE", "PAUSED"] } }, select: { ref: true } })).map((r) => r.ref);
        for (const r of refs) await sampleUsage(r).catch((e) => log(`usage ${r}:`, (e as Error).message));
        return { sampled: refs.length };
      }
      case "auto-pause-inactive": {
        const refs = await inactiveProjects();
        for (const r of refs) {
          const p = await db.baseProject.findUnique({ where: { ref: r } });
          if (p) await baseEvent(p, "pause", "No API activity for the plan's inactivity period — pausing", { level: "warning" });
          await queues.base.add({ action: "pause", ref: r, options: { reason: "Paused automatically after inactivity" } }, { jobId: `base-autopause-${r}-${Date.now()}` });
        }
        return { paused: refs };
      }
      case "studio-idle":
        return { stopped: await studioIdleSweep(STUDIO_IDLE_MS) };
      case "backup-tick": {
        const rows = await db.baseProject.findMany({ where: { status: "ACTIVE" }, select: { id: true, ref: true, teamId: true, settings: true } });
        let n = 0;
        for (const r of rows) {
          const l = await baseLimitsForTeam(r.teamId, readSettings(r.settings).limits);
          if (l.backupsKept <= 0) continue;
          const b = await db.baseBackup.create({ data: { baseProjectId: r.id, kind: "SCHEDULED" } });
          await runBackup(b.id).catch((e) => log(`backup ${r.ref}:`, (e as Error).message));
          n++;
        }
        return { backups: n };
      }
      default:
        throw new Error(`unknown base action ${action as string}`);
    }
}

registerSchedule("base", "base-usage-sample", { every: 15 * 60_000 }, { action: "usage-sample" });
registerSchedule("base", "base-auto-pause", { every: 60 * 60_000 }, { action: "auto-pause-inactive" });
registerSchedule("base", "base-studio-idle", { every: 5 * 60_000 }, { action: "studio-idle" });
registerSchedule("base", "base-backup-daily", { pattern: "41 3 * * *" }, { action: "backup-tick" });

onWorkerStart("base-access-tailer", () => startBaseAccessTailer());
// one-time ownership fix for projects created before runSql ran as postgres (background, never blocks the start)
onWorkerStart("base-ownership-fix", () => {
  void import("@/lib/base/ownership").then((m) => m.ownershipFixAll((msg) => log(msg))).catch((e) => log("ownership fix:", (e as Error).message));
});
