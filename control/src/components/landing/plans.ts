import "server-only";
import { db } from "@/lib/db";
import { DEFAULT_PLANS as PLAN_DEFAULTS, defaultLimitsForSlug, parseLimits, type PlanLimits } from "@/lib/plans/limits";

/** A plan as shown on the marketing pages. */
export type PublicPlan = {
  slug: string;
  name: string;
  priceMonthly: number | null; // null → "Custom"
  blurb: string;
  highlight?: boolean;
  builder: string[];
  deploy: string[];
  backend: string[];
  limits: PlanLimits;
};

const fmt = (n: number) => n.toLocaleString("en-US");
const count = (n: number | null, unit: string, unlimited = `Unlimited ${unit}`) => (n === null ? unlimited : `${fmt(n)} ${unit}`);
function size(mb: number | null) {
  if (mb === null) return "Unlimited";
  return mb >= 1024 ? `${+(mb / 1024).toFixed(1)} GB` : `${fmt(mb)} MB`;
}
const gb = (n: number | null) => (n === null ? "Unlimited" : n >= 1024 ? `${+(n / 1024).toFixed(1)} TB` : `${fmt(n)} GB`);
function compact(n: number | null) {
  if (n === null) return "Unlimited";
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3 && n % 1000 === 0) return `${fmt(n / 1000)}k`;
  return fmt(n);
}

/** "AI credits" line: one credit = one message to the builder agents. */
export function builderCredits(l: PlanLimits) {
  const { messagesPerDay: day, messagesPerMonth: month, dailyBonus: bonus } = l.builder;
  if (day === null && month === null) return "Unlimited AI messages";
  if (month === null) return `${fmt(day!)} AI messages / day`;
  if (day !== null) return `${fmt(day)} AI messages / day, ${fmt(month)} / month`; // Hobby
  return `${fmt(month)} AI messages / month${bonus ? ` + ${fmt(bonus)} / day bonus` : ""}`; // Pro, Team
}

/** Display bullets from a plan's limits (src/lib/plans/limits.ts). */
export function bullets(l: PlanLimits) {
  const d = l.deploy;
  const b = l.base;
  const deploy = [
    count(d.projects, "projects"),
    count(d.deploymentsPerDay, "deployments / day", "Unlimited deployments"),
    `${count(d.concurrentBuilds, d.concurrentBuilds === 1 ? "concurrent build" : "concurrent builds")}${d.buildTimeoutMinutes ? ` · ${d.buildTimeoutMinutes} min timeout` : ""}`,
    `${gb(d.bandwidthGbMonth)} bandwidth / mo`,
    d.members === null ? "Unlimited team members" : d.members === 1 ? "1 member (owner)" : `${fmt(d.members)} team members`,
    ...(d.previewDeployments ? ["Preview deployments"] : []),
  ];
  const backend = [
    count(b.projects, b.projects === 1 ? "active backend" : "active backends", "Unlimited backends"),
    `${size(b.dbSizeMb)} database · ${size(b.storageMb)} storage`,
    `${compact(b.mau)} monthly active users`,
    `${compact(b.functionInvocationsMonth)} function invocations / mo`,
    b.pauseAfterDays === null ? "Never paused" : `Paused after ${b.pauseAfterDays} days idle`,
    b.backupsKept ? `Daily backups kept ${b.backupsKept} days` : "Manual backups",
    ...(b.publicDbPort ? ["Public database port"] : []),
  ];
  const builder = [
    builderCredits(l),
    l.builder.projects === null ? "Unlimited builder apps" : `${fmt(l.builder.projects)} builder apps`,
    "Visual editor, version history, ZIP export",
  ];
  return { builder, deploy, backend };
}

type Row = { slug: string; name: string; description: string | null; priceMonthly: number | null; limits: unknown };

function toPublic(r: Row): PublicPlan {
  const limits = parseLimits(r.limits, defaultLimitsForSlug(r.slug));
  return { slug: r.slug, name: r.name, priceMonthly: r.priceMonthly, blurb: r.description ?? "", highlight: r.slug === "pro", limits, ...bullets(limits) };
}

