import fs from "node:fs";
import path from "node:path";
import type { BaseProject } from "@prisma/client";
import { db } from "@/lib/db";
import { ensureNetwork } from "@/lib/docker";
import { redis } from "@/lib/redis";
import { syncRoutes } from "@/lib/proxy/sync";
import { compose, containerIp, psql, serviceLogs, stackState, waitHealthy, execIn } from "./compose";
import { STUDIO_LAST_KEY, STUDIO_RUNNING_KEY, backupsDir, CORE_SERVICES, gatewayContainer, isService, projectDir, publicNetwork, type BaseService } from "./config";
import { loadRenderInput, requireBase } from "./context";
import { baseEvent, setBaseStatus } from "./events";
import { renderStack } from "./render";
import { decryptSecrets } from "./secrets";
import type { BaseLimits } from "./limits";

/**
 * Worker-side stack operations (called by the `base` queue processor, src/worker/processors/base.ts).
 * Each one: status transition → docker compose → health → status + BaseEvent timeline. Failures → ERROR + logs.
 */

type Log = (msg: string) => void;
const noop: Log = () => {};


async function profilesFor(ref: string): Promise<string[]> {
  const st = await stackState(ref).catch(() => []);
  const out: string[] = [];
  if (st.some((s) => s.service === "studio" && s.running)) out.push("studio");
  if (st.some((s) => s.service === "supavisor" && s.running)) out.push("pooler");
  return out;
}

/** Supavisor runs when the plan includes the pooler, or when a public DB port is enabled (plan publicDbPort). */
export const poolerEnabled = (p: Pick<BaseProject, "dbPublicPort">, l: BaseLimits) => l.pooler || (l.publicDbPort && p.dbPublicPort != null);

async function render(p: BaseProject, versions?: Record<string, string>) {
  const input = await loadRenderInput(p, { versions });
  renderStack(input);
  return input;
}

/** Probe the public API through the gateway (same path Caddy uses), with the project's own keys. */
export async function probeGateway(ref: string, log: Log = noop) {
  const p = await requireBase(ref);
  const s = decryptSecrets(p.secretsEnc);
  const ip = await containerIp(gatewayContainer(ref), publicNetwork());
  if (!ip) throw new Error("gateway has no address on the shared network");
  const base = `http://${ip}:8000`;
  const checks: Array<[string, string, string]> = [
    ["auth", "/auth/v1/health", s.anonKey],
    ["rest", "/rest/v1/", s.serviceRoleKey], // the OpenAPI root is service-role only (upstream envoy)
    ["storage", "/storage/v1/bucket", s.serviceRoleKey],
    ["meta", "/pg/health", s.serviceRoleKey],
    // any non-5xx from the edge runtime's main router (unknown function → 404) = reachable
    ["functions", "/functions/v1/__levant_probe", s.anonKey],
  ];
  for (const [name, p2, key] of checks) {
    let last = "";
    // 4 consecutive successes: after a container restart Envoy can keep a stale endpoint (old IP) in its round robin
    // for a while — one lucky success is not enough (seen after restore: alternating 503/400)
    let streak = 0;
    last = "not checked";
    for (let i = 0; i < 60 && streak < 4; i++) {
      try {
        const r = await fetch(base + p2, { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) });
        if (r.ok || (name === "functions" && r.status < 500)) {
          streak++;
          last = "";
          await r.arrayBuffer().catch(() => {});
          if (streak < 4) await new Promise((res) => setTimeout(res, 300));
          continue;
        }
        last = `${r.status} ${(await r.text()).slice(0, 200)}`;
      } catch (e) {
        last = (e as Error).message;
      }
      streak = 0;
      await new Promise((res) => setTimeout(res, 2000));
    }
    if (!last) log(`${name} answers through the gateway`);
    if (last || streak < 4) throw new Error(`${name} check via gateway failed: ${last || "unstable"}`);
  }
}

