import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { BaseProject } from "@prisma/client";
import { db } from "@/lib/db";
import { queues } from "@/lib/queues";
import { execIn, serviceLogs, stackState } from "./compose";
import {
  apiHost, containerName, functionsDir, generateRef, internalUrl, isService, projectUrl as _projectUrl, studioHost, studioUrl as _studioUrl, ALL_SERVICES,
} from "./config";
import { baseEvent } from "./events";
import { env } from "@/lib/env";
import { markOwnershipFixed } from "./ownership";
import { baseLimitsForTeam } from "./limits";
import { assertCanAddFunction, assertCanCreateProject } from "@/lib/plans/enforce";
import { decryptSecrets, encryptSecrets, generateSecrets } from "./secrets";
import { applySettingsPatch, baseSettingsPatchSchema, DEFAULT_SETTINGS, publicSettings, readSettings, type BaseSettingsPatch } from "./settings";
import { DEFAULT_VERSIONS } from "./versions";

/**
 * LevantBase library contract (dashboard / API / AI agent / CLI). Long operations are enqueued on the `base` queue
 * (worker: src/worker/processors/base.ts) and reported through BaseProject.status + BaseEvent rows
 * (+ Redis pub/sub BASE_STATUS_CHANNEL). Throws `BaseError` with a `code` the API layer can map to HTTP statuses.
 */
export class BaseError extends Error {
  constructor(
    public code: "NOT_FOUND" | "CONFLICT" | "LIMIT" | "BAD_REQUEST" | "STATE",
    message: string,
  ) {
    super(message);
  }
}

export const projectUrl = (ref: string) => _projectUrl(ref);
export const studioUrl = (ref: string) => _studioUrl(ref);

export type BaseProjectDTO = Omit<BaseProject, "secretsEnc" | "settings"> & {
  url: string;
  internalUrl: string;
  studioUrl: string;
  apiHost: string;
  studioHost: string;
  settings: ReturnType<typeof publicSettings>;
};

export function toDTO(p: BaseProject): BaseProjectDTO {
  const { secretsEnc: _s, settings, ...rest } = p;
  return {
    ...rest,
    url: _projectUrl(p.ref),
    internalUrl: internalUrl(p.ref),
    studioUrl: _studioUrl(p.ref),
    apiHost: apiHost(p.ref),
    studioHost: studioHost(p.ref),
    settings: publicSettings(readSettings(settings)),
  };
}

/** Create the row (PROVISIONING) + enqueue provisioning. Hard cap via the plans area (active backends per team). */
export async function createBaseProject(input: {
  teamId: string;
  name: string;
  dbPassword?: string;
  createdById?: string | null;
  /** owning Deploy project (same team, at most one backend per project) */
  projectId?: string | null;
  settings?: BaseSettingsPatch;
}): Promise<BaseProject> {
  const name = input.name.trim();
  if (!name || name.length > 64) throw new BaseError("BAD_REQUEST", "Name must be 1–64 characters");
  // plan hard cap (throws PlanLimitError → HTTP 402 via route()) + email verification
  await assertCanCreateProject(input.teamId, "base", { userId: input.createdById ?? null });
  if (input.projectId) {
    const proj = await db.project.findUnique({ where: { id: input.projectId }, select: { teamId: true, baseProject: { select: { ref: true } } } });
    if (!proj || proj.teamId !== input.teamId) throw new BaseError("BAD_REQUEST", "Project not found in this team");
    if (proj.baseProject) throw new BaseError("CONFLICT", `This project already has a backend (${proj.baseProject.ref})`);
  }
  let ref = generateRef();
  while (await db.baseProject.findUnique({ where: { ref }, select: { id: true } })) ref = generateRef();
  let secrets;
  try {
    secrets = await generateSecrets(ref, { dbPassword: input.dbPassword });
  } catch (e) {
    throw new BaseError("BAD_REQUEST", (e as Error).message);
  }
  let settings = readSettings(DEFAULT_SETTINGS);
  if (input.settings) settings = applySettingsPatch(settings, baseSettingsPatchSchema.parse(input.settings)).settings;
  const row = await db.baseProject.create({
    data: {
      teamId: input.teamId,
      projectId: input.projectId ?? null,
      ref,
      name,
      status: "PROVISIONING",
      secretsEnc: encryptSecrets(secrets),
      versions: { ...DEFAULT_VERSIONS },
      // runSql creates objects as postgres → nothing for the one-time ownership fix to do
      settings: markOwnershipFixed(settings as Record<string, unknown>) as object,
      createdById: input.createdById ?? null,
      lastActivityAt: new Date(),
    },
  });
  await baseEvent(row, "provision", "Project created", { actorId: input.createdById });
  await queues.base.add({ action: "provision", ref, byUserId: input.createdById ?? null }, { jobId: `base-provision-${ref}-${Date.now()}` });
  return row;
}

