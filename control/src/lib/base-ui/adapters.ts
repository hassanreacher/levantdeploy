/**
 * The ONE place the Base dashboard talks to the runtime (`@/lib/base`, base-runtime area) and the plan library
 * (`@/lib/plans`, plans area). Pages, API routes and AI tools import from here; this file only adapts shapes
 * (DTOs the UI expects) — every operation is the real runtime / plans call. Worker-safe (no next/* imports).
 */
import type { BaseProject } from "@prisma/client";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import * as baseLib from "@/lib/base";
import { studioRunning } from "@/lib/base/studio";
import { DEFAULT_VERSIONS } from "@/lib/base/versions";
import { assertCanAddFunction, assertCanCreateProject, baseResourceLimits, counters as planCounters } from "@/lib/plans";
import type { BaseSettingsPatch } from "@/lib/base/settings";
import type { ServiceHealth } from "./shared";

export { BaseError } from "@/lib/base";

/**
 * Runtime errors (`BaseError` codes) → errors exposing `publicError()`, which `route()` renders as HTTP
 * (NOT_FOUND 404, CONFLICT/STATE 409, LIMIT 402, BAD_REQUEST 400). PlanLimitError already does this.
 */
export class BaseApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
  publicError() {
    return { status: this.status, body: { code: this.code, message: this.message } };
  }
}
const STATUS: Record<string, [number, string]> = { NOT_FOUND: [404, "NOT_FOUND"], CONFLICT: [409, "CONFLICT"], STATE: [409, "CONFLICT"], LIMIT: [402, "PLAN_LIMIT"], BAD_REQUEST: [400, "BAD_REQUEST"] };
export function translateBaseError(e: unknown): unknown {
  if (e instanceof baseLib.BaseError) {
    const [status, code] = STATUS[e.code] ?? [400, "BAD_REQUEST"];
    return new BaseApiError(status, code, e.message);
  }
  if (e && typeof e === "object" && (e as { name?: string }).name === "ZodError") return new BaseApiError(422, "VALIDATION", "Invalid settings");
  return e;
}
/** `@/lib/base` with every function's errors translated. */
const base = new Proxy(baseLib, {
  get(target, key) {
    const v = (target as Record<string | symbol, unknown>)[key];
    if (typeof v !== "function" || key === "BaseError") return v;
    return (...args: unknown[]) => {
      try {
        const r = (v as (...a: unknown[]) => unknown)(...args);
        return r instanceof Promise ? r.catch((e) => Promise.reject(translateBaseError(e))) : r;
      } catch (e) {
        throw translateBaseError(e);
      }
    };
  },
}) as typeof baseLib;

// ───────────────────────────── URLs ─────────────────────────────

export { baseDomain, internalUrl } from "@/lib/base";
export const studioUrl = (ref: string) => base.studioUrl(ref);
/** Public API URL (custom domain when verified). */
export function projectUrl(ref: string, customDomain?: string | null): string {
  return customDomain ? `https://${customDomain}` : base.projectUrl(ref);
}

// ───────────────────────────── Plans ─────────────────────────────

export type BaseLimits = {
  planName: string;
  planSlug: string;
  projects: number | null;
  dbBytes: number | null;
  storageBytes: number | null;
  maxUploadBytes: number | null;
  mau: number | null;
  egressBytes: number | null;
  invocations: number | null;
  functions: number | null;
  publicPort: boolean;
  backupsKept: number;
  pauseAfterDays: number | null;
  cpu: number | null;
  memoryMb: number | null;
};

const MB = 1024 * 1024;
const mb = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v * MB));