/** Rows of the /pricing comparison table. */
export const COMPARISON: { group: string; rows: { label: string; value: (l: PlanLimits) => string | boolean }[] }[] = [
  {
    group: "AI Builder",
    rows: [
      { label: "AI messages (credits)", value: (l) => builderCredits(l) },
      { label: "Daily cap", value: (l) => (l.builder.messagesPerDay === null ? "None" : `${fmt(l.builder.messagesPerDay)} / day`) },
      { label: "Builder apps", value: (l) => (l.builder.projects === null ? "Unlimited" : fmt(l.builder.projects)) },
      { label: "Visual editing & version history", value: () => true },
      { label: "Publish with custom domains", value: () => true },
      { label: "ZIP / GitHub export", value: () => true },
    ],
  },
  {
    group: "Deployments",
    rows: [
      { label: "Projects", value: (l) => (l.deploy.projects === null ? "Unlimited" : fmt(l.deploy.projects)) },
      { label: "Deployments per day", value: (l) => (l.deploy.deploymentsPerDay === null ? "Unlimited" : fmt(l.deploy.deploymentsPerDay)) },
      { label: "Concurrent builds", value: (l) => (l.deploy.concurrentBuilds === null ? "Unlimited" : fmt(l.deploy.concurrentBuilds)) },
      { label: "Build timeout", value: (l) => (l.deploy.buildTimeoutMinutes === null ? "None" : `${l.deploy.buildTimeoutMinutes} min`) },
      { label: "Build memory", value: (l) => size(l.deploy.buildMemoryMb) },
      { label: "Bandwidth / month", value: (l) => gb(l.deploy.bandwidthGbMonth) },
      { label: "Team members", value: (l) => (l.deploy.members === null ? "Unlimited" : fmt(l.deploy.members)) },
      { label: "Custom domains / project", value: (l) => (l.deploy.domainsPerProject === null ? "Unlimited" : fmt(l.deploy.domainsPerProject)) },
      { label: "Preview deployments", value: (l) => l.deploy.previewDeployments },
    ],
  },
  {
    group: "Backend",
    rows: [
      { label: "Active backends", value: (l) => (l.base.projects === null ? "Unlimited" : fmt(l.base.projects)) },
      { label: "Database size", value: (l) => size(l.base.dbSizeMb) },
      { label: "File storage", value: (l) => size(l.base.storageMb) },
      { label: "Max upload", value: (l) => size(l.base.maxUploadMb) },
      { label: "Monthly active users", value: (l) => compact(l.base.mau) },
      { label: "Egress / month", value: (l) => gb(l.base.egressGbMonth) },
      { label: "Function invocations / month", value: (l) => compact(l.base.functionInvocationsMonth) },
      { label: "Edge functions", value: (l) => (l.base.functions === null ? "Unlimited" : fmt(l.base.functions)) },
      { label: "Auto-pause when idle", value: (l) => (l.base.pauseAfterDays === null ? "Never" : `After ${l.base.pauseAfterDays} days`) },
      { label: "Daily backups kept", value: (l) => (l.base.backupsKept ? `${l.base.backupsKept} days` : "Manual only") },
      { label: "Public database port", value: (l) => l.base.publicDbPort },
      { label: "Compute per backend", value: (l) => `${l.base.cpu === null ? "Unlimited" : `${l.base.cpu} CPU`} · ${size(l.base.memoryMb)} RAM` },
    ],
  },
];

/** Static defaults (same as the plans area's seed) — used when the DB has no public plans or is unreachable. */
export const DEFAULT_PLANS: PublicPlan[] = PLAN_DEFAULTS.filter((p) => !p.isInternal).map((p) =>
  toPublic({ slug: p.slug, name: p.name, description: p.description, priceMonthly: p.priceMonthly, limits: p.limits }),
);

/** Public (non-internal, non-archived) plans from the DB, ordered; falls back to the defaults. Never throws. */
export async function getPublicPlans(): Promise<{ plans: PublicPlan[]; source: "db" | "default" }> {
  try {
    const rows = await db.plan.findMany({
      where: { isInternal: false, archivedAt: null },
      orderBy: [{ sortOrder: "asc" }, { priceMonthly: "asc" }],
      select: { slug: true, name: true, description: true, priceMonthly: true, limits: true },
      take: 4,
    });
    if (!rows.length) return { plans: DEFAULT_PLANS, source: "default" };
    return { plans: rows.map(toPublic), source: "db" };
  } catch {
    return { plans: DEFAULT_PLANS, source: "default" };
  }
}

export function formatPrice(p: PublicPlan) {
  if (p.priceMonthly === null) return "Custom";
  return `$${p.priceMonthly}`;
}