export async function getBaseProject(ref: string): Promise<BaseProject | null> {
  return db.baseProject.findUnique({ where: { ref } });
}

export async function listBaseProjects(teamId: string): Promise<BaseProject[]> {
  return db.baseProject.findMany({ where: { teamId }, orderBy: { createdAt: "desc" } });
}

export async function baseProjectForDeployProject(projectId: string): Promise<BaseProject | null> {
  return db.baseProject.findUnique({ where: { projectId } });
}

async function must(ref: string) {
  const p = await getBaseProject(ref);
  if (!p) throw new BaseError("NOT_FOUND", "Base project not found");
  return p;
}

/**
 * API keys. `serviceRoleKey` bypasses RLS — only show it to ADMIN+ and audit the reveal.
 * url = public https URL (browsers, mobile apps); internalUrl = http://base-{ref}:8000 for server-side code running in
 * LevantDeploy app containers (same gateway, no TLS / public DNS round trip).
 */
export async function baseKeys(ref: string) {
  const p = await must(ref);
  const s = decryptSecrets(p.secretsEnc);
  return { url: _projectUrl(ref), internalUrl: internalUrl(ref), anonKey: s.anonKey, serviceRoleKey: s.serviceRoleKey, jwtSecret: s.jwtSecret };
}

/**
 * Env vars for a Deploy project connected to this backend (dashboard "Connect Base project").
 * Browser-exposed names get the public URL; SUPABASE_URL (server-side) gets the internal URL.
 */
export async function baseEnvVars(ref: string, opts: { includeServiceRole?: boolean } = {}) {
  const k = await baseKeys(ref);
  const vars: Record<string, string> = {
    SUPABASE_URL: k.internalUrl,
    SUPABASE_PUBLIC_URL: k.url,
    NEXT_PUBLIC_SUPABASE_URL: k.url,
    VITE_SUPABASE_URL: k.url,
    SUPABASE_ANON_KEY: k.anonKey,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: k.anonKey,
    VITE_SUPABASE_ANON_KEY: k.anonKey,
  };
  if (opts.includeServiceRole) vars.SUPABASE_SERVICE_ROLE_KEY = k.serviceRoleKey;
  return vars;
}

/**
 * Postgres connection info.
 *  - direct: only inside the stack (edge functions: SUPABASE_DB_URL) — the db is never on a shared network
 *  - pooler (when the plan includes it / public port on): LevantDeploy app containers on levant_net reach Supavisor
 *    through the gateway alias — session mode `base-{ref}:5432`, transaction mode `base-{ref}:6543`;
 *    user `postgres.{ref}` (Supavisor tenant = ref)
 *  - public: `{host}:{dbPublicPort}` (session mode, TLS required → `sslmode=require`; self-signed per project)
 */
