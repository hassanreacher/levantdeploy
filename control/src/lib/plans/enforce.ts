import { db } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { limitOf, isEnforced, type BaseLimits, type BuilderLimits, type PlanLimits, type Resource } from "./limits";
import { PlanLimitError, EmailUnverifiedError } from "./errors";
import { planFor as dbPlanFor, type TeamPlan } from "./plans";
import { counters, GB } from "./usage";

/**
 * Enforcement hooks (plans area). Worker-safe. Every assert throws PlanLimitError (→ HTTP 402
 * { error: { code: "PLAN_LIMIT", resource, limit, used, … } }) or EmailUnverifiedError (→ 403) and resolves to
 * the effective plan otherwise.
 *
 *   await assertCanCreateProject(teamId, "deploy" | "base", { userId? })
 *   await assertCanDeploy(teamId, { userId?, preview? })        deployments/day (+ bandwidth when enforced)
 *   await assertWithinUploadLimit(teamId, bytes, "deploy" | "base")
 *   await assertCanAddMember(teamId)                            members + pending invites
 *   await assertCanAddDomain(projectId)                         custom domains per project
 *   await assertCanAddFunction(baseProjectId)                   edge functions per backend
 *   await baseResourceLimits(teamId)                            cpu / mem / db size / storage / upload / functions / pause / backups / public port
 *   await buildLimits(teamId)                                   concurrent builds / timeout / memory (build worker)
 *   await planFor(teamId)
 *
 * Dependencies are injectable for unit tests: `setPlanDeps({ planFor, counters, … })`.
 */

export type PlanDeps = {
  planFor: (teamId: string) => Promise<TeamPlan>;
  teamSlug: (teamId: string) => Promise<string | null>;
  projectTeam: (projectId: string) => Promise<string | null>;
  backendTeam: (baseProjectIdOrRef: string) => Promise<{ id: string; teamId: string } | null>;
  user: (userId: string) => Promise<{ emailVerifiedAt: Date | null; isPlatformOwner: boolean } | null>;
  verificationRequired: () => Promise<boolean>;
  counters: {
    projects: (teamId: string) => Promise<number>;
    deploymentsSince: (teamId: string, since: Date) => Promise<number>;
    buildingNow: (teamId: string) => Promise<number>;
    members: (teamId: string) => Promise<number>;
    customDomains: (projectId: string) => Promise<number>;
    activeBackends: (teamId: string) => Promise<number>;
    backendFunctions: (baseProjectId: string) => Promise<number>;
    bandwidthBytesMonth: (teamId: string) => Promise<number>;
    builderMessageTimes: (teamId: string, since: Date) => Promise<Date[]>;
    builderProjects: (teamId: string) => Promise<number>;
  };
};

const defaultDeps: PlanDeps = {
  planFor: dbPlanFor,
  teamSlug: async (id) => (await db.team.findUnique({ where: { id }, select: { slug: true } }))?.slug ?? null,
  projectTeam: async (id) => (await db.project.findUnique({ where: { id }, select: { teamId: true } }))?.teamId ?? null,
  backendTeam: (id) => db.baseProject.findFirst({ where: { OR: [{ id }, { ref: id }] }, select: { id: true, teamId: true } }),
  user: (id) => db.user.findUnique({ where: { id }, select: { emailVerifiedAt: true, isPlatformOwner: true } }),
  verificationRequired: async () => (await getSetting("auth.requireEmailVerification").catch(() => true)) as boolean,
  counters,
};

let deps: PlanDeps = defaultDeps;
/** Tests: override some dependencies (merged over the DB-backed defaults). Call with no args to reset. */
export function setPlanDeps(d?: Partial<Omit<PlanDeps, "counters">> & { counters?: Partial<PlanDeps["counters"]> }) {
  deps = d ? { ...defaultDeps, ...d, counters: { ...defaultDeps.counters, ...(d.counters ?? {}) } } : defaultDeps;
}