export async function baseLimits(teamId: string): Promise<BaseLimits> {
  const l = await baseResourceLimits(teamId);
  return {
    planName: l.plan.name,
    planSlug: l.plan.slug,
    projects: l.projects ?? null,
    dbBytes: mb(l.dbSizeMb),
    storageBytes: mb(l.storageMb),
    maxUploadBytes: mb(l.maxUploadMb),
    mau: l.mau ?? null,
    egressBytes: mb(l.egressGbMonth === null || l.egressGbMonth === undefined ? null : l.egressGbMonth * 1024),
    invocations: l.functionInvocationsMonth ?? null,
    functions: l.functions ?? null,
    publicPort: !!l.publicDbPort,
    backupsKept: l.backupsKept ?? 0,
    pauseAfterDays: l.pauseAfterDays ?? null,
    cpu: l.cpu ?? null,
    memoryMb: l.memoryMb ?? null,
  };
}

/** Throws PlanLimitError (→ HTTP 402 PLAN_LIMIT via route()) when the team can't create another Base project. */
export async function assertCanCreateBase(teamId: string, userId?: string | null): Promise<void> {
  await assertCanCreateProject(teamId, "base", { userId });
}

export async function assertCanCreateFunction(_teamId: string, baseProjectId: string): Promise<void> {
  await assertCanAddFunction(baseProjectId);
}

/** Plan summary for the create form / list header. */
export async function basePlanSummary(teamId: string, teamSlug: string): Promise<{ name: string; used: number; limit: number | null; upgradeUrl: string }> {
  const [l, used] = await Promise.all([baseLimits(teamId), planCounters.activeBackends(teamId)]);
  return { name: l.planName, used, limit: l.projects, upgradeUrl: `/${teamSlug}/settings/plan` };
}

// ───────────────────────────── Lifecycle ─────────────────────────────

export async function createBaseProject(input: { teamId: string; name: string; dbPassword?: string; createdById: string; projectId?: string | null }): Promise<BaseProject> {
  return base.createBaseProject(input);
}

export async function baseKeys(ref: string): Promise<{ url: string; internalUrl: string; anonKey: string; serviceRoleKey: string }> {
  const k = await base.baseKeys(ref);
  return { url: k.url, internalUrl: k.internalUrl, anonKey: k.anonKey, serviceRoleKey: k.serviceRoleKey };
}

export type ConnStrings = {
  host: string;
  port: number;
  database: string;
  user: string;
  poolerUser: string;
  password: string;
  /** inside the project network only (host `db`): Edge Functions, Studio */
  direct: string;
  /** pooler on levant_net (`base-{ref}`): transaction mode :6543 — what LevantDeploy apps use */
  pooler: string | null;
  /** pooler session mode :5432 (migrations, prepared statements) */
  poolerSession: string | null;
  public: string | null;
  publicHost: string | null;
  publicPort: number | null;
  sslRequired: boolean;
};

export async function connectionStrings(ref: string): Promise<ConnStrings> {
  const c = await base.connectionStrings(ref);
  return {
    host: c.pooler?.host ?? "db",
    port: c.pooler ? 6543 : 5432,
    database: c.database,
    user: c.user,
    poolerUser: c.poolerUser,
    password: c.password,
    direct: c.direct,
    pooler: c.pooler?.transaction ?? null,
    poolerSession: c.pooler?.session ?? null,
    public: c.public,
    publicHost: c.publicHost,
    publicPort: c.publicPort,
    sslRequired: c.sslRequired,
  };
}

export type StackAction = "pause" | "resume" | "restart" | "upgrade" | "delete" | "studio-start" | "studio-stop";

export async function stackAction(ref: string, action: StackAction, opts: { service?: string; actorId?: string; version?: string } = {}): Promise<void> {
  await base.stackAction(ref, action, {
    byUserId: opts.actorId ?? null,
    service: opts.service === "pooler" ? "supavisor" : opts.service,
    ...(action === "delete" ? { confirm: ref } : {}),
    ...(action === "upgrade" ? { versions: { ...DEFAULT_VERSIONS } } : {}),
  });
}

export type SqlResult = { fields: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean; durationMs: number };