async function fail(p: Pick<BaseProject, "id" | "ref">, action: string, e: unknown, actorId?: string | null) {
  const msg = (e as Error).message ?? String(e);
  await setBaseStatus(p.ref, "ERROR", { message: `${action} failed: ${msg.split("\n")[0]!.slice(0, 500)}` }).catch(() => {});
  await baseEvent(p, "error", `${action} failed: ${msg}`, { level: "error", actorId });
  await syncRoutes().catch(() => {});
}

/** Profiles for `up`: studio if it is running, pooler when enabled; a pooler that is no longer wanted is removed. */
async function wantedProfiles(p: BaseProject, limits: BaseLimits): Promise<{ profiles: string[]; pooler: boolean }> {
  const running = await profilesFor(p.ref);
  const pooler = poolerEnabled(p, limits);
  if (!pooler && running.includes("pooler")) {
    await compose(p.ref, ["rm", "-sf", "supavisor"], { profiles: ["pooler"] }).catch(() => {});
  }
  const profiles = running.filter((x) => x !== "pooler");
  if (pooler) profiles.push("pooler");
  return { profiles, pooler };
}

/** Render + up + health + gateway probe. Used by provision, resume (from scratch), upgrade, recover from ERROR. */
async function upAndWait(p: BaseProject, log: Log, opts: { versions?: Record<string, string>; pull?: "missing" | "always" } = {}) {
  await ensureNetwork(publicNetwork());
  const input = await render(p, opts.versions);
  const { profiles, pooler } = await wantedProfiles(p, input.limits);
  await compose(p.ref, ["up", "-d", "--pull", opts.pull ?? "missing", "--remove-orphans"], { profiles, onLine: log, timeoutMs: 30 * 60_000 });
  const services: BaseService[] = [...CORE_SERVICES];
  if (pooler) services.push("supavisor");
  await waitHealthy(p.ref, services, { onProgress: log });
  await probeGateway(p.ref, log);
  return input;
}

export async function provision(ref: string, actorId?: string | null) {
  const p = await requireBase(ref);
  const lines: string[] = [];
  // base-dashboard (additive): throttled progress rows for the live provisioning screen
  let lastProgress = 0;
  const log: Log = (m) => {
    lines.push(m);
    const now = Date.now();
    if (now - lastProgress > 2500 && /pull|creat|start|health|gateway|answers|database/i.test(m)) {
      lastProgress = now;
      void baseEvent(p, "provision", m.replace(/\s+/g, " ").trim().slice(0, 200));
    }
  };
  await setBaseStatus(ref, "PROVISIONING");
  await baseEvent(p, "provision", "Provisioning started", { actorId });
  try {
    const input = await upAndWait(p, log);
    await setBaseStatus(ref, "ACTIVE", { extra: { versions: input.versions, pausedAt: null, lastActivityAt: p.lastActivityAt ?? new Date() } });
    await baseEvent(p, "provision", "Project is ready", { level: "success", meta: { steps: lines.slice(-40) } });
    await syncRoutes();
  } catch (e) {
    await fail(p, "Provisioning", e, actorId);
    throw e;
  }
}

export async function pause(ref: string, actorId?: string | null, reason = "Paused") {
  const p = await requireBase(ref);
  await setBaseStatus(ref, "PAUSING");
  try {
    await syncRoutes(); // stop routing first → visitors get the paused page
    await compose(ref, ["stop"], { profiles: ["studio", "pooler"] });
    await redis().del(STUDIO_RUNNING_KEY(ref)).catch(() => {});
    await setBaseStatus(ref, "PAUSED", { extra: { pausedAt: new Date() } });
    await baseEvent(p, "pause", reason, { actorId });
    await syncRoutes();
  } catch (e) {
    await fail(p, "Pause", e, actorId);
    throw e;
  }
}