export const planFor = (teamId: string) => deps.planFor(teamId);

async function fail(tp: TeamPlan, teamId: string, resource: Resource | string, limit: number | null, used: number, message?: string): Promise<never> {
  throw new PlanLimitError(resource, limit, used, { slug: tp.plan.slug, name: tp.plan.name }, await deps.teamSlug(teamId).catch(() => null), message);
}

/** `used + adding > limit` (when enforced) → PlanLimitError. */
async function check(tp: TeamPlan, teamId: string, resource: Resource, used: number, adding = 1) {
  const limit = limitOf(tp.limits, resource);
  if (limit === null || !isEnforced(tp.limits, resource)) return;
  if (used + adding > limit) await fail(tp, teamId, resource, limit, used);
}

/** Unverified accounts may sign in but not create projects / deployments (platform owner exempt). */
export async function assertEmailVerified(userId: string | null | undefined) {
  if (!userId) return;
  const u = await deps.user(userId);
  if (!u || u.emailVerifiedAt || u.isPlatformOwner) return;
  if (!(await deps.verificationRequired())) return;
  throw new EmailUnverifiedError();
}

export async function assertCanCreateProject(teamId: string, product: "deploy" | "base", opts: { userId?: string | null } = {}): Promise<TeamPlan> {
  await assertEmailVerified(opts.userId);
  const tp = await deps.planFor(teamId);
  if (product === "deploy") await check(tp, teamId, "deploy.projects", await deps.counters.projects(teamId));
  else await check(tp, teamId, "base.projects", await deps.counters.activeBackends(teamId));
  return tp;
}

/**
 * Before creating a deployment: deployments in the last 24 h, monthly bandwidth (when enforced) and preview
 * deployments. Concurrent builds don't reject — extra builds wait for a slot in the build worker
 * (`buildLimits().concurrentBuilds`); pass `{ strictConcurrency: true }` to reject instead.
 */
export async function assertCanDeploy(
  teamId: string,
  opts: { userId?: string | null; preview?: boolean; strictConcurrency?: boolean; now?: Date } = {},
): Promise<TeamPlan> {
  await assertEmailVerified(opts.userId);
  const tp = await deps.planFor(teamId);
  const now = opts.now ?? new Date();
  if (opts.preview && !tp.limits.deploy.previewDeployments) await fail(tp, teamId, "deploy.previewDeployments", 0, 0);
  if (limitOf(tp.limits, "deploy.deploymentsPerDay") !== null) {
    await check(tp, teamId, "deploy.deploymentsPerDay", await deps.counters.deploymentsSince(teamId, new Date(now.getTime() - 86400_000)));
  }
  if (opts.strictConcurrency && limitOf(tp.limits, "deploy.concurrentBuilds") !== null) {
    await check(tp, teamId, "deploy.concurrentBuilds", await deps.counters.buildingNow(teamId));
  }
  const bw = limitOf(tp.limits, "deploy.bandwidthGbMonth");
  if (bw !== null && isEnforced(tp.limits, "deploy.bandwidthGbMonth")) {
    const usedGb = (await deps.counters.bandwidthBytesMonth(teamId)) / GB;
    if (usedGb >= bw) await fail(tp, teamId, "deploy.bandwidthGbMonth", bw, Math.round(usedGb * 100) / 100);
  }
  return tp;
}

export async function assertWithinUploadLimit(teamId: string, bytes: number, product: "deploy" | "base"): Promise<TeamPlan> {
  const tp = await deps.planFor(teamId);
  const resource: Resource = product === "deploy" ? "deploy.uploadMb" : "base.maxUploadMb";
  const limitMb = limitOf(tp.limits, resource);
  if (limitMb === null || !isEnforced(tp.limits, resource)) return tp;
  if (bytes > limitMb * 1024 * 1024) await fail(tp, teamId, resource, limitMb, Math.ceil((bytes / 1024 / 1024) * 10) / 10);
  return tp;
}

