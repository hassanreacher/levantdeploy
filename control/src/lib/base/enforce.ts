import type { BaseProject } from "@prisma/client";
import { db } from "@/lib/db";
import { queues } from "@/lib/queues";
import { psql } from "./compose";
import { baseEvent } from "./events";
import type { BaseLimits } from "./limits";
import { readSettings } from "./settings";

/**
 * Soft-cap enforcement (plans area semantics, docs/requests/plans.md), run after each usage sample:
 *   DB over dbSizeMb (enforce.dbSize)     → ALTER DATABASE postgres SET default_transaction_read_only = on + terminate
 *                                           sessions (services reconnect read-only) + Caddy 507 for PostgREST writes
 *                                           (PostgREST uses explicit READ WRITE transactions); reverted under 95 %
 *   storage over storageMb (enforce.storage) → Caddy answers 507 for uploads (settings.enforcement.uploadsBlocked)
 *   MAU over / team egress over (enforce.*) on plans that auto-pause (Hobby) → pause
 * State lives in BaseProject.settings.enforcement = { dbReadOnly, uploadsBlocked, at }.
 */
export type Enforcement = { dbReadOnly?: boolean; uploadsBlocked?: boolean; at?: string };
const MB = 1024 * 1024;

/** Pure decision (tested). */
export function decideEnforcement(
  l: Pick<BaseLimits, "dbSizeMb" | "storageMb" | "mau" | "egressGb" | "pauseAfterDays" | "enforce">,
  u: { dbSizeBytes: number; storageSizeBytes: number; mau: number; teamEgressBytes: number },
  cur: Enforcement,
): { dbReadOnly: boolean; uploadsBlocked: boolean; pause: string | null } {
  const dbLimit = l.dbSizeMb * MB;
  const stLimit = l.storageMb * MB;
  // hysteresis: switch on above 100 %, off below 95 %
  const dbReadOnly = l.enforce.dbSize && (u.dbSizeBytes > dbLimit || (!!cur.dbReadOnly && u.dbSizeBytes > dbLimit * 0.95));
  const uploadsBlocked = l.enforce.storage && (u.storageSizeBytes > stLimit || (!!cur.uploadsBlocked && u.storageSizeBytes > stLimit * 0.95));
  let pause: string | null = null;
  if (l.pauseAfterDays != null) {
    if (l.enforce.mau && u.mau > l.mau) pause = `Monthly active users (${u.mau}) exceed the plan limit (${l.mau})`;
    else if (l.enforce.egress && u.teamEgressBytes > l.egressGb * 1024 * MB) pause = `Team egress this month exceeds the plan limit (${l.egressGb} GB)`;
  }
  return { dbReadOnly, uploadsBlocked, pause };
}

export async function setDbReadOnly(ref: string, on: boolean) {
  // the admin session itself must not be read-only to run ALTER DATABASE
  await psql(
    ref,
    `SET default_transaction_read_only = off;
     ALTER DATABASE postgres ${on ? "SET default_transaction_read_only = on" : "RESET default_transaction_read_only"};
     SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity
      WHERE datname = 'postgres' AND pid <> pg_backend_pid() AND backend_type = 'client backend';`,
  );
}

export async function applyEnforcement(p: BaseProject, limits: BaseLimits, u: { dbSizeBytes: number; storageSizeBytes: number; mau: number }) {
  const settings = readSettings(p.settings);
  const cur = (settings.enforcement ?? {}) as Enforcement;
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const eg = await db.baseUsageSample.aggregate({ where: { at: { gte: monthStart }, baseProject: { teamId: p.teamId } }, _sum: { egressBytes: true } });
  const d = decideEnforcement(limits, { ...u, teamEgressBytes: Number(eg._sum.egressBytes ?? 0n) }, cur);
  let changed = false;
  if (p.status === "ACTIVE" && d.dbReadOnly !== !!cur.dbReadOnly) {
    await setDbReadOnly(p.ref, d.dbReadOnly);
    await baseEvent(p, "limits", d.dbReadOnly ? `Database is larger than the plan allows (${limits.dbSizeMb} MB) — it is now read-only` : "Database is back under its size limit — writes are allowed again", {
      level: d.dbReadOnly ? "warning" : "success",
    });
    changed = true;
  }
  if (d.uploadsBlocked !== !!cur.uploadsBlocked) {
    await baseEvent(p, "limits", d.uploadsBlocked ? `File storage exceeds the plan limit (${limits.storageMb} MB) — uploads are blocked` : "File storage is back under its limit — uploads are allowed again", {
      level: d.uploadsBlocked ? "warning" : "success",
    });
    changed = true;
  }
  if (changed) {
    const next: Enforcement = { dbReadOnly: p.status === "ACTIVE" ? d.dbReadOnly : !!cur.dbReadOnly, uploadsBlocked: d.uploadsBlocked, at: new Date().toISOString() };
    await db.baseProject.update({ where: { id: p.id }, data: { settings: { ...settings, enforcement: next } as object } });
    if (next.uploadsBlocked !== !!cur.uploadsBlocked || next.dbReadOnly !== !!cur.dbReadOnly) {
      const { syncRoutes } = await import("@/lib/proxy/sync");
      await syncRoutes().catch(() => {});
    }
  }
  if (d.pause && p.status === "ACTIVE") {
    await baseEvent(p, "limits", `${d.pause} — pausing`, { level: "warning" });
    await queues.base.add({ action: "pause", ref: p.ref, options: { reason: `Paused: ${d.pause}` } }, { jobId: `base-quota-pause-${p.ref}-${Date.now()}` });
  }
  return d;
}