export async function resume(ref: string, actorId?: string | null) {
  const p = await requireBase(ref);
  await setBaseStatus(ref, "PROVISIONING", { message: "Resuming" });
  await baseEvent(p, "resume", "Resuming", { actorId });
  try {
    const input = await upAndWait(p, noop);
    await setBaseStatus(ref, "ACTIVE", { extra: { versions: input.versions, pausedAt: null, lastActivityAt: new Date() } });
    await baseEvent(p, "resume", "Project is running again", { level: "success" });
    const { ensureOwnershipFixed } = await import("./ownership");
    await ensureOwnershipFixed(ref).catch((e) => baseEvent(p, "maintenance", `Ownership fix failed: ${(e as Error).message}`, { level: "warning" }));
    await syncRoutes();
  } catch (e) {
    await fail(p, "Resume", e, actorId);
    throw e;
  }
}

export async function restart(ref: string, service?: string | null, actorId?: string | null) {
  const p = await requireBase(ref);
  if (service && !isService(service)) throw new Error(`unknown service ${service}`);
  try {
    if (service) {
      await compose(ref, ["restart", service], { profiles: await profilesFor(ref) });
      await waitHealthy(ref, [service as BaseService]);
    } else {
      await compose(ref, ["restart"], { profiles: await profilesFor(ref) });
      await waitHealthy(ref, CORE_SERVICES);
    }
    if (p.status === "ERROR") await setBaseStatus(ref, "ACTIVE");
    await baseEvent(p, "restart", service ? `Restarted ${service}` : "Restarted all services", { level: "success", actorId });
  } catch (e) {
    await fail(p, "Restart", e, actorId);
    throw e;
  }
}

/** Re-render with new image versions (default: the platform's current defaults) and recreate changed containers. */
export async function upgrade(ref: string, versions?: Record<string, string>, actorId?: string | null) {
  const p = await requireBase(ref);
  await setBaseStatus(ref, "UPGRADING");
  await baseEvent(p, "upgrade", "Upgrade started", { actorId, meta: { versions } });
  try {
    // explicit versions override; otherwise move every service to the defaults of this LevantDeploy release
    const target = versions ?? {};
    const input = await upAndWait({ ...p, versions: versions ? p.versions : {} }, noop, { versions: target });
    await setBaseStatus(ref, "ACTIVE", { extra: { versions: input.versions } });
    await baseEvent(p, "upgrade", "Upgrade finished", { level: "success", meta: { versions: input.versions } });
    await syncRoutes();
  } catch (e) {
    await fail(p, "Upgrade", e, actorId);
    throw e;
  }
}

/** Re-render with the current settings; compose recreates only services whose effective config changed. */
export async function applySettings(ref: string, actorId?: string | null) {
  const p = await requireBase(ref);
  if (p.status === "PAUSED" || p.status === "PAUSING") {
    await render(p); // applied on resume
    await baseEvent(p, "settings", "Settings saved (applied when the project is resumed)", { actorId });
    return { recreated: [] as string[] };
  }
  try {
    const before = await stackState(ref);
    const input = await render(p);
    const { profiles, pooler } = await wantedProfiles(p, input.limits);
    const out = await compose(ref, ["up", "-d", "--pull", "missing"], { profiles, timeoutMs: 20 * 60_000 });
    const recreated = [...new Set([...out.matchAll(/Container lb_[a-z]+_([a-z-]+)\s+(Recreate|Creat)/g)].map((m) => m[1]!))];
    await waitHealthy(ref, pooler ? [...CORE_SERVICES, "supavisor"] : CORE_SERVICES);
    // compat: an earlier failed apply left the project in ERROR (502 for every request) although the stack is healthy
    // again with the current settings → back to ACTIVE so the gateway route is restored.
    if (p.status === "ERROR") {
      await setBaseStatus(ref, "ACTIVE", { message: null });
      await syncRoutes().catch(() => {});
    }
    await baseEvent(p, "settings", recreated.length ? `Settings applied (recreated ${recreated.join(", ")})` : "Settings applied (no service changed)", {
      level: "success",
      actorId,
      meta: { recreated, before: before.length },
    });
    return { recreated };
  } catch (e) {
    await fail(p, "Applying settings", e, actorId);
    throw e;
  }
}