export async function runSql(ref: string, sql: string, opts: { readOnly?: boolean; maxRows?: number; timeoutMs?: number } = {}): Promise<SqlResult> {
  const t0 = Date.now();
  const r = await base.runSql(ref, sql, { role: "postgres", readOnly: opts.readOnly, maxRows: opts.maxRows, timeoutMs: opts.timeoutMs });
  return { fields: r.columns, rows: r.rows, rowCount: r.rowCount, truncated: r.truncated, durationMs: Date.now() - t0 };
}

export type UsageNow = { dbBytes: number; storageBytes: number; mau: number; egressBytes: number; invocations: number };

export async function baseUsage(ref: string): Promise<UsageNow> {
  const u = await base.baseUsage(ref);
  return { dbBytes: u?.dbBytes ?? 0, storageBytes: u?.storageBytes ?? 0, mau: u?.mau ?? 0, egressBytes: u?.egressBytes ?? 0, invocations: u?.invocations ?? 0 };
}

/** Container state per service → health grid. */
export async function serviceHealth(ref: string): Promise<ServiceHealth[]> {
  const states = await base.serviceHealth(ref);
  return states.map((s) => ({
    service: s.service === "supavisor" ? "pooler" : s.service,
    state: !s.running ? (s.state === "missing" ? "missing" : "stopped") : s.health === "starting" ? "starting" : s.health === "unhealthy" ? "unhealthy" : "running",
    detail: s.running ? null : s.exitCode !== undefined ? `exited (${s.exitCode})` : null,
  }));
}

/** SSE Response with the LogViewer event format. */
export async function serviceLogsResponse(ref: string, service: string, opts: { signal?: AbortSignal; tail?: number; follow?: boolean }): Promise<Response> {
  return base.baseLogStream(ref, service === "pooler" ? "supavisor" : service, opts);
}

/** Last N log lines of one service (non-streaming; AI tool). */
export async function serviceLogLines(ref: string, service: string, tail = 200): Promise<{ ts: number; line: string }[]> {
  const text = await base.baseLogs(ref, service === "pooler" ? "supavisor" : service, tail);
  return text
    .split("\n")
    .filter(Boolean)
    .map((raw) => {
      const sp = raw.indexOf(" ");
      const ts = sp > 0 && /^\d{4}-\d{2}-\d{2}T/.test(raw) ? Date.parse(raw.slice(0, sp)) : NaN;
      return Number.isNaN(ts) ? { ts: Date.now(), line: raw } : { ts, line: raw.slice(sp + 1) };
    });
}

/** One-time Studio SSO URL (starts Studio on demand). `starting` → the UI waits before handing off the URL. */
export async function studioSsoUrl(ref: string, userId: string): Promise<{ url: string; starting: boolean }> {
  const running = await studioRunning(ref);
  const url = await base.studioSsoUrl(ref, userId);
  return { url, starting: !running };
}

export async function studioState(ref: string): Promise<"running" | "starting" | "stopped"> {
  return (await studioRunning(ref)) ? "running" : "stopped";
}

/** Validate + store settings (runtime schema incl. templates), enqueue the settings-apply job. */
export async function updateSettings(ref: string, patch: BaseSettingsPatch, actorId?: string): Promise<{ changed: string[] }> {
  const r = await base.updateBaseSettings(ref, patch, actorId ?? null);
  return { changed: r.changed };
}

// ───────────────────────────── Functions ─────────────────────────────