export async function connectionStrings(ref: string, publicHost?: string) {
  const p = await must(ref);
  const s = decryptSecrets(p.secretsEnc);
  const pw = encodeURIComponent(s.postgresPassword);
  const limits = await baseLimitsForTeam(p.teamId, readSettings(p.settings).limits);
  const pooler = limits.pooler || (limits.publicDbPort && p.dbPublicPort != null);
  const ssl = p.dbPublicPort ? "?sslmode=require" : "";
  const host = publicHost || env.BASE_DB_HOST || apiHost(ref);
  const alias = `base-${ref}`;
  return {
    user: "postgres",
    poolerUser: `postgres.${ref}`,
    password: s.postgresPassword,
    database: "postgres",
    direct: `postgresql://postgres:${pw}@db:5432/postgres`,
    /** @deprecated same as `direct` */
    internal: `postgresql://postgres:${pw}@db:5432/postgres`,
    pooler: pooler
      ? {
          host: alias,
          session: `postgresql://postgres.${ref}:${pw}@${alias}:5432/postgres${ssl}`,
          transaction: `postgresql://postgres.${ref}:${pw}@${alias}:6543/postgres${ssl}`,
        }
      : null,
    public: p.dbPublicPort && limits.publicDbPort ? `postgresql://postgres.${ref}:${pw}@${host}:${p.dbPublicPort}/postgres?sslmode=require` : null,
    publicHost: p.dbPublicPort && limits.publicDbPort ? host : null,
    publicPort: p.dbPublicPort && limits.publicDbPort ? p.dbPublicPort : null,
    sslRequired: !!p.dbPublicPort,
  };
}

export type SqlRole = "postgres" | "service_role" | "authenticated" | "anon";

/**
 * Run SQL in the project's database (inside the db container, via psql logged in as `postgres` — like the hosted SQL
 * editor: objects belong to `postgres`, so apps and migration tools connecting as postgres can alter them later, and
 * `RESET ROLE` can't climb to the superuser).
 * role ≠ postgres → executed in a transaction with `SET LOCAL ROLE` (RLS applies). Result: rows of the LAST statement
 * as objects (values as strings/null), plus the psql notices.
 */
export async function runSql(ref: string, sql: string, opts: { role?: SqlRole; timeoutMs?: number; readOnly?: boolean; maxRows?: number } = {}) {
  const p = await must(ref);
  if (p.status !== "ACTIVE") throw new BaseError("STATE", `Project is ${p.status}`);
  const role = opts.role ?? "postgres";
  if (!["postgres", "service_role", "authenticated", "anon"].includes(role)) throw new BaseError("BAD_REQUEST", "invalid role");
  const marker = `__levant_${crypto.randomBytes(6).toString("hex")}`;
  // the user statement runs as-is; we capture the last result set as JSON via a temp view-less trick:
  // psql prints each result set; --csv with a marker line between statements lets us cut the last one.
  const pre = [
    "\\set ON_ERROR_STOP 1",
    `\\echo ${marker}BEGIN`,
    role !== "postgres" || opts.readOnly ? "BEGIN;" : "",
    opts.readOnly ? "SET TRANSACTION READ ONLY;" : "",
    role !== "postgres" ? `SET LOCAL ROLE ${role};` : "",
    `SET ${role !== "postgres" || opts.readOnly ? "LOCAL " : ""}statement_timeout = ${Math.min(opts.timeoutMs ?? 60_000, 600_000)};`,
    `\\echo ${marker}SQL`,
  ].filter(Boolean);
  const post = role !== "postgres" || opts.readOnly ? [`\\echo ${marker}END`, "COMMIT;"] : [`\\echo ${marker}END`];
  const script = [...pre, sql.trim().replace(/;?\s*$/, ";"), ...post].join("\n");
  const r = await execIn(ref, "db", ["psql", "-X", "-q", "--csv", "-U", "postgres", "-h", "localhost", "-d", "postgres", "-f", "-"], {
    stdin: script,
    timeoutMs: (opts.timeoutMs ?? 60_000) + 10_000,
  });
  if (r.code !== 0) throw new BaseError("BAD_REQUEST", (r.err.replace(/^psql:<stdin>:\d+: /gm, "").trim() || `psql exit ${r.code}`).slice(0, 4000));
  const out = r.out;
  const start = out.indexOf(`${marker}SQL\n`);
  const end = out.indexOf(`${marker}END`);
  const body = start >= 0 ? out.slice(start + marker.length + 4, end >= 0 ? end : undefined) : out;
  const res = parseLastCsv(body);
  const max = opts.maxRows ?? 1000;
  const truncated = res.rows.length > max;
  const rows = truncated ? res.rows.slice(0, max) : res.rows;
  return {
    columns: res.columns,
    fields: res.columns.map((name) => ({ name })),
    rows,
    rowCount: res.rows.length,
    truncated,
    notices: r.err.trim() ? r.err.trim().split("\n").slice(-20) : [],
  };
}