/** docker compose down -v + files. The row is deleted by the caller (or here when `dropRow`). */
export async function destroy(ref: string, actorId?: string | null, opts: { dropRow?: boolean } = { dropRow: true }) {
  const p = await db.baseProject.findUnique({ where: { ref } });
  if (p) await setBaseStatus(ref, "DELETING").catch(() => {});
  if (p) await baseEvent(p, "delete", "Deleting project", { level: "warning", actorId });
  await syncRoutes().catch(() => {});
  const dir = projectDir(ref);
  if (fs.existsSync(path.join(dir, "docker-compose.yml"))) {
    await compose(ref, ["down", "-v", "--remove-orphans", "--timeout", "20"], { profiles: ["studio", "pooler"] });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  await redis().del(STUDIO_RUNNING_KEY(ref), STUDIO_LAST_KEY(ref), `lb:usage:${ref}`).catch(() => {});
  if (p && opts.dropRow !== false) await db.baseProject.delete({ where: { id: p.id } }).catch(() => {});
  await syncRoutes().catch(() => {});
}

// ───────────────────────────── studio ─────────────────────────────

export async function studioStart(ref: string, actorId?: string | null) {
  const p = await requireBase(ref);
  if (p.status !== "ACTIVE") throw new Error(`project is ${p.status}`);
  await compose(ref, ["up", "-d", "--pull", "missing", "studio"], { profiles: ["studio"], timeoutMs: 20 * 60_000 });
  await waitHealthy(ref, ["studio"], { timeoutMs: 4 * 60_000 });
  await redis().set(STUDIO_RUNNING_KEY(ref), "1");
  await redis().set(STUDIO_LAST_KEY(ref), String(Date.now()));
  await baseEvent(p, "studio", "Studio started", { actorId });
}

export async function studioStop(ref: string, reason = "Studio stopped") {
  const p = await requireBase(ref);
  await compose(ref, ["stop", "studio"], { profiles: ["studio"] }).catch(() => {});
  await compose(ref, ["rm", "-f", "studio"], { profiles: ["studio"] }).catch(() => {});
  await redis().del(STUDIO_RUNNING_KEY(ref)).catch(() => {});
  await baseEvent(p, "studio", reason);
}

/** Stop studios without activity for STUDIO_IDLE_MS (schedule every 5 min). */
export async function studioIdleSweep(idleMs: number, now = Date.now()) {
  const keys = await redis().keys("lb:studio:running:*");
  const stopped: string[] = [];
  for (const k of keys) {
    const ref = k.split(":").pop()!;
    const last = Number((await redis().get(STUDIO_LAST_KEY(ref))) ?? 0);
    if (now - last > idleMs) {
      await studioStop(ref, `Studio stopped after ${Math.round(idleMs / 60_000)} min without activity`).catch(() => {});
      stopped.push(ref);
    }
  }
  return stopped;
}

// ───────────────────────────── backups ─────────────────────────────

/** Schemas we dump: everything except the ones the postgres image / platform services own and recreate. */
export const SYSTEM_SCHEMAS = [
  "pg_catalog", "information_schema", "pg_toast", "extensions", "graphql", "graphql_public", "pgbouncer", "pgsodium", "pgsodium_masks",
  "realtime", "_realtime", "supabase_functions", "vault", "net", "_analytics", "cron", "topology", "tiger", "tiger_data", "_supavisor",
];

export async function dumpSchemas(ref: string): Promise<string[]> {
  const out = await psql(ref, `select nspname from pg_namespace where nspname not like 'pg_temp_%' and nspname not like 'pg_toast%' order by 1;`);
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !SYSTEM_SCHEMAS.includes(s));
}