export async function deployFunction(ref: string, f: { slug: string; name: string; code: string; verifyJwt: boolean; files?: Record<string, string> }, actorId?: string) {
  const r = await base.deployFunction(ref, { slug: f.slug, name: f.name, source: f.code, files: f.files, verifyJwt: f.verifyJwt, byUserId: actorId ?? null });
  return r.function;
}
export async function functionSource(ref: string, slug: string): Promise<string | null> {
  return base.functionSource(ref, slug);
}
export async function deleteFunction(ref: string, slug: string, actorId?: string): Promise<void> {
  await base.deleteFunction(ref, slug, actorId ?? null);
}
export async function listFunctionSecrets(ref: string): Promise<{ name: string }[]> {
  return (await base.listFunctionSecrets(ref)).map((name) => ({ name }));
}
export async function setFunctionSecrets(ref: string, set: Record<string, string>, remove: string[] = [], actorId?: string): Promise<void> {
  const vars: Record<string, string | null> = { ...set };
  for (const r of remove) vars[r] = null;
  await base.setFunctionSecrets(ref, vars, actorId ?? null);
}
export async function invokeFunction(ref: string, slug: string, req: { method: string; body?: string; headers?: Record<string, string>; auth?: "anon" | "service_role" | "none" }) {
  const headers = { ...(req.headers ?? {}) };
  if (req.auth === "none") {
    headers.authorization = "";
    headers.apikey = "";
  }
  return base.invokeFunction(ref, slug, { method: req.method, body: req.body, headers, key: req.auth === "service_role" ? "service_role" : "anon" });
}
export async function functionLogsResponse(ref: string, _slug: string, opts: { signal?: AbortSignal }) {
  // the edge runtime logs every function to one stream
  return base.baseLogStream(ref, "functions", { ...opts, tail: 300 });
}

// ───────────────────────────── Backups ─────────────────────────────

export async function createBackup(ref: string, actorId?: string) {
  const r = await base.createBackup(ref, actorId ?? null);
  return db.baseBackup.findUniqueOrThrow({ where: { id: r.backupId! } });
}
export async function restoreBackup(ref: string, backupId: string, actorId?: string): Promise<void> {
  await base.restoreBackup(ref, backupId, actorId ?? null);
}
export async function backupFilePath(b: { path: string | null; baseProjectId: string }): Promise<string | null> {
  return base.backupFilePath(b);
}
/** Storage files archive of a backup (tar.gz), when the backup included files. */
export async function backupStorageFilePath(b: { storagePath: string | null; baseProjectId: string }): Promise<string | null> {
  return base.backupStorageFilePath(b);
}

export async function setPublicPort(ref: string, enabled: boolean, actorId?: string): Promise<number | null> {
  return (await base.setPublicPort(ref, enabled, actorId ?? null)).port;
}

export async function syncBaseRoutes(): Promise<void> {
  await base.syncBaseRoutes();
}

/** SMTP test: send a test mail through the project's saved SMTP settings. */
export async function testSmtp(ref: string, to: string): Promise<void> {
  const p = await db.baseProject.findUniqueOrThrow({ where: { ref }, select: { settings: true, name: true } });
  const { smtpConfig } = await import("./settings");
  const c = smtpConfig(p.settings);
  if (!c) throw new Error("SMTP is not configured");
  const nodemailer = await import("nodemailer");
  const t = nodemailer.createTransport({ host: c.host, port: c.port, secure: c.port === 465, auth: c.user ? { user: c.user, pass: c.pass } : undefined, connectionTimeout: 10_000, greetingTimeout: 10_000 });
  await t.sendMail({
    from: c.senderName ? `"${c.senderName.replace(/"/g, "")}" <${c.adminEmail}>` : c.adminEmail,
    to,
    subject: `LevantBase SMTP test — ${p.name}`,
    text: `This is a test email from your LevantBase project "${p.name}". Your SMTP settings work.`,
  });
}

/** Image versions this project runs vs the versions this LevantDeploy release ships. */
export async function availableVersions(ref: string): Promise<{ current: Record<string, string>; latest: Record<string, string>; upgradeAvailable: boolean }> {
  const p = await db.baseProject.findUniqueOrThrow({ where: { ref }, select: { versions: true } });
  const current = (p.versions && typeof p.versions === "object" ? p.versions : {}) as Record<string, string>;
  const latest = { ...DEFAULT_VERSIONS } as Record<string, string>;
  const upgradeAvailable = Object.keys(current).length > 0 && Object.entries(latest).some(([k, v]) => current[k] && current[k] !== v);
  return { current, latest, upgradeAvailable };
}
