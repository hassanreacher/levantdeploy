import { db } from "@/lib/db";

/**
 * Base plan limits (docs/BASE-SPEC.md "Plans & limits"). The plans area owns the Plan model + enforcement
 * (src/lib/plans: assertCanCreateProject / assertCanAddFunction / baseResourceLimits); this file only needs the numbers
 * that shape a stack. Resolution order:
 *   1. a resolver registered with `setBaseLimitsResolver` (tests)
 *   2. plans area `baseResourceLimits(teamId)` (Team.plan → Plan.limits.base)
 *   3. FREE defaults
 * Per-project overrides: BaseProject.settings.limits (platform owner).
 */
export type BaseLimits = {
  maxProjects: number | null;
  dbSizeMb: number;
  storageMb: number;
  maxUploadMb: number;
  mau: number;
  egressGb: number;
  functionInvocations: number;
  maxFunctions: number;
  /** auto-pause after N days without API activity; null = never */
  pauseAfterDays: number | null;
  /** scheduled daily backups kept (0 = manual only) */
  backupsKept: number;
  publicDbPort: boolean;
  pooler: boolean;
  /** whole stack (studio excluded) */
  cpus: number;
  memoryMb: number;
  /** soft caps that restrict when exceeded (plans area `enforce.*`): DB → read-only, storage → uploads blocked,
   *  MAU / team egress → pause (only plans that auto-pause, i.e. Hobby) */
  enforce: { dbSize: boolean; storage: boolean; mau: boolean; egress: boolean };
};

export const BASE_PLAN_DEFAULTS: Record<"free" | "pro" | "team" | "unlimited", BaseLimits> = {
  free: {
    maxProjects: 2, dbSizeMb: 500, storageMb: 1024, maxUploadMb: 50, mau: 50_000, egressGb: 5, functionInvocations: 500_000,
    maxFunctions: 10, pauseAfterDays: 7, backupsKept: 0, publicDbPort: false, pooler: false, cpus: 0.5, memoryMb: 1536,
    enforce: { dbSize: true, storage: true, mau: true, egress: true },
  },
  pro: {
    maxProjects: null, dbSizeMb: 8192, storageMb: 102_400, maxUploadMb: 5120, mau: 100_000, egressGb: 250, functionInvocations: 2_000_000,
    maxFunctions: 500, pauseAfterDays: null, backupsKept: 7, publicDbPort: true, pooler: true, cpus: 2, memoryMb: 4096,
    enforce: { dbSize: true, storage: true, mau: false, egress: false },
  },
  team: {
    maxProjects: null, dbSizeMb: 16_384, storageMb: 204_800, maxUploadMb: 5120, mau: 200_000, egressGb: 500, functionInvocations: 5_000_000,
    maxFunctions: 1000, pauseAfterDays: null, backupsKept: 14, publicDbPort: true, pooler: true, cpus: 4, memoryMb: 8192,
    enforce: { dbSize: true, storage: true, mau: false, egress: false },
  },
  unlimited: {
    maxProjects: null, dbSizeMb: 1_048_576, storageMb: 10_485_760, maxUploadMb: 51_200, mau: 10_000_000, egressGb: 100_000,
    functionInvocations: 1_000_000_000, maxFunctions: 100_000, pauseAfterDays: null, backupsKept: 30, publicDbPort: true, pooler: true, cpus: 4, memoryMb: 8192,
    enforce: { dbSize: true, storage: true, mau: false, egress: false },
  },
};

type Resolver = (teamId: string) => Promise<Partial<BaseLimits> | null>;
let resolver: Resolver | null = null;
export function setBaseLimitsResolver(fn: Resolver | null) {
  resolver = fn;
}

export function mergeLimits(base: BaseLimits, ...over: Array<Partial<BaseLimits> | null | undefined>): BaseLimits {
  const out = { ...base };
  for (const o of over) {
    if (!o) continue;
    for (const [k, v] of Object.entries(o)) {
      if (k in out && (v === null || typeof v === typeof (base as Record<string, unknown>)[k] || (base as Record<string, unknown>)[k] === null)) {
        (out as Record<string, unknown>)[k] = v;
      }
    }
  }
  return out;
}

