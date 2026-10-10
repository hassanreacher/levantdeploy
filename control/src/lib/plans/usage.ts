import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { limitOf, isEnforced, usageRatio, RESOURCE_LABEL, type PlanLimits, type Resource } from "./limits";
import { planFor, type TeamPlan } from "./plans";

/**
 * Usage metering (plans area). Worker-safe.
 *
 * Deploy: projects, deployments (rolling 24 h), running builds, build minutes (month), bandwidth (month, from
 *   MetricSample container netTxBytes, accumulated into UsageCounter so it survives metrics retention),
 *   members (+ pending invites), custom domains per project.
 * Base: backends (BaseProject) with their latest BaseUsageSample (gauges: dbSizeBytes, storageSizeBytes, mau) and
 *   monthly sums of the per-sample deltas (egressBytes, functionInvocations, requests) — samples are written by the
 *   base-runtime worker (`usage-sample` job).
 */

export const MB = 1024 * 1024;
export const GB = 1024 * MB;
const ACTIVE_BUILD = ["BUILDING"] as const;
const INACTIVE_BASE = ["PAUSED", "PAUSING", "DELETING"] as const;

export const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);
export const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);
export function monthStart(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

// ───────────────────────────── Counters (small, used by the enforcement hooks) ─────────────────────────────

export const counters = {
  projects: (teamId: string) => db.project.count({ where: { teamId } }),
  deploymentsSince: (teamId: string, since: Date) => db.deployment.count({ where: { project: { teamId }, createdAt: { gte: since } } }),
  buildingNow: (teamId: string) => db.deployment.count({ where: { project: { teamId }, status: { in: [...ACTIVE_BUILD] } } }),
  /** members + pending (unexpired, unaccepted, unrevoked) invites */
  members: async (teamId: string) => {
    const [m, i] = await Promise.all([
      db.membership.count({ where: { teamId } }),
      db.invite.count({ where: { teamId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } }),
    ]);
    return m + i;
  },
  membersOnly: (teamId: string) => db.membership.count({ where: { teamId } }),
  customDomains: (projectId: string) => db.domain.count({ where: { projectId, kind: "CUSTOM" } }),
  activeBackends: (teamId: string) => db.baseProject.count({ where: { teamId, status: { notIn: [...INACTIVE_BASE] } } }),
  backendFunctions: (baseProjectId: string) => db.baseFunction.count({ where: { baseProjectId } }),
  /** builder credits: one BuilderRun per user message to the agents (builder-agents area) */
  builderMessageTimes: async (teamId: string, since: Date) =>
    (await db.builderRun.findMany({ where: { builderProject: { teamId }, createdAt: { gte: since } }, select: { createdAt: true } })).map((r) => r.createdAt),
  builderProjects: (teamId: string) => db.builderProject.count({ where: { teamId } }),
  bandwidthBytesMonth: (teamId: string) => rollupBandwidth(teamId),
  buildMsMonth: async (teamId: string) => {
    const from = monthStart();
    const r = await db.$queryRaw<{ ms: number | null }[]>`
      SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(d."buildFinishedAt", d."finishedAt", now()) - d."buildStartedAt")) * 1000) AS ms
      FROM "Deployment" d JOIN "Project" p ON p.id = d."projectId"
      WHERE p."teamId" = ${teamId} AND d."buildStartedAt" >= ${from}`;
    return Math.max(0, Number(r[0]?.ms ?? 0));
  },
};

/**
 * Adds MetricSample container egress (netTxBytes) since the stored cursor to the team's monthly
 * "deploy.bandwidthBytes" counter and returns the month's total. Safe to call often (incremental, idempotent
 * per minute bucket; the newest 2 minutes are left for the next call because they may still be written).
 */
export async function rollupBandwidth(teamId: string, now = new Date()): Promise<number> {
  const period = monthKey(now);
  const from = monthStart(now);
  const upto = new Date(Math.floor(now.getTime() / 60_000) * 60_000 - 2 * 60_000);
  const row = await db.usageCounter.upsert({
    where: { teamId_period_resource: { teamId, period, resource: "deploy.bandwidthBytes" } },
    create: { teamId, period, resource: "deploy.bandwidthBytes", value: 0, cursor: from },
    update: {},
  });
  const cursor = row.cursor && row.cursor > from ? row.cursor : new Date(from.getTime() - 1);
  if (upto <= cursor) return row.value;
  const [r] = await db.$queryRaw<{ tx: number | null }[]>`
    SELECT SUM(m."netTxBytes") AS tx FROM "MetricSample" m JOIN "Project" p ON p.id = m."projectId"
    WHERE p."teamId" = ${teamId} AND m."kind" = 'container' AND m."bucket" > ${cursor} AND m."bucket" <= ${upto}`;
  const add = Number(r?.tx ?? 0);
  // compare-and-set on the cursor so two concurrent rollups can't double count
  const upd = await db.usageCounter.updateMany({ where: { id: row.id, cursor: row.cursor }, data: { value: { increment: add }, cursor: upto } });
  if (!upd.count) return (await db.usageCounter.findUnique({ where: { id: row.id } }))?.value ?? row.value;
  return row.value + add;
}

// ───────────────────────────── Base usage ─────────────────────────────

export type BackendUsage = {
  id: string;
  ref: string;
  name: string;
  status: string;
  projectId: string | null;
  active: boolean;
  functions: number;
  dbSizeBytes: number;
  storageBytes: number;
  mau: number;
  egressBytesMonth: number;
  invocationsMonth: number;
  requestsMonth: number;
  sampledAt: Date | null;
};

export async function backendsUsage(teamId: string, now = new Date()): Promise<BackendUsage[]> {
  const backends = await db.baseProject.findMany({
    where: { teamId, status: { not: "DELETING" } },
    select: { id: true, ref: true, name: true, status: true, projectId: true, _count: { select: { functions: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (!backends.length) return [];
  const ids = backends.map((b) => b.id);
  const from = monthStart(now);
  const [latest, sums] = await Promise.all([
    db.$queryRaw<{ id: string; at: Date; db: bigint; st: bigint; mau: number }[]>`
      SELECT DISTINCT ON ("baseProjectId") "baseProjectId" AS id, "at", "dbSizeBytes" AS db, "storageSizeBytes" AS st, "mau"
      FROM "BaseUsageSample" WHERE "baseProjectId" IN (${Prisma.join(ids)})
      ORDER BY "baseProjectId", "at" DESC`,
    db.$queryRaw<{ id: string; eg: bigint | null; inv: bigint | null; req: bigint | null }[]>`
      SELECT "baseProjectId" AS id, SUM("egressBytes") AS eg, SUM("functionInvocations") AS inv, SUM("requests") AS req
      FROM "BaseUsageSample" WHERE "baseProjectId" IN (${Prisma.join(ids)}) AND "at" >= ${from}
      GROUP BY 1`,
  ]);
  const L = new Map(latest.map((r) => [r.id, r]));
  const S = new Map(sums.map((r) => [r.id, r]));
  return backends.map((b) => {
    const l = L.get(b.id);
    const s = S.get(b.id);
    return {
      id: b.id,
      ref: b.ref,
      name: b.name,
      status: b.status,
      projectId: b.projectId,
      active: !(INACTIVE_BASE as readonly string[]).includes(b.status),
      functions: b._count.functions,
      dbSizeBytes: Number(l?.db ?? 0),
      storageBytes: Number(l?.st ?? 0),
      mau: Number(l?.mau ?? 0),
      egressBytesMonth: Number(s?.eg ?? 0),
      invocationsMonth: Number(s?.inv ?? 0),
      requestsMonth: Number(s?.req ?? 0),
      sampledAt: l?.at ?? null,
    };
  });
}

// ───────────────────────────── Full report (Plan & Usage page, alerts, admin) ─────────────────────────────

export type UsageItem = {
  resource: Resource;
  label: string;
  used: number;
  limit: number | null;
  /** display unit: count | MB | GB | min */
  unit: "count" | "MB" | "GB" | "min";
  ratio: number;
  enforced: boolean;
  /** alert dedupe period */
  period: "now" | "day" | "month";
  /** the backend / project this item belongs to (per-backend limits) */
  scope?: { kind: "backend" | "project"; id: string; name: string };
};

export type ProjectUsageGroup = {
  id: string;
  name: string;
  slug: string;
  domains: UsageItem;
  backend: (BackendUsage & { items: UsageItem[] }) | null;
};

export type UsageReport = {
  teamId: string;
  plan: TeamPlan["plan"];
  source: TeamPlan["source"];
  limits: PlanLimits;
  period: { month: string; from: Date; to: Date };
  deploy: UsageItem[];
  base: UsageItem[];
  projects: ProjectUsageGroup[];
  /** backends not attached to a Deploy project */
  standaloneBackends: (BackendUsage & { items: UsageItem[] })[];
  /** every item incl. per-project / per-backend ones (alerts, "over quota" lists) */
  all: UsageItem[];
  overQuota: UsageItem[];
};

export function item(limits: PlanLimits, resource: Resource, used: number, unit: UsageItem["unit"], period: UsageItem["period"], scope?: UsageItem["scope"]): UsageItem {
  const limit = limitOf(limits, resource);
  return { resource, label: RESOURCE_LABEL[resource], used, limit, unit, ratio: usageRatio(used, limit), enforced: isEnforced(limits, resource), period, scope };
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export async function usageReport(teamId: string, opts: { tp?: TeamPlan; now?: Date } = {}): Promise<UsageReport> {
  const now = opts.now ?? new Date();
  const tp = opts.tp ?? (await planFor(teamId));
  const L = tp.limits;
  const [projects, deploys24h, building, buildMs, bwBytes, members, backends] = await Promise.all([
    db.project.findMany({ where: { teamId }, select: { id: true, name: true, slug: true, _count: { select: { domains: { where: { kind: "CUSTOM" } } } } }, orderBy: { name: "asc" } }),
    counters.deploymentsSince(teamId, new Date(now.getTime() - 86400_000)),
    counters.buildingNow(teamId),
    counters.buildMsMonth(teamId),
    rollupBandwidth(teamId, now),
    counters.members(teamId),
    backendsUsage(teamId, now),
  ]);

  const deploy: UsageItem[] = [
    item(L, "deploy.projects", projects.length, "count", "now"),
    item(L, "deploy.deploymentsPerDay", deploys24h, "count", "day"),
    item(L, "deploy.concurrentBuilds", building, "count", "now"),
    item(L, "deploy.buildMinutesMonth", round(buildMs / 60_000, 1), "min", "month"),
    item(L, "deploy.bandwidthGbMonth", round(bwBytes / GB, 3), "GB", "month"),
    item(L, "deploy.members", members, "count", "now"),
  ];

  const backendItems = (b: BackendUsage): UsageItem[] => {
    const scope = { kind: "backend" as const, id: b.id, name: b.name };
    return [
      item(L, "base.dbSizeMb", round(b.dbSizeBytes / MB, 1), "MB", "now", scope),
      item(L, "base.storageMb", round(b.storageBytes / MB, 1), "MB", "now", scope),
      item(L, "base.mau", b.mau, "count", "month", scope),
      item(L, "base.functions", b.functions, "count", "now", scope),
    ];
  };
  const withItems = backends.map((b) => ({ ...b, items: backendItems(b) }));
  const base: UsageItem[] = [
    item(L, "base.projects", backends.filter((b) => b.active).length, "count", "now"),
    item(L, "base.egressGbMonth", round(backends.reduce((a, b) => a + b.egressBytesMonth, 0) / GB, 3), "GB", "month"),
    item(L, "base.functionInvocationsMonth", backends.reduce((a, b) => a + b.invocationsMonth, 0), "count", "month"),
  ];

  const byProject = new Map(withItems.filter((b) => b.projectId).map((b) => [b.projectId!, b]));
  const groups: ProjectUsageGroup[] = projects.map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    domains: item(L, "deploy.domainsPerProject", p._count.domains, "count", "now", { kind: "project", id: p.id, name: p.name }),
    backend: byProject.get(p.id) ?? null,
  }));
  const projectIds = new Set(projects.map((p) => p.id));
  const standalone = withItems.filter((b) => !b.projectId || !projectIds.has(b.projectId));

  const all = [...deploy, ...base, ...groups.map((g) => g.domains), ...withItems.flatMap((b) => b.items)];
  return {
    teamId,
    plan: tp.plan,
    source: tp.source,
    limits: L,
    period: { month: monthKey(now), from: monthStart(now), to: now },
    deploy,
    base,
    projects: groups,
    standaloneBackends: standalone,
    all,
    overQuota: all.filter((i) => i.limit !== null && i.ratio >= 1),
  };
}