export async function runBackup(backupId: string) {
  const b = await db.baseBackup.findUnique({ where: { id: backupId }, include: { baseProject: true } });
  if (!b) throw new Error("backup not found");
  const p = b.baseProject;
  const dir = backupsDir(p.ref);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = `${p.ref}-${new Date().toISOString().replace(/[:.]/g, "-")}-${b.kind.toLowerCase()}.sql.gz`;
  const abs = path.join(dir, file);
  const absStorage = abs.replace(/\.sql\.gz$/, ".storage.tar.gz");
  try {
    const schemas = await dumpSchemas(p.ref);
    const nArgs = schemas.map((s) => `-n '${s.replace(/'/g, "")}'`).join(" ");
    const r = await execIn(p.ref, "db", ["sh", "-c", `set -o pipefail 2>/dev/null; pg_dump -U supabase_admin -h localhost -d postgres --clean --if-exists --quote-all-identifiers ${nArgs} | gzip -c`], {
      stdoutFile: abs,
    });
    if (r.code !== 0 || /pg_dump: error/.test(r.err)) throw new Error(r.err.trim().slice(-2000) || `pg_dump exit ${r.code}`);
    const size = fs.statSync(abs).size;
    if (size < 20) throw new Error(`dump is empty: ${r.err.slice(-500)}`);
    // storage files (file backend volume) next to the dump
    const t = await execIn(p.ref, "storage", ["sh", "-c", "tar czf - -C /var/lib/storage ."], { stdoutFile: absStorage });
    if (t.code !== 0) throw new Error(`storage archive failed: ${t.err.trim().slice(-1000)}`);
    const stSize = fs.statSync(absStorage).size;
    const rel = (f: string) => path.relative(path.resolve(projectDir(p.ref), "..", ".."), f);
    await db.baseBackup.update({
      where: { id: b.id },
      data: {
        status: "SUCCEEDED", path: rel(abs), sizeBytes: BigInt(size), storagePath: rel(absStorage), storageSizeBytes: BigInt(stSize), finishedAt: new Date(),
      },
    });
    await baseEvent(p, "backup", `Backup created (database ${(size / 1024).toFixed(1)} KB, schemas: ${schemas.join(", ")}; storage files ${(stSize / 1024).toFixed(1)} KB)`, {
      level: "success",
      actorId: b.createdById,
    });
    await applyBackupRetention(p.id);
    return abs;
  } catch (e) {
    fs.rmSync(abs, { force: true });
    fs.rmSync(absStorage, { force: true });
    await db.baseBackup.update({ where: { id: b.id }, data: { status: "FAILED", error: (e as Error).message.slice(0, 2000), finishedAt: new Date() } });
    await baseEvent(p, "backup", `Backup failed: ${(e as Error).message}`, { level: "error", actorId: b.createdById });
    throw e;
  }
}

export function backupAbsPath(b: { path: string | null }, ref: string): string | null {
  if (!b.path) return null;
  const abs = path.resolve(projectDir(ref), "..", "..", b.path);
  return abs.startsWith(backupsDir(ref) + path.sep) ? abs : null;
}

export async function applyBackupRetention(baseProjectId: string, keepOverride?: number) {
  const p = await db.baseProject.findUnique({ where: { id: baseProjectId } });
  if (!p) return;
  const { baseLimitsForTeam } = await import("./limits");
  const { readSettings } = await import("./settings");
  const limits = await baseLimitsForTeam(p.teamId, readSettings(p.settings).limits);
  const keep: Record<string, number> = { SCHEDULED: keepOverride ?? limits.backupsKept, MANUAL: 10, PRE_RESTORE: 2 };
  for (const [kind, n] of Object.entries(keep)) {
    const old = await db.baseBackup.findMany({ where: { baseProjectId, kind, status: { not: "RUNNING" } }, orderBy: { createdAt: "desc" }, skip: Math.max(0, n) });
    for (const b of old) {
      for (const f of [backupAbsPath(b, p.ref), backupAbsPath({ path: b.storagePath }, p.ref)]) if (f) fs.rmSync(f, { force: true });
      await db.baseBackup.delete({ where: { id: b.id } }).catch(() => {});
    }
  }
}