export async function assertCanAddMember(teamId: string, opts: { pendingIncluded?: boolean } = {}): Promise<TeamPlan> {
  const tp = await deps.planFor(teamId);
  const used = await deps.counters.members(teamId);
  // accepting an existing invite: the invite is already counted
  await check(tp, teamId, "deploy.members", used, opts.pendingIncluded ? 0 : 1);
  return tp;
}

export async function assertCanAddDomain(projectId: string, adding = 1): Promise<TeamPlan> {
  const teamId = await deps.projectTeam(projectId);
  if (!teamId) throw new Error("Project not found");
  const tp = await deps.planFor(teamId);
  await check(tp, teamId, "deploy.domainsPerProject", await deps.counters.customDomains(projectId), adding);
  return tp;
}

/** baseProjectId may be the id or the ref. */
export async function assertCanAddFunction(baseProjectId: string): Promise<TeamPlan> {
  const b = await deps.backendTeam(baseProjectId);
  if (!b) throw new Error("Backend not found");
  const tp = await deps.planFor(b.teamId);
  await check(tp, b.teamId, "base.functions", await deps.counters.backendFunctions(b.id));
  return tp;
}

export type BaseResourceLimits = BaseLimits & {
  plan: { slug: string; name: string };
  /** enforce flags of the soft caps (false = warn only, never restrict) */
  enforce: { dbSize: boolean; storage: boolean; mau: boolean; egress: boolean; invocations: boolean; functions: boolean; projects: boolean; upload: boolean };
  /** convenience for compose rendering: memory in bytes / NanoCPUs (null = no limit) */
  memoryBytes: number | null;
  nanoCpus: number | null;
};

/** Limits the base-runtime renders into each backend's stack (cpu/mem) and enforces (db size, storage, pause, backups, public port). */
export async function baseResourceLimits(teamId: string): Promise<BaseResourceLimits> {
  const tp = await deps.planFor(teamId);
  const b = tp.limits.base;
  const e = (r: Resource) => isEnforced(tp.limits, r);
  return {
    ...b,
    plan: { slug: tp.plan.slug, name: tp.plan.name },
    enforce: {
      dbSize: e("base.dbSizeMb"),
      storage: e("base.storageMb"),
      mau: e("base.mau"),
      egress: e("base.egressGbMonth"),
      invocations: e("base.functionInvocationsMonth"),
      functions: e("base.functions"),
      projects: e("base.projects"),
      upload: e("base.maxUploadMb"),
    },
    memoryBytes: b.memoryMb === null ? null : b.memoryMb * 1024 * 1024,
    nanoCpus: b.cpu === null ? null : Math.round(b.cpu * 1e9),
  };
}

/** Build worker: per-team concurrent builds, timeout (minutes) and memory (MB); null = no plan limit. */
export async function buildLimits(teamId: string): Promise<{ concurrentBuilds: number | null; timeoutMinutes: number | null; memoryMb: number | null; plan: string }> {
  const tp = await deps.planFor(teamId);
  const d = tp.limits.deploy;
  return {
    concurrentBuilds: isEnforced(tp.limits, "deploy.concurrentBuilds") ? d.concurrentBuilds : null,
    timeoutMinutes: d.buildTimeoutMinutes,
    memoryMb: d.buildMemoryMb,
    plan: tp.plan.name,
  };
}

// ───────────────────────────── AI app Builder (builder-agents area) ─────────────────────────────