/** psql --csv output of possibly several result sets → the last one (header + rows). */
export function parseLastCsv(text: string): { columns: string[]; rows: Array<Record<string, string | null>> } {
  const records = parseCsv(text);
  if (!records.length) return { columns: [], rows: [] };
  // result sets are separated by a header row; we can only detect the last header heuristically: psql prints each
  // set as header + rows. Take the last record whose width differs, or the first if all match.
  let headerIdx = 0;
  for (let i = records.length - 1; i > 0; i--) {
    if (records[i]!.length !== records[i - 1]!.length) {
      headerIdx = i;
      break;
    }
  }
  const columns = records[headerIdx]!;
  const rows = records.slice(headerIdx + 1).map((rec) => Object.fromEntries(columns.map((c, i) => [c, rec[i] ?? null])));
  return { columns, rows };
}

export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  let any = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      q = true;
      any = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      any = true;
    } else if (ch === "\n") {
      if (any || field) {
        row.push(field);
        out.push(row);
      }
      row = [];
      field = "";
      any = false;
    } else if (ch !== "\r") {
      field += ch;
      any = true;
    }
  }
  if (any || field) {
    row.push(field);
    out.push(row);
  }
  return out;
}

export type StackActionName =
  | "pause" | "resume" | "restart" | "upgrade" | "delete" | "backup" | "restore" | "studio-start" | "studio-stop" | "settings" | "functions";

const ALLOWED_FROM: Record<StackActionName, BaseProject["status"][]> = {
  pause: ["ACTIVE", "ERROR"],
  resume: ["PAUSED", "ERROR"],
  restart: ["ACTIVE", "ERROR"],
  upgrade: ["ACTIVE", "ERROR"],
  delete: ["PROVISIONING", "ACTIVE", "PAUSING", "PAUSED", "RESTORING", "UPGRADING", "ERROR"],
  backup: ["ACTIVE"],
  restore: ["ACTIVE", "ERROR"],
  "studio-start": ["ACTIVE"],
  "studio-stop": ["ACTIVE", "PAUSED", "ERROR"],
  settings: ["ACTIVE", "PAUSED", "ERROR"],
  functions: ["ACTIVE", "PAUSED"],
};

/**
 * Enqueue a stack action. Options:
 *   restart { service? }, upgrade { versions? }, backup {}, restore { backupId }, delete { confirm: ref } (required)
 */
export async function stackAction(
  ref: string,
  action: StackActionName,
  opts: { byUserId?: string | null; service?: string; versions?: Record<string, string>; backupId?: string; confirm?: string } = {},
): Promise<{ jobId: string; backupId?: string }> {
  const p = await must(ref);
  if (!ALLOWED_FROM[action].includes(p.status)) throw new BaseError("STATE", `Cannot ${action} while the project is ${p.status}`);
  if (action === "delete" && opts.confirm !== ref) throw new BaseError("BAD_REQUEST", "Type the project ref to confirm deletion");
  // a paused backend becomes active again → counts against the plan's active backends (PlanLimitError → 402)
  if (action === "resume" && p.status === "PAUSED") await assertCanCreateProject(p.teamId, "base", { userId: opts.byUserId ?? null });
  if (action === "restart" && opts.service && !isService(opts.service)) throw new BaseError("BAD_REQUEST", `Unknown service (${ALL_SERVICES.join(", ")})`);
  let backupId = opts.backupId;
  if (action === "backup") {
    const b = await db.baseBackup.create({ data: { baseProjectId: p.id, kind: "MANUAL", createdById: opts.byUserId ?? null } });
    backupId = b.id;
  }
  if (action === "restore") {
    const b = backupId ? await db.baseBackup.findUnique({ where: { id: backupId } }) : null;
    if (!b || b.baseProjectId !== p.id || b.status !== "SUCCEEDED") throw new BaseError("BAD_REQUEST", "Backup not found");
  }
  if (action === "delete") await db.baseProject.update({ where: { id: p.id }, data: { status: "DELETING" } });
  const jobId = `base-${action}-${ref}-${Date.now()}`;
  await queues.base.add(
    { action, ref, service: opts.service, backupId, byUserId: opts.byUserId ?? null, options: opts.versions ? { versions: opts.versions } : undefined },
    { jobId },
  );
  return { jobId, backupId };
}

