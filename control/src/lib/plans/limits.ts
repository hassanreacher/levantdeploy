import { z } from "zod";

/**
 * Plan limits (plans area). Pure module — no DB, safe for the client, worker and tests.
 *
 * `Plan.limits` JSON = PlanLimits:
 *   { deploy: { projects, deploymentsPerDay, … }, base: { projects, dbSizeMb, … }, enforce: { "deploy.projects": true, … } }
 * Every numeric limit is `number | null` — null means unlimited. Booleans are feature switches.
 * `enforce[resource] === false` turns a limit into "warn only" (usage is still metered and notified at 80 % / 100 %).
 */

const num = z.number().min(0).nullable();
const int = z.number().int().min(0).nullable();

export const deployLimitsSchema = z.object({
  /** projects per team (hard) */
  projects: int,
  /** deployments created in a rolling 24 h window (hard) */
  deploymentsPerDay: int,
  /** builds running at the same time for the team (hard; extra builds wait in the queue) */
  concurrentBuilds: int,
  /** build timeout, minutes (capped by the platform setting build.timeoutMinutes) */
  buildTimeoutMinutes: int,
  /** build memory, MB (informational for the build engine) */
  buildMemoryMb: int,
  /** build minutes per month (metered) */
  buildMinutesMonth: int,
  /** egress bandwidth per month, GB (metered, soft) */
  bandwidthGbMonth: num,
  /** team members incl. pending invites (hard) */
  members: int,
  /** custom domains per project (hard) */
  domainsPerProject: int,
  /** max source upload (CLI / dashboard), MB — capped by the platform setting uploads.maxSizeMb */
  uploadMb: int,
  /** preview deployments allowed */
  previewDeployments: z.boolean(),
});

export const baseLimitsSchema = z.object({
  /** active (not paused) backends per team (hard) */
  projects: int,
  /** database size per backend, MB (soft → read-only) */
  dbSizeMb: num,
  /** file storage per backend, MB (soft → uploads blocked) */
  storageMb: num,
  /** max single file upload, MB */
  maxUploadMb: num,
  /** monthly active users per backend (soft) */
  mau: int,
  /** egress per month per team, GB (soft) */
  egressGbMonth: num,
  /** edge function invocations per month per team (soft) */
  functionInvocationsMonth: int,
  /** edge functions per backend (hard) */
  functions: int,
  /** pause a backend after N days without API activity (null = never) */
  pauseAfterDays: int,
  /** daily backups kept (0 = manual dump only) */
  backupsKept: int,
  /** a public TCP port for direct database / pooler connections */
  publicDbPort: z.boolean(),
  /** CPUs per backend (all services together; null = no limit) */
  cpu: num,
  /** memory per backend, MB (null = no limit) */
  memoryMb: int,
});

/**
 * AI app Builder (builder-agents area). One credit = one user message to the agents (any mode).
 * A message is allowed when the daily bonus still has room (`usedToday < dailyBonus`) or, otherwise, when both the
 * daily cap (`messagesPerDay`) and the monthly allowance (`messagesPerMonth`, excluding messages paid by the daily
 * bonus) have room. Hobby: 5/day & 30/month (Lovable free); Pro: 100/month + 5 bonus/day; Team: 500/month.
 */
export const builderLimitsSchema = z.object({
  /** hard cap per UTC day (null = no daily cap) */
  messagesPerDay: int,
  /** monthly allowance (UTC calendar month) */
  messagesPerMonth: int,
  /** free messages per day on top of the monthly allowance */
  dailyBonus: int,
  /** builder projects per team */
  projects: int,
  /** preview container hours per month (metered by builder-core; null = unlimited) */
  previewHoursMonth: num,
});
export type BuilderLimits = z.infer<typeof builderLimitsSchema>;

export const HOBBY_BUILDER: BuilderLimits = { messagesPerDay: 5, messagesPerMonth: 30, dailyBonus: 0, projects: 5, previewHoursMonth: null };
export const PRO_BUILDER: BuilderLimits = { messagesPerDay: null, messagesPerMonth: 100, dailyBonus: 5, projects: null, previewHoursMonth: null };
export const TEAM_BUILDER: BuilderLimits = { messagesPerDay: null, messagesPerMonth: 500, dailyBonus: 0, projects: null, previewHoursMonth: null };
export const UNLIMITED_BUILDER: BuilderLimits = { messagesPerDay: null, messagesPerMonth: null, dailyBonus: 0, projects: null, previewHoursMonth: null };

export type DeployLimits = z.infer<typeof deployLimitsSchema>;
export type BaseLimits = z.infer<typeof baseLimitsSchema>;

