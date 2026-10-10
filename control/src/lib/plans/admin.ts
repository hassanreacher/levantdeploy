import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { planLimitsSchema } from "./limits";
import { planFor, planInfo } from "./plans";
import { usageReport } from "./usage";

/** Owner admin helpers (plans area): plan input schema, teams overview (plan + over-quota). */

export const planInputSchema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{0,38}$/, "Lowercase letters, digits and dashes"),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).nullable().optional(),
  priceMonthly: z.number().int().min(0).max(1_000_000).nullable().optional(),
  limits: planLimitsSchema,
  isDefault: z.boolean().optional(),
  isInternal: z.boolean().optional(),
  sortOrder: z.number().int().min(-1000).max(1000).optional(),
});
export type PlanInput = z.infer<typeof planInputSchema>;

export const planDTO = (p: Prisma.PlanGetPayload<{ include: { _count: { select: { teams: true } } } }>) => ({
  ...planInfo(p),
  description: p.description,
  sortOrder: p.sortOrder,
  archivedAt: p.archivedAt,
  limits: p.limits,
  teams: p._count.teams,
});

export async function teamsOverview(opts: { overQuotaOnly?: boolean; limit?: number } = {}) {
  const teams = await db.team.findMany({
    orderBy: { createdAt: "asc" },
    take: opts.limit ?? 300,
    select: { id: true, slug: true, name: true, isPersonal: true, planId: true, createdAt: true, _count: { select: { projects: true, memberships: true, baseProjects: true } } },
  });
  const out = [];
  for (const t of teams) {
    const tp = await planFor(t.id);
    const report = await usageReport(t.id, { tp }).catch(() => null);
    const over = report?.overQuota.map((i) => ({ resource: i.resource, label: i.label, used: i.used, limit: i.limit, unit: i.unit, scope: i.scope ?? null, enforced: i.enforced })) ?? [];
    const near = report?.all.filter((i) => i.limit !== null && i.ratio >= 0.8 && i.ratio < 1 && i.resource !== "deploy.concurrentBuilds").length ?? 0;
    if (opts.overQuotaOnly && !over.length) continue;
    out.push({ id: t.id, slug: t.slug, name: t.name, isPersonal: t.isPersonal, plan: tp.plan, source: tp.source, counts: t._count, overQuota: over, nearQuota: near });
  }
  return out;
}