/** Plans area (src/lib/plans): Plan.limits.base → our shape (null cpu/memory = "no limit" → generous caps). */
async function planLimitsFromDb(teamId: string): Promise<Partial<BaseLimits> | null> {
  try {
    const { baseResourceLimits } = await import("@/lib/plans/enforce");
    const b = await baseResourceLimits(teamId);
    const out: Partial<BaseLimits> = {
      maxProjects: b.enforce.projects ? b.projects : null,
      maxUploadMb: b.maxUploadMb ?? BASE_PLAN_DEFAULTS.unlimited.maxUploadMb,
      maxFunctions: b.enforce.functions && b.functions !== null ? b.functions : BASE_PLAN_DEFAULTS.unlimited.maxFunctions,
      pauseAfterDays: b.pauseAfterDays,
      backupsKept: b.backupsKept ?? 0,
      publicDbPort: b.publicDbPort,
      pooler: b.publicDbPort,
      cpus: b.cpu ?? 4,
      memoryMb: b.memoryMb ?? 8192,
      enforce: { dbSize: b.enforce.dbSize, storage: b.enforce.storage, mau: b.enforce.mau, egress: b.enforce.egress },
    };
    if (b.dbSizeMb !== null) out.dbSizeMb = b.dbSizeMb;
    if (b.storageMb !== null) out.storageMb = b.storageMb;
    if (b.mau !== null) out.mau = b.mau;
    if (b.egressGbMonth !== null) out.egressGb = b.egressGbMonth;
    if (b.functionInvocationsMonth !== null) out.functionInvocations = b.functionInvocationsMonth;
    return out;
  } catch {
    return null; // plans area not available (e.g. Plan table missing) → FREE defaults
  }
}

export async function baseLimitsForTeam(teamId: string, projectOverrides?: Partial<BaseLimits> | null): Promise<BaseLimits> {
  const fromPlan = resolver ? await resolver(teamId).catch(() => null) : await planLimitsFromDb(teamId);
  return mergeLimits(BASE_PLAN_DEFAULTS.free, fromPlan, projectOverrides);
}

// ───────────────────────────── per-service resources ─────────────────────────────

/** Share of the project's CPU/memory per service. Studio + pooler are on-demand extras outside the budget. */
const MEM_WEIGHT: Record<string, number> = {
  db: 0.3, realtime: 0.17, functions: 0.15, storage: 0.1, meta: 0.08, imgproxy: 0.06, gateway: 0.06, auth: 0.04, rest: 0.04,
};
/** measured idle RSS (Oct 2026 images): db ~110, realtime ~200, storage ~150, meta ~125, functions ~60, gw/rest/auth/imgproxy ≤ 25 MB
 *  → floors with headroom; their sum (1344 MB) is the smallest budget a stack runs reliably with. */
const MEM_MIN: Record<string, number> = { db: 256, realtime: 288, functions: 160, storage: 224, meta: 192, imgproxy: 64, gateway: 64, auth: 48, rest: 48 };
export const MIN_STACK_MEMORY_MB = Object.values(MEM_MIN).reduce((a, b) => a + b, 0);
const CPU_WEIGHT: Record<string, number> = {
  db: 0.35, realtime: 0.15, functions: 0.15, storage: 0.1, meta: 0.05, imgproxy: 0.05, gateway: 0.05, auth: 0.05, rest: 0.05,
};

export type ServiceResources = Record<string, { cpus: string; memory: string }>;

/**
 * Hard per-container limits derived from the plan's per-project budget. Memory: the core services' ceilings sum to
 * exactly the plan's memoryMb — every service gets its floor plus a weighted share of the rest; a budget below
 * MIN_STACK_MEMORY_MB scales the floors down proportionally (the stack may then fail to boot — plans should not go below
 * ~1.35 GB). CPU gets 2× its share (bursting — CPU is compressible), capped at the project total.
 */
export function serviceResources(l: Pick<BaseLimits, "cpus" | "memoryMb">): ServiceResources {
  const out: ServiceResources = {};
  const svcs = Object.keys(MEM_WEIGHT);
  const extra = l.memoryMb - MIN_STACK_MEMORY_MB;
  const scale = extra < 0 ? l.memoryMb / MIN_STACK_MEMORY_MB : 1;
  const mem: Record<string, number> = {};
  for (const svc of svcs) mem[svc] = Math.floor(MEM_MIN[svc]! * scale + Math.max(0, extra) * MEM_WEIGHT[svc]!);
  mem.db! += l.memoryMb - Object.values(mem).reduce((a, b) => a + b, 0); // rounding remainder
  for (const svc of svcs) {
    const cpu = Math.min(l.cpus, Math.max(0.05, l.cpus * CPU_WEIGHT[svc]! * 2));
    out[svc] = { cpus: cpu.toFixed(2), memory: `${mem[svc]}m` };
  }
  out.studio = { cpus: Math.max(0.5, Math.min(1, l.cpus)).toFixed(2), memory: "768m" };
  out.pooler = { cpus: Math.max(0.1, l.cpus * 0.1).toFixed(2), memory: "256m" };
  return out;
}