/** Resource keys that can be metered / enforced. */
export const RESOURCES = [
  "deploy.projects",
  "deploy.deploymentsPerDay",
  "deploy.concurrentBuilds",
  "deploy.buildMinutesMonth",
  "deploy.bandwidthGbMonth",
  "deploy.members",
  "deploy.domainsPerProject",
  "deploy.uploadMb",
  "base.projects",
  "base.dbSizeMb",
  "base.storageMb",
  "base.maxUploadMb",
  "base.mau",
  "base.egressGbMonth",
  "base.functionInvocationsMonth",
  "base.functions",
] as const;
export type Resource = (typeof RESOURCES)[number];

export const enforceSchema = z.record(z.string(), z.boolean()).default({});

export const planLimitsSchema = z.object({
  deploy: deployLimitsSchema,
  base: baseLimitsSchema,
  /** optional in stored JSON (older plans) → Hobby defaults via parseLimits */
  builder: builderLimitsSchema.default(HOBBY_BUILDER),
  enforce: enforceSchema,
});
export type PlanLimits = z.infer<typeof planLimitsSchema>;

// ───────────────────────────── Defaults (docs/BASE-SPEC.md "Plans & limits") ─────────────────────────────

const allEnforced = (): Record<string, boolean> => Object.fromEntries(RESOURCES.map((r) => [r, true]));

export const HOBBY_LIMITS: PlanLimits = {
  deploy: {
    projects: 200,
    deploymentsPerDay: 100,
    concurrentBuilds: 1,
    buildTimeoutMinutes: 45,
    buildMemoryMb: 4096,
    buildMinutesMonth: null,
    bandwidthGbMonth: 100,
    members: 1,
    domainsPerProject: 50,
    uploadMb: null,
    previewDeployments: true,
  },
  base: {
    projects: 2,
    dbSizeMb: 500,
    storageMb: 1024,
    maxUploadMb: 50,
    mau: 50_000,
    egressGbMonth: 5,
    functionInvocationsMonth: 500_000,
    functions: 10,
    pauseAfterDays: 7,
    backupsKept: 0,
    publicDbPort: false,
    cpu: 0.5,
    // base-runtime: a full stack (db, auth, rest, realtime, storage, imgproxy, meta, functions, gateway) needs ~1.35 GB
    // of per-service memory ceilings to boot reliably (idle ≈ 650 MB) → 1.5 GB (was 1 GB in BASE-SPEC)
    memoryMb: 1536,
  },
  builder: HOBBY_BUILDER,
  enforce: allEnforced(),
};

export const PRO_LIMITS: PlanLimits = {
  deploy: {
    projects: null,
    deploymentsPerDay: 6000,
    concurrentBuilds: 12,
    buildTimeoutMinutes: 45,
    buildMemoryMb: 8192,
    buildMinutesMonth: null,
    bandwidthGbMonth: 1024,
    members: null,
    domainsPerProject: null,
    uploadMb: null,
    previewDeployments: true,
  },
  base: {
    projects: null,
    dbSizeMb: 8192,
    storageMb: 100 * 1024,
    maxUploadMb: 5 * 1024,
    mau: 100_000,
    egressGbMonth: 250,
    functionInvocationsMonth: 2_000_000,
    functions: 500,
    pauseAfterDays: null,
    backupsKept: 7,
    publicDbPort: true,
    cpu: 2,
    memoryMb: 4096,
  },
  builder: PRO_BUILDER,
  enforce: allEnforced(),
};

export const TEAM_LIMITS: PlanLimits = {
  deploy: {
    ...PRO_LIMITS.deploy,
    deploymentsPerDay: 12_000,
    concurrentBuilds: 24,
    buildTimeoutMinutes: 90,
    buildMemoryMb: 16_384,
    bandwidthGbMonth: 5 * 1024,
  },
  base: {
    ...PRO_LIMITS.base,
    dbSizeMb: 32 * 1024,
    storageMb: 500 * 1024,
    maxUploadMb: 50 * 1024,
    mau: 500_000,
    egressGbMonth: 1024,
    functionInvocationsMonth: 10_000_000,
    functions: 1000,
    backupsKept: 30,
    cpu: 4,
    memoryMb: 8192,
  },
  builder: TEAM_BUILDER,
  enforce: allEnforced(),
};

/** Platform owner's own teams: no limits at all. */
export const UNLIMITED_LIMITS: PlanLimits = {
  deploy: {
    projects: null,
    deploymentsPerDay: null,
    concurrentBuilds: null,
    buildTimeoutMinutes: null,
    buildMemoryMb: null,
    buildMinutesMonth: null,
    bandwidthGbMonth: null,
    members: null,
    domainsPerProject: null,
    uploadMb: null,
    previewDeployments: true,
  },
  base: {
    projects: null,
    dbSizeMb: null,
    storageMb: null,
    maxUploadMb: null,
    mau: null,
    egressGbMonth: null,
    functionInvocationsMonth: null,
    functions: null,
    pauseAfterDays: null,
    backupsKept: 30,
    publicDbPort: true,
    cpu: null,
    memoryMb: null,
  },
  builder: UNLIMITED_BUILDER,
  enforce: allEnforced(),
};