export type BuilderCredits = {
  plan: { slug: string; name: string };
  usedToday: number;
  usedMonth: number;
  /** messages of this month paid by the daily bonus */
  bonusUsedMonth: number;
  limits: BuilderLimits;
  /** messages still allowed today (null = unlimited) */
  remainingToday: number | null;
  /** monthly allowance left (null = unlimited) */
  remainingMonth: number | null;
  allowed: boolean;
  /** why not allowed */
  reason: "daily" | "monthly" | null;
  resetsAt: { day: string; month: string };
};

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/** Builder credit state of a team (UI + enforcement). */
export async function builderCredits(teamId: string, now = new Date()): Promise<BuilderCredits> {
  const tp = await deps.planFor(teamId);
  const L = tp.limits.builder;
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const times = await deps.counters.builderMessageTimes(teamId, monthStart);
  const perDay = new Map<string, number>();
  for (const t of times) perDay.set(dayKey(t), (perDay.get(dayKey(t)) ?? 0) + 1);
  const usedToday = perDay.get(dayKey(dayStart)) ?? 0;
  const bonus = L.dailyBonus ?? 0;
  let bonusUsedMonth = 0;
  for (const n of perDay.values()) bonusUsedMonth += Math.min(n, bonus);
  const paidMonth = times.length - bonusUsedMonth;
  const enforced = tp.limits.enforce["builder.messages"] !== false;
  const remainingMonth = L.messagesPerMonth === null ? null : Math.max(0, L.messagesPerMonth - paidMonth);
  const remainingDayCap = L.messagesPerDay === null ? null : Math.max(0, L.messagesPerDay - usedToday);
  const bonusLeft = Math.max(0, bonus - usedToday);
  let reason: BuilderCredits["reason"] = null;
  if (bonusLeft === 0) {
    if (remainingDayCap === 0) reason = "daily";
    else if (remainingMonth === 0) reason = "monthly";
  }
  const remainingToday =
    remainingDayCap === null && remainingMonth === null ? null : Math.min(remainingDayCap ?? Infinity, bonusLeft + (remainingMonth ?? Infinity));
  const nextDay = new Date(dayStart.getTime() + 86400_000);
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return {
    plan: { slug: tp.plan.slug, name: tp.plan.name },
    usedToday,
    usedMonth: times.length,
    bonusUsedMonth,
    limits: L,
    remainingToday: remainingToday === Infinity ? null : remainingToday,
    remainingMonth,
    allowed: !enforced || reason === null,
    reason: enforced ? reason : null,
    resetsAt: { day: nextDay.toISOString(), month: nextMonth.toISOString() },
  };
}

/** Before a builder run: one credit per user message (Hobby 5/day & 30/month, Pro 100/month + 5/day bonus, Team 500/month). */
export async function assertCanUseBuilder(teamId: string, opts: { userId?: string | null; now?: Date } = {}): Promise<BuilderCredits> {
  await assertEmailVerified(opts.userId);
  const c = await builderCredits(teamId, opts.now);
  if (!c.allowed) {
    const tp = await deps.planFor(teamId);
    const daily = c.reason === "daily";
    await fail(
      tp,
      teamId,
      daily ? "builder.messagesPerDay" : "builder.messagesPerMonth",
      daily ? c.limits.messagesPerDay : c.limits.messagesPerMonth,
      daily ? c.usedToday : c.usedMonth - c.bonusUsedMonth,
      daily
        ? `You've used today's ${c.limits.messagesPerDay} AI builder messages on the ${tp.plan.name} plan. They reset at midnight UTC — or upgrade in Settings → Plan & Usage.`
        : `You've used this month's ${c.limits.messagesPerMonth} AI builder messages on the ${tp.plan.name} plan. Upgrade in Settings → Plan & Usage for more.`,
    );
  }
  return c;
}

/** Before creating a builder project (Hobby: 5). */
export async function assertCanCreateBuilderProject(teamId: string, opts: { userId?: string | null } = {}): Promise<TeamPlan> {
  await assertEmailVerified(opts.userId);
  const tp = await deps.planFor(teamId);
  const limit = tp.limits.builder.projects;
  if (limit === null || tp.limits.enforce["builder.projects"] === false) return tp;
  const used = await deps.counters.builderProjects(teamId);
  if (used + 1 > limit) await fail(tp, teamId, "builder.projects", limit, used, `You've reached the ${tp.plan.name} plan limit of ${limit} builder apps. Delete one or upgrade in Settings → Plan & Usage.`);
  return tp;
}

export type { PlanLimits };
