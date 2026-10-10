import type { Plan, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { DEFAULT_PLANS, HOBBY_LIMITS, UNLIMITED_LIMITS, defaultLimitsForSlug, parseLimits, type PlanLimits } from "./limits";

/** Plan CRUD + resolution (plans area). Worker-safe. */

export type PlanInfo = { id: string | null; slug: string; name: string; priceMonthly: number | null; isInternal: boolean; isDefault: boolean };
export type TeamPlan = {
  plan: PlanInfo;
  limits: PlanLimits;
  /** assigned = Team.planId; owner = platform owner's team (internal unlimited plan); default = the default plan */
  source: "assigned" | "owner" | "default";
};

export const planInfo = (p: Plan): PlanInfo => ({ id: p.id, slug: p.slug, name: p.name, priceMonthly: p.priceMonthly, isInternal: p.isInternal, isDefault: p.isDefault });

/** Built-in fallbacks when the Plan table is empty (fresh DB before the seed / worker bootstrap). */
const FALLBACK_DEFAULT: TeamPlan = {
  plan: { id: null, slug: "hobby", name: "Hobby", priceMonthly: 0, isInternal: false, isDefault: true },
  limits: HOBBY_LIMITS,
  source: "default",
};
const FALLBACK_OWNER: TeamPlan = {
  plan: { id: null, slug: "unlimited", name: "Unlimited (internal)", priceMonthly: null, isInternal: true, isDefault: false },
  limits: UNLIMITED_LIMITS,
  source: "owner",
};

async function defaultPlan(): Promise<Plan | null> {
  return (
    (await db.plan.findFirst({ where: { isDefault: true, archivedAt: null }, orderBy: { sortOrder: "asc" } })) ??
    (await db.plan.findFirst({ where: { isInternal: false, archivedAt: null }, orderBy: { sortOrder: "asc" } }))
  );
}

async function internalPlan(): Promise<Plan | null> {
  return (await db.plan.findUnique({ where: { slug: "unlimited" } })) ?? (await db.plan.findFirst({ where: { isInternal: true }, orderBy: { sortOrder: "asc" } }));
}

/** Is any OWNER of the team the platform owner? (the platform owner's own teams are unlimited unless a plan is assigned) */
export async function isPlatformOwnerTeam(teamId: string): Promise<boolean> {
  const n = await db.membership.count({ where: { teamId, role: "OWNER", user: { isPlatformOwner: true } } });
  return n > 0;
}

/** The effective plan of a team. Never throws for an existing team (falls back to built-in Hobby limits). */
export async function planFor(teamId: string): Promise<TeamPlan> {
  const team = await db.team.findUnique({ where: { id: teamId }, select: { plan: true } });
  if (team?.plan) return { plan: planInfo(team.plan), limits: parseLimits(team.plan.limits, defaultLimitsForSlug(team.plan.slug)), source: "assigned" };
  if (await isPlatformOwnerTeam(teamId)) {
    const p = await internalPlan();
    return p ? { plan: planInfo(p), limits: parseLimits(p.limits, UNLIMITED_LIMITS), source: "owner" } : FALLBACK_OWNER;
  }
  const d = await defaultPlan();
  return d ? { plan: planInfo(d), limits: parseLimits(d.limits, defaultLimitsForSlug(d.slug)), source: "default" } : FALLBACK_DEFAULT;
}

/**
 * Idempotent bootstrap (seed + worker start): creates the default plans when missing (never overwrites edits),
 * and — once per installation — marks pre-existing users as email-verified so turning verification on does not
 * lock out accounts created before this feature existed.
 */
export async function ensureDefaultPlans(): Promise<{ created: string[] }> {
  const created: string[] = [];
  for (const p of DEFAULT_PLANS) {
    const exists = await db.plan.findUnique({ where: { slug: p.slug }, select: { id: true } });
    if (exists) continue;
    await db.plan
      .create({
        data: {
          slug: p.slug,
          name: p.name,
          description: p.description,
          priceMonthly: p.priceMonthly,
          limits: p.limits as unknown as Prisma.InputJsonObject,
          isDefault: p.isDefault && !(await db.plan.count({ where: { isDefault: true } })),
          isInternal: p.isInternal,
          sortOrder: p.sortOrder,
        },
      })
      .then(() => created.push(p.slug))
      .catch(() => {}); // concurrent bootstrap (web + worker) → unique violation is fine
  }
  const flag = await db.setting.findUnique({ where: { key: "plans.bootstrappedAt" } });
  if (!flag) {
    await db.user.updateMany({ where: { emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } });
    await db.setting.upsert({ where: { key: "plans.bootstrappedAt" }, create: { key: "plans.bootstrappedAt", value: new Date().toISOString() }, update: {} });
  }
  return { created };
}

export async function listPlans(opts: { includeArchived?: boolean; includeInternal?: boolean } = {}) {
  return db.plan.findMany({
    where: { ...(opts.includeArchived ? {} : { archivedAt: null }), ...(opts.includeInternal === false ? { isInternal: false } : {}) },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: { _count: { select: { teams: true } } },
  });
}

/** Make `planId` the only default plan. */
export async function setDefaultPlan(planId: string) {
  await db.$transaction([db.plan.updateMany({ where: { isDefault: true, NOT: { id: planId } }, data: { isDefault: false } }), db.plan.update({ where: { id: planId }, data: { isDefault: true } })]);
}

/** Assign a plan (null = automatic). Clears quota alerts of the current period so new thresholds notify again. */
export async function assignPlan(teamId: string, planId: string | null) {
  const team = await db.team.update({ where: { id: teamId }, data: { planId }, include: { plan: true } });
  await db.planUsageAlert.deleteMany({ where: { teamId, createdAt: { gte: new Date(Date.now() - 32 * 86400_000) } } });
  await db.planUpgradeRequest.updateMany({ where: { teamId, status: "OPEN" }, data: { status: "APPROVED", handledAt: new Date() } });
  return team;
}
