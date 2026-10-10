import { db } from "@/lib/db";
import { monthKey } from "@/lib/plans/usage";
import { planFor } from "@/lib/plans/enforce";

/**
 * Preview metering (builder-core → plans): running preview minutes per team per month in UsageCounter
 * (resource "builder.previewHours", value in hours). Called every minute by the idle check; a per-row minute cursor
 * (compare-and-set) makes concurrent / repeated calls count each minute once.
 */
export const PREVIEW_USAGE_RESOURCE = "builder.previewHours";

export async function meterPreviewMinute(runningByTeam: Map<string, number>, now = new Date()) {
  const period = monthKey(now);
  const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  for (const [teamId, n] of runningByTeam) {
    if (n <= 0) continue;
    const row = await db.usageCounter.upsert({
      where: { teamId_period_resource: { teamId, period, resource: PREVIEW_USAGE_RESOURCE } },
      create: { teamId, period, resource: PREVIEW_USAGE_RESOURCE, value: 0, cursor: new Date(minute.getTime() - 60_000) },
      update: {},
    });
    if (row.cursor && row.cursor >= minute) continue;
    await db.usageCounter.updateMany({ where: { id: row.id, cursor: row.cursor }, data: { value: { increment: n / 60 }, cursor: minute } });
  }
}

export async function previewHoursUsed(teamId: string, now = new Date()): Promise<number> {
  const row = await db.usageCounter.findUnique({ where: { teamId_period_resource: { teamId, period: monthKey(now), resource: PREVIEW_USAGE_RESOURCE } } });
  return row?.value ?? 0;
}

/** null = allowed; otherwise a human message (plan's previewHoursMonth reached). */
export async function previewQuotaError(teamId: string): Promise<string | null> {
  const tp = await planFor(teamId).catch(() => null);
  const limit = tp?.limits.builder?.previewHoursMonth ?? null;
  if (limit === null || limit === undefined) return null;
  const used = await previewHoursUsed(teamId);
  if (used < limit) return null;
  return `This team used its ${limit} live-preview hours for this month on the ${tp!.plan.name} plan. Publish the app or upgrade in Settings → Plan & Usage.`;
}