export const DEFAULT_PLANS = [
  { slug: "hobby", name: "Hobby", description: "For personal projects and experiments.", priceMonthly: 0, limits: HOBBY_LIMITS, isDefault: true, isInternal: false, sortOrder: 0 },
  { slug: "pro", name: "Pro", description: "For professionals shipping production apps.", priceMonthly: 20, limits: PRO_LIMITS, isDefault: false, isInternal: false, sortOrder: 10 },
  { slug: "team", name: "Team", description: "For teams with higher traffic and more backends.", priceMonthly: 50, limits: TEAM_LIMITS, isDefault: false, isInternal: false, sortOrder: 20 },
  {
    slug: "unlimited",
    name: "Unlimited (internal)",
    description: "The platform owner's own teams. Not offered to other teams.",
    priceMonthly: null,
    limits: UNLIMITED_LIMITS,
    isDefault: false,
    isInternal: true,
    sortOrder: 100,
  },
] as const;

/** Built-in defaults for a plan slug (fallback for keys missing in stored limits, e.g. `builder` on older rows). */
export function defaultLimitsForSlug(slug: string | null | undefined): PlanLimits {
  return (DEFAULT_PLANS.find((p) => p.slug === slug)?.limits as PlanLimits | undefined) ?? HOBBY_LIMITS;
}

/**
 * Parses stored limits leniently: missing keys fall back to the Hobby defaults (so a plan stored by an
 * older version keeps working after new limits are added).
 */
export function parseLimits(raw: unknown, fallback: PlanLimits = HOBBY_LIMITS): PlanLimits {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const merged = {
    deploy: { ...fallback.deploy, ...((o.deploy as object) ?? {}) },
    base: { ...fallback.base, ...((o.base as object) ?? {}) },
    builder: { ...fallback.builder, ...((o.builder as object) ?? {}) },
    enforce: { ...fallback.enforce, ...((o.enforce as object) ?? {}) },
  };
  const r = planLimitsSchema.safeParse(merged);
  return r.success ? r.data : fallback;
}

/** limit value of a resource ("deploy.projects" → limits.deploy.projects). */
export function limitOf(limits: PlanLimits, resource: Resource): number | null {
  const [group, key] = resource.split(".") as ["deploy" | "base", string];
  const v = (limits[group] as Record<string, unknown>)[key];
  return typeof v === "number" ? v : null;
}

export const isEnforced = (limits: PlanLimits, resource: Resource) => limits.enforce[resource] !== false;

/** 0..∞ ratio used for bars and 80 % / 100 % alerts (0 when unlimited). */
export function usageRatio(used: number, limit: number | null): number {
  if (limit === null) return 0;
  if (limit === 0) return used > 0 ? Infinity : 1;
  return used / limit;
}

// ───────────────────────────── Form descriptor (JSON-schema-like, drives the admin form) ─────────────────────────────

export type LimitField = {
  key: string; // "deploy.projects"
  group: "deploy" | "base" | "builder";
  label: string;
  type: "integer" | "number" | "boolean";
  unit?: string;
  /** enforce flag applies (resource key) */
  resource?: Resource;
  /** null allowed (unlimited) */
  nullable: boolean;
  hint?: string;
};