/** Validate + store settings, then enqueue "settings" (re-render; only changed services are recreated). */
export async function updateBaseSettings(ref: string, patch: unknown, byUserId?: string | null) {
  const p = await must(ref);
  const parsed = baseSettingsPatchSchema.parse(patch);
  let next;
  try {
    next = applySettingsPatch(readSettings(p.settings), parsed);
  } catch (e) {
    throw new BaseError("BAD_REQUEST", (e as Error).message);
  }
  await db.baseProject.update({ where: { id: p.id }, data: { settings: next.settings as object } });
  const job = next.changed.length ? await stackAction(ref, "settings", { byUserId }) : null;
  return { settings: publicSettings(next.settings), changed: next.changed, jobId: job?.jobId ?? null };
}

// ───────────────────────────── edge functions ─────────────────────────────

export const FUNCTION_SLUG_RE = /^[a-z][a-z0-9_-]{0,62}$/;
const RESERVED_FN = new Set(["main", "hello-world-internal", "_shared", "node_modules"]);

/**
 * Deploy (create or update) one function: writes volumes/functions/<slug>/index.ts (+ extra files) and enqueues a
 * functions reload (restart of the edge runtime). Hard cap: plans area `assertCanAddFunction` (functions per backend).
 */
export async function deployFunction(
  ref: string,
  input: { slug: string; name?: string; source: string; files?: Record<string, string>; verifyJwt?: boolean; byUserId?: string | null },
) {
  const p = await must(ref);
  if (!FUNCTION_SLUG_RE.test(input.slug) || RESERVED_FN.has(input.slug)) throw new BaseError("BAD_REQUEST", "Invalid function slug");
  if (Buffer.byteLength(input.source) > 2 * 1024 * 1024) throw new BaseError("BAD_REQUEST", "Function source is larger than 2 MB");
  const existing = await db.baseFunction.findUnique({ where: { baseProjectId_slug: { baseProjectId: p.id, slug: input.slug } } });
  if (!existing) await assertCanAddFunction(p.id); // PlanLimitError → 402
  try {
    writeFunctionDir(functionsDir(ref), input.slug, input.source, input.files);
  } catch (e) {
    throw new BaseError("BAD_REQUEST", (e as Error).message);
  }
  const sha = crypto.createHash("sha256").update(input.source).digest("hex");
  const fn = await db.baseFunction.upsert({
    where: { baseProjectId_slug: { baseProjectId: p.id, slug: input.slug } },
    create: {
      baseProjectId: p.id, slug: input.slug, name: input.name ?? input.slug, verifyJwt: input.verifyJwt ?? true,
      sourcePath: `volumes/functions/${input.slug}/index.ts`, sha256: sha, deployedAt: new Date(),
    },
    update: { name: input.name ?? existing?.name ?? input.slug, verifyJwt: input.verifyJwt ?? existing?.verifyJwt ?? true, version: { increment: 1 }, sha256: sha, deployedAt: new Date() },
  });
  const job = await stackAction(ref, "functions", { byUserId: input.byUserId });
  return { function: fn, jobId: job.jobId, url: `${_projectUrl(ref)}/functions/v1/${input.slug}` };
}

/**
 * Replace volumes/functions/<slug>/ atomically with exactly index.ts + `files` (a redeploy with fewer files leaves
 * nothing behind). Everything is written to a staging dir next to the functions volume (same filesystem, invisible to
 * the edge runtime), then swapped in with renames. Other dirs (incl. `_shared`, other functions) are never touched.
 */
