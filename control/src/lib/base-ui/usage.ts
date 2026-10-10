import type { BaseProject } from "@prisma/client";
import { db } from "@/lib/db";
import { baseLimits, baseUsage } from "./adapters";
import type { UsageDTO } from "./shared";

/** Current month usage of one Base project vs the team's plan limits + a daily series (last 30 days). */
export async function usageFor(base: Pick<BaseProject, "id" | "ref">, teamId: string): Promise<UsageDTO & { planName: string }> {
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const since = new Date(Date.now() - 30 * 86400_000);
  const [u, limits, fnCount, samples] = await Promise.all([
    baseUsage(base.ref).catch(() => ({ dbBytes: 0, storageBytes: 0, mau: 0, egressBytes: 0, invocations: 0 })),
    baseLimits(teamId),
    db.baseFunction.count({ where: { baseProjectId: base.id } }),
    db.baseUsageSample.findMany({ where: { baseProjectId: base.id, at: { gte: since } }, orderBy: { at: "asc" } }),
  ]);
  // daily buckets: max for sizes, sum for counters
  const days = new Map<string, { ts: string; dbBytes: number; storageBytes: number; egressBytes: number; invocations: number }>();
  for (const s of samples) {
    const k = s.at.toISOString().slice(0, 10);
    const d = days.get(k) ?? { ts: k, dbBytes: 0, storageBytes: 0, egressBytes: 0, invocations: 0 };
    d.dbBytes = Math.max(d.dbBytes, Number(s.dbSizeBytes));
    d.storageBytes = Math.max(d.storageBytes, Number(s.storageSizeBytes));
    d.egressBytes += Number(s.egressBytes);
    d.invocations += s.functionInvocations;
    days.set(k, d);
  }
  return {
    planName: limits.planName,
    periodStart: periodStart.toISOString(),
    metrics: [
      { key: "db", label: "Database size", used: u.dbBytes, limit: limits.dbBytes, unit: "bytes" },
      { key: "storage", label: "File storage", used: u.storageBytes, limit: limits.storageBytes, unit: "bytes" },
      { key: "mau", label: "Monthly active users", used: u.mau, limit: limits.mau, unit: "count" },
      { key: "egress", label: "Egress", used: u.egressBytes, limit: limits.egressBytes, unit: "bytes" },
      { key: "invocations", label: "Function invocations", used: u.invocations, limit: limits.invocations, unit: "count" },
      { key: "functions", label: "Edge Functions", used: fnCount, limit: limits.functions, unit: "count" },
    ],
    series: [...days.values()],
  };
}
