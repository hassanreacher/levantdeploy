import { queues } from "@/lib/queues";
import { getSetting } from "@/lib/settings";

/**
 * (Re)applies the ops repeatable jobs from settings. Called at worker start and after the owner changes
 * the backup schedule in Settings → Backups (from the control app; BullMQ job schedulers live in Redis).
 */
export const CONTROL_BACKUP_SCHEDULER = "ops-control-backup";
export const UPDATE_CHECK_SCHEDULER = "ops-update-check";

export async function applyOpsSchedules() {
  const q = queues.ops.raw;
  const cfg = await getSetting("backups.control");
  if (cfg.enabled) {
    await q.upsertJobScheduler(CONTROL_BACKUP_SCHEDULER, { pattern: cfg.schedule, tz: process.env.TZ || "UTC" }, { name: "control-backup", data: { kind: "control-backup" } });
  } else {
    await q.removeJobScheduler(CONTROL_BACKUP_SCHEDULER).catch(() => false);
  }
  await q.upsertJobScheduler(UPDATE_CHECK_SCHEDULER, { every: 12 * 3600_000 }, { name: "update-check", data: { kind: "update-check" } });
}

/** Validates a 5-field cron expression (minute hour dom month dow) — numbers, ranges, steps, lists, `*`. */
export function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const ranges: [number, number][] = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ];
  return parts.every((field, i) =>
    field.split(",").every((item) => {
      const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
      if (!m) return false;
      const [lo, hi] = ranges[i];
      const a = m[2] !== undefined ? Number(m[2]) : lo;
      const b = m[3] !== undefined ? Number(m[3]) : a;
      if (m[4] !== undefined && Number(m[4]) < 1) return false;
      return a >= lo && b <= hi && a <= b;
    }),
  );
}