export async function restoreBackup(backupId: string, actorId?: string | null) {
  const b = await db.baseBackup.findUnique({ where: { id: backupId }, include: { baseProject: true } });
  if (!b || b.status !== "SUCCEEDED") throw new Error("backup not available");
  const p = b.baseProject;
  const abs = backupAbsPath(b, p.ref);
  if (!abs || !fs.existsSync(abs)) throw new Error("backup file is missing");
  // safety net first
  const pre = await db.baseBackup.create({ data: { baseProjectId: p.id, kind: "PRE_RESTORE", createdById: actorId ?? null } });
  await runBackup(pre.id);
  await setBaseStatus(p.ref, "RESTORING");
  await baseEvent(p, "restore", `Restoring backup from ${b.createdAt.toISOString()}`, { actorId });
  const api = ["auth", "rest", "storage", "realtime", "functions", "meta"];
  const stFile = backupAbsPath({ path: b.storagePath }, p.ref);
  try {
    // storage files first (needs the running storage container), then the database with the API services stopped
    if (stFile && fs.existsSync(stFile)) {
      const t = await execIn(p.ref, "storage", ["sh", "-c", "find /var/lib/storage -mindepth 1 -delete && tar xzf - -C /var/lib/storage"], { stdinFile: stFile });
      if (t.code !== 0) throw new Error(`storage files restore failed: ${t.err.trim().slice(-1000)}`);
    }
    await compose(p.ref, ["stop", ...api]);
    const r = await execIn(p.ref, "db", ["sh", "-c", "gunzip -c | psql -X -q -v ON_ERROR_STOP=0 -U supabase_admin -h localhost -d postgres"], { stdinFile: abs });
    const errors = (r.err.match(/ERROR:.*$/gm) ?? []).filter((l) => !/does not exist|already exists/.test(l));
    if (r.code !== 0) throw new Error(r.err.slice(-2000));
    await compose(p.ref, ["start", ...api]);
    await waitHealthy(p.ref, CORE_SERVICES);
    await psql(p.ref, "NOTIFY pgrst, 'reload schema';").catch(() => {});
    await probeGateway(p.ref); // the gateway's active health checks need a few seconds to see restarted upstreams
    await db.baseBackup.update({ where: { id: b.id }, data: { restoredAt: new Date() } });
    await setBaseStatus(p.ref, "ACTIVE");
    await baseEvent(p, "restore", `${errors.length ? `Backup restored with ${errors.length} warning(s)` : "Backup restored"}${stFile ? " (database + storage files)" : " (database only — no storage archive in this backup)"}`, {
      level: errors.length ? "warning" : "success",
      actorId,
      meta: { warnings: errors.slice(0, 20) },
    });
  } catch (e) {
    await compose(p.ref, ["start", ...api]).catch(() => {});
    await fail(p, "Restore", e, actorId);
    throw e;
  }
}

// ───────────────────────────── functions ─────────────────────────────

/** After function files changed on disk: re-render (per-function JWT flags) + restart the functions service. */
export async function reloadFunctions(ref: string, actorId?: string | null, note = "Functions deployed") {
  const p = await requireBase(ref);
  await render(p);
  if (p.status === "ACTIVE") {
    // functions.env may have changed → `up -d` recreates if needed, then restart to drop cached workers
    await compose(ref, ["up", "-d", "functions"], { profiles: await profilesFor(ref) });
    await compose(ref, ["restart", "functions"]);
    await waitHealthy(ref, ["functions"]);
    await probeGateway(ref); // Envoy must see the restarted runtime before we report success
  }
  await baseEvent(p, "functions", note, { level: "success", actorId });
}

export { serviceLogs, stackState };