export function writeFunctionDir(root: string, slug: string, source: string, files: Record<string, string> = {}) {
  if (!FUNCTION_SLUG_RE.test(slug) || RESERVED_FN.has(slug)) throw new Error("Invalid function slug");
  const staging = path.join(path.dirname(root), ".fn-staging", `${slug}-${crypto.randomBytes(6).toString("hex")}`);
  const entries = Object.entries(files);
  for (const [rel] of entries) {
    const abs = path.resolve(staging, rel);
    if (rel.includes("..") || path.isAbsolute(rel) || !abs.startsWith(staging + path.sep) || rel.includes("\0")) throw new Error(`Invalid file path ${rel}`);
  }
  fs.mkdirSync(staging, { recursive: true });
  try {
    for (const [rel, content] of entries) {
      const abs = path.resolve(staging, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    fs.writeFileSync(path.join(staging, "index.ts"), source); // index.ts always wins over a files entry
    fs.mkdirSync(root, { recursive: true });
    const dir = path.join(root, slug);
    const old = `${staging}.old`;
    if (fs.existsSync(dir)) fs.renameSync(dir, old);
    fs.renameSync(staging, dir);
    fs.rmSync(old, { recursive: true, force: true });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export async function deleteFunction(ref: string, slug: string, byUserId?: string | null) {
  const p = await must(ref);
  if (!FUNCTION_SLUG_RE.test(slug) || RESERVED_FN.has(slug)) throw new BaseError("BAD_REQUEST", "Invalid function slug");
  await db.baseFunction.deleteMany({ where: { baseProjectId: p.id, slug } });
  fs.rmSync(path.join(functionsDir(ref), slug), { recursive: true, force: true });
  return stackAction(ref, "functions", { byUserId });
}

export async function functionSource(ref: string, slug: string): Promise<string | null> {
  if (!FUNCTION_SLUG_RE.test(slug)) return null;
  try {
    return fs.readFileSync(path.join(functionsDir(ref), slug, "index.ts"), "utf8");
  } catch {
    return null;
  }
}

// ───────────────────────────── observability ─────────────────────────────

/** Live container state per service (dashboard "Services" card). */
export async function baseServices(ref: string) {
  await must(ref);
  return stackState(ref);
}

/** Last N log lines of one service (dashboard "Logs"). */
export async function baseLogs(ref: string, service: string, tail = 300) {
  await must(ref);
  if (!isService(service)) throw new BaseError("BAD_REQUEST", "Unknown service");
  return serviceLogs(ref, service, Math.min(Math.max(tail, 1), 5000));
}

export const baseContainerName = containerName;

/** alias (dashboard naming) */
export const serviceHealth = baseServices;

/**
 * Live log stream of one service as SSE in the LogViewer format (`id:` + `data: {"id","ts","line"}`, `event: end`,
 * `: ping` every 15 s). `follow: false` → the last `tail` lines then `end`.
 */
export async function baseLogStream(ref: string, service: string, opts: { signal?: AbortSignal; tail?: number; follow?: boolean; since?: number } = {}): Promise<Response> {
  await must(ref);
  if (!isService(service)) throw new BaseError("BAD_REQUEST", "Unknown service");
  const { docker } = await import("@/lib/docker");
  const { containerSuffix } = await import("./config");
  const c = docker().getContainer(containerName(ref, containerSuffix(service)));
  const follow = opts.follow !== false;
  const enc = new TextEncoder();
  let n = 0;
  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const send = (s: string) => {
        try {
          ctrl.enqueue(enc.encode(s));
        } catch {}
      };
      const end = () => {
        send("event: end\ndata: {}\n\n");
        try {
          ctrl.close();
        } catch {}
      };
      let partial = "";
      const onText = (t: string) => {
        partial += t;
        const lines = partial.split("\n");
        partial = lines.pop() ?? "";
        for (const raw of lines) {
          const sp = raw.indexOf(" ");
          const ts = sp > 0 ? Date.parse(raw.slice(0, sp)) : Date.now();
          const line = sp > 0 && !Number.isNaN(ts) ? raw.slice(sp + 1) : raw;
          n++;
          send(`id: ${n}\ndata: ${JSON.stringify({ id: String(n), ts: Number.isNaN(ts) ? Date.now() : ts, line: line.slice(0, 8192) })}\n\n`);
        }
      };
      try {
        const logOpts = { stdout: true, stderr: true, timestamps: true, tail: Math.min(opts.tail ?? 300, 5000), ...(opts.since ? { since: Math.floor(opts.since / 1000) } : {}) };
        if (!follow) {
          const buf = (await c.logs({ ...logOpts, follow: false })) as unknown as Buffer;
          const { demux } = await import("./compose");
          onText(demux(buf) + "\n");
          return end();
        }
        const st = (await c.logs({ ...logOpts, follow: true })) as unknown as NodeJS.ReadableStream & { destroy?: () => void };
        const { PassThrough } = await import("node:stream");
        const out = new PassThrough();
        out.on("data", (b: Buffer) => onText(b.toString("utf8")));
        docker().modem.demuxStream(st, out, out);
        const ping = setInterval(() => send(": ping\n\n"), 15_000);
        const stop = () => {
          clearInterval(ping);
          st.destroy?.();
          end();
        };
        st.on("end", stop);
        opts.signal?.addEventListener("abort", stop);
      } catch (e) {
        send(`data: ${JSON.stringify({ id: "0", ts: Date.now(), line: `(no logs: ${(e as Error).message})` })}\n\n`);
        end();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" } });
}

/** One-time Studio SSO URL (starts Studio if needed). Throws if the user isn't MEMBER+ of the team. */
export async function studioSsoUrl(ref: string, userId: string): Promise<string> {
  const { issueStudioToken } = await import("./studio");
  return (await issueStudioToken(ref, userId)).url;
}

/** Edge function secrets (env vars of every function). `null` deletes a key. */
export async function setFunctionSecrets(ref: string, vars: Record<string, string | null>, byUserId?: string | null) {
  return updateBaseSettings(ref, { functions: { secrets: vars } }, byUserId);
}
export async function listFunctionSecrets(ref: string): Promise<string[]> {
  const p = await must(ref);
  const { functionSecrets } = await import("./settings");
  return Object.keys(functionSecrets(readSettings(p.settings))).sort();
}

/**
 * Invoke a function through the project's gateway (same path as public traffic, anon key by default).
 * Needs network access to the gateway container (worker / control on levant_net, or a host-mode dev process).
 */
export async function invokeFunction(ref: string, slug: string, req: { method?: string; body?: string; headers?: Record<string, string>; key?: "anon" | "service_role" } = {}) {
  const p = await must(ref);
  if (!FUNCTION_SLUG_RE.test(slug)) throw new BaseError("BAD_REQUEST", "Invalid function slug");
  const { containerIp } = await import("./compose");
  const { gatewayContainer, publicNetwork } = await import("./config");
  const ip = await containerIp(gatewayContainer(ref), publicNetwork());
  if (!ip) throw new BaseError("STATE", "Gateway is not running");
  const s = decryptSecrets(p.secretsEnc);
  const key = req.key === "service_role" ? s.serviceRoleKey : s.anonKey;
  const t0 = Date.now();
  const r = await fetch(`http://${ip}:8000/functions/v1/${slug}`, {
    method: req.method ?? "POST",
    headers: { authorization: `Bearer ${key}`, apikey: key, "content-type": "application/json", ...(req.headers ?? {}) },
    body: req.method === "GET" || req.method === "HEAD" ? undefined : (req.body ?? "{}"),
    signal: AbortSignal.timeout(150_000),
  });
  const text = await r.text();
  return { status: r.status, headers: Object.fromEntries(r.headers.entries()), body: text.slice(0, 1_000_000), durationMs: Date.now() - t0 };
}

// ───────────────────────────── backups (dashboard helpers) ─────────────────────────────

export async function createBackup(ref: string, byUserId?: string | null) {
  return stackAction(ref, "backup", { byUserId });
}
export async function restoreBackup(ref: string, backupId: string, byUserId?: string | null) {
  return stackAction(ref, "restore", { backupId, byUserId });
}
export async function listBackups(ref: string) {
  const p = await must(ref);
  return db.baseBackup.findMany({ where: { baseProjectId: p.id }, orderBy: { createdAt: "desc" } });
}
/** Absolute path of a finished backup file (for download streams), or null. */
export async function backupFilePath(backup: { path: string | null; baseProjectId: string }): Promise<string | null> {
  const p = await db.baseProject.findUnique({ where: { id: backup.baseProjectId }, select: { ref: true } });
  if (!p) return null;
  const { backupAbsPath } = await import("./stack");
  const abs = backupAbsPath(backup, p.ref);
  return abs && fs.existsSync(abs) ? abs : null;
}
/** Absolute path of the storage-files archive (.storage.tar.gz) of a backup, or null. */
export async function backupStorageFilePath(backup: { storagePath: string | null; baseProjectId: string }): Promise<string | null> {
  const p = await db.baseProject.findUnique({ where: { id: backup.baseProjectId }, select: { ref: true } });
  if (!p) return null;
  const { backupAbsPath } = await import("./stack");
  const abs = backupAbsPath({ path: backup.storagePath }, p.ref);
  return abs && fs.existsSync(abs) ? abs : null;
}
export async function deleteBackup(ref: string, backupId: string) {
  const p = await must(ref);
  const b = await db.baseBackup.findUnique({ where: { id: backupId } });
  if (!b || b.baseProjectId !== p.id) throw new BaseError("NOT_FOUND", "Backup not found");
  if (b.status === "RUNNING") throw new BaseError("STATE", "Backup is still running");
  const abs = await backupFilePath(b);
  if (abs) fs.rmSync(abs, { force: true });
  const st = await backupStorageFilePath(b);
  if (st) fs.rmSync(st, { force: true });
  await db.baseBackup.delete({ where: { id: b.id } });
}

/**
 * Public database access (plan `publicDbPort`): allocates a host port from BASE_DB_PORT_RANGE (default 54000-54999),
 * publishes the gateway's pooler listener (session mode) there, starts Supavisor and requires TLS. `false` closes it.
 * Ops: open the range in the server firewall only if public DB access is wanted.
 */
export async function setPublicPort(ref: string, enabled: boolean, byUserId?: string | null): Promise<{ port: number | null; jobId: string }> {
  const p = await must(ref);
  if (enabled) {
    const { baseResourceLimits } = await import("@/lib/plans/enforce");
    const { PlanLimitError } = await import("@/lib/plans/errors");
    const b = await baseResourceLimits(p.teamId);
    if (!b.publicDbPort) {
      const t = await db.team.findUnique({ where: { id: p.teamId }, select: { slug: true } });
      throw new PlanLimitError("base.publicDbPort", 0, 0, b.plan, t?.slug ?? null);
    }
  }
  let port: number | null = null;
  if (enabled) {
    port = p.dbPublicPort ?? (await allocatePublicPort());
    if (port == null) throw new BaseError("CONFLICT", "No free public database port left in BASE_DB_PORT_RANGE");
  }
  await db.baseProject.update({ where: { id: p.id }, data: { dbPublicPort: port } });
  await baseEvent(p, "settings", enabled ? `Public database access enabled on port ${port}` : "Public database access disabled", { actorId: byUserId });
  const job = await stackAction(ref, "settings", { byUserId });
  return { port, jobId: job.jobId };
}

export function parsePortRange(r: string): [number, number] {
  const [a, b] = r.split("-").map(Number) as [number, number];
  if (!(a >= 1024 && b <= 65535 && a <= b)) throw new Error(`invalid BASE_DB_PORT_RANGE ${r}`);
  return [a, b];
}

async function allocatePublicPort(): Promise<number | null> {
  const [from, to] = parsePortRange(env.BASE_DB_PORT_RANGE);
  const used = new Set((await db.baseProject.findMany({ where: { dbPublicPort: { not: null } }, select: { dbPublicPort: true } })).map((x) => x.dbPublicPort!));
  for (let port = from; port <= to; port++) if (!used.has(port)) return port;
  return null;
}