export const LIMIT_FIELDS: LimitField[] = [
  { key: "deploy.projects", group: "deploy", label: "Projects", type: "integer", nullable: true, resource: "deploy.projects" },
  { key: "deploy.deploymentsPerDay", group: "deploy", label: "Deployments per day", type: "integer", nullable: true, resource: "deploy.deploymentsPerDay", hint: "Rolling 24 hours" },
  { key: "deploy.concurrentBuilds", group: "deploy", label: "Concurrent builds", type: "integer", nullable: true, resource: "deploy.concurrentBuilds", hint: "Extra builds wait in the queue" },
  { key: "deploy.buildTimeoutMinutes", group: "deploy", label: "Build timeout", type: "integer", unit: "min", nullable: true },
  { key: "deploy.buildMemoryMb", group: "deploy", label: "Build memory", type: "integer", unit: "MB", nullable: true },
  { key: "deploy.buildMinutesMonth", group: "deploy", label: "Build minutes / month", type: "integer", unit: "min", nullable: true, resource: "deploy.buildMinutesMonth" },
  { key: "deploy.bandwidthGbMonth", group: "deploy", label: "Bandwidth / month", type: "number", unit: "GB", nullable: true, resource: "deploy.bandwidthGbMonth" },
  { key: "deploy.members", group: "deploy", label: "Team members", type: "integer", nullable: true, resource: "deploy.members", hint: "Including pending invites" },
  { key: "deploy.domainsPerProject", group: "deploy", label: "Custom domains / project", type: "integer", nullable: true, resource: "deploy.domainsPerProject" },
  { key: "deploy.uploadMb", group: "deploy", label: "Source upload size", type: "integer", unit: "MB", nullable: true, resource: "deploy.uploadMb" },
  { key: "deploy.previewDeployments", group: "deploy", label: "Preview deployments", type: "boolean", nullable: false },
  { key: "base.projects", group: "base", label: "Active backends", type: "integer", nullable: true, resource: "base.projects" },
  { key: "base.dbSizeMb", group: "base", label: "Database size / backend", type: "number", unit: "MB", nullable: true, resource: "base.dbSizeMb", hint: "Over → database read-only" },
  { key: "base.storageMb", group: "base", label: "File storage / backend", type: "number", unit: "MB", nullable: true, resource: "base.storageMb", hint: "Over → uploads blocked" },
  { key: "base.maxUploadMb", group: "base", label: "Max upload size", type: "number", unit: "MB", nullable: true, resource: "base.maxUploadMb" },
  { key: "base.mau", group: "base", label: "Monthly active users / backend", type: "integer", nullable: true, resource: "base.mau" },
  { key: "base.egressGbMonth", group: "base", label: "Egress / month", type: "number", unit: "GB", nullable: true, resource: "base.egressGbMonth" },
  { key: "base.functionInvocationsMonth", group: "base", label: "Function invocations / month", type: "integer", nullable: true, resource: "base.functionInvocationsMonth" },
  { key: "base.functions", group: "base", label: "Edge functions / backend", type: "integer", nullable: true, resource: "base.functions" },
  { key: "base.pauseAfterDays", group: "base", label: "Pause after inactivity", type: "integer", unit: "days", nullable: true, hint: "Empty = never paused" },
  { key: "base.backupsKept", group: "base", label: "Daily backups kept", type: "integer", nullable: true, hint: "0 = manual dump only" },
  { key: "base.publicDbPort", group: "base", label: "Public database port", type: "boolean", nullable: false },
  { key: "base.cpu", group: "base", label: "CPU / backend", type: "number", unit: "vCPU", nullable: true },
  { key: "base.memoryMb", group: "base", label: "Memory / backend", type: "integer", unit: "MB", nullable: true },
  // builder-ui: AI app Builder limits (enforced by builder-agents via assertCanUseBuilder / assertCanCreateBuilderProject)
  { key: "builder.messagesPerDay", group: "builder", label: "AI messages / day", type: "integer", nullable: true, hint: "Hard daily cap · empty = no daily cap" },
  { key: "builder.messagesPerMonth", group: "builder", label: "AI messages / month", type: "integer", nullable: true, hint: "Monthly allowance · empty = unlimited" },
  { key: "builder.dailyBonus", group: "builder", label: "Daily bonus messages", type: "integer", nullable: true, hint: "Free messages per day on top of the monthly allowance" },
  { key: "builder.projects", group: "builder", label: "AI builder apps", type: "integer", nullable: true },
  { key: "builder.previewHoursMonth", group: "builder", label: "Preview hours / month", type: "number", unit: "h", nullable: true },
];

/** JSON Schema (draft 2020-12) of PlanLimits — served to the admin form and API clients. */
export function limitsJsonSchema() {
  const prop = (f: LimitField) => {
    const t = f.type === "boolean" ? "boolean" : f.type;
    return { type: f.nullable ? [t, "null"] : t, ...(f.type !== "boolean" ? { minimum: 0 } : {}), title: f.label, ...(f.unit ? { "x-unit": f.unit } : {}), ...(f.hint ? { description: f.hint } : {}) };
  };
  const group = (g: "deploy" | "base" | "builder") => ({
    type: "object",
    additionalProperties: false,
    required: LIMIT_FIELDS.filter((f) => f.group === g).map((f) => f.key.split(".")[1]),
    properties: Object.fromEntries(LIMIT_FIELDS.filter((f) => f.group === g).map((f) => [f.key.split(".")[1], prop(f)])),
  });
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "PlanLimits",
    type: "object",
    required: ["deploy", "base", "enforce"],
    properties: {
      deploy: group("deploy"),
      base: group("base"),
      builder: group("builder"),
      enforce: { type: "object", description: "resource → enforce (false = warn only)", properties: Object.fromEntries(RESOURCES.map((r) => [r, { type: "boolean" }])) },
    },
  };
}

export const RESOURCE_LABEL: Record<Resource, string> = Object.fromEntries(
  RESOURCES.map((r) => [r, LIMIT_FIELDS.find((f) => f.key === r)?.label ?? r]),
) as Record<Resource, string>;
