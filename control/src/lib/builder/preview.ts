import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { PassThrough } from "node:stream";
import type Docker from "dockerode";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { docker, dockerNetwork, ensureNetwork, LABELS } from "@/lib/docker";
import { queues } from "@/lib/queues";
import { hmacSha256, randomToken, sha256, timingSafeEqual } from "@/lib/crypto";
import { hasRole } from "@/lib/auth/roles";
import { platformDomain } from "@/lib/domains/platform";
import { getSetting } from "@/lib/settings";
import { runtimeImage } from "./template";
import { hostRepoDir, hostWorkspaceDir, previewGid, previewUid, repoDir, workspaceDir, workspaceExists } from "./workspace";
import { commitAll, type CommitAuthor } from "./git";
import { meterPreviewMinute, previewQuotaError } from "./usage";

/**
 * Live preview (builder-core): one container per builder project.
 *   name lvb_{id}, alias lvb-{id} on levant_net, image levant/builder-runtime:next15 (BUILDER_RUNTIME_IMAGE),
 *   repo bind-mounted at /app, `next dev -p 3000` (webpack → data-lv-src attributes), NEXT_PUBLIC_LEVANT_EDITOR=1,
 *   uid 1000, memory/cpu limits, egress proxy (BUILDER_EGRESS_PROXY → BASE_EGRESS_PROXY → build.proxy) for `pnpm add`.
 *   Routed by Caddy at preview-{id}.{PLATFORM_DOMAIN} behind a forward-auth gate (team MEMBER+ via a one-time SSO
 *   token → signed cookie, or a share link), HMR websockets pass through. Stopped after BUILDER_PREVIEW_IDLE_MIN (20)
 *   minutes without requests; any gated request (or the editor) starts it again.
 * Logs and errors live in Redis ring buffers (dev-server output + browser errors forwarded by the bridge).
 * Lifecycle actions run on the worker (queue "builder-preview"); `requestPreview()` enqueues them.
 * Worker-safe (no next/* imports).
 */

export type PreviewStatus = "STOPPED" | "STARTING" | "RUNNING" | "ERROR";

export const PREVIEW_PORT = 3000;
export const idleMs = () => Math.max(1, Number(process.env.BUILDER_PREVIEW_IDLE_MIN || 20)) * 60_000;
export const containerName = (id: string) => `lvb_${id}`;
export const previewAlias = (id: string) => `lvb-${id}`;
export const previewDial = (id: string) => `${previewAlias(id)}:${PREVIEW_PORT}`;
export const previewHost = (id: string) => `preview-${id}.${platformDomain()}`;
export const previewScheme = () => (process.env.PLATFORM_SCHEME || (process.env.NODE_ENV === "production" ? "https" : "http")) as "http" | "https";
export const previewBaseUrl = (id: string) => `${previewScheme()}://${previewHost(id)}`;

export { builderIdFromHost } from "./host";

/**
 * Identity of this LevantDeploy installation (several control planes may share one Docker daemon — e.g. staging):
 * orphan cleanup only touches containers carrying our own instance label.
 */
export const instanceLabel = () => sha256(`${process.env.DATABASE_URL ?? ""}|${process.env.STORAGE_DIR ?? ""}`).slice(0, 16);

const K = {
  logs: (id: string) => `lb:builder:${id}:logs`,
  errors: (id: string) => `lb:builder:${id}:errors`,
  lastOk: (id: string) => `lb:builder:${id}:lastok`,
  active: (id: string) => `lb:builder:${id}:active`,
  sso: (t: string) => `lb:builder:sso:${sha256(t)}`,
};
const LOG_RING = 2000;
const ERROR_RING = 200;

// ───────────────────────────── state ─────────────────────────────

async function setStatus(id: string, status: PreviewStatus, extra: { error?: string | null; startedAt?: Date | null } = {}) {
  await db.builderProject
    .update({
      where: { id },
      data: {
        previewStatus: status,
        ...(extra.error !== undefined ? { previewError: extra.error } : {}),
        ...(extra.startedAt !== undefined ? { previewStartedAt: extra.startedAt } : {}),
        ...(status === "RUNNING" || status === "STARTING" ? { previewLastActiveAt: new Date() } : {}),
      },
    })
    .catch(() => {});
}

async function inspect(id: string): Promise<Docker.ContainerInspectInfo | null> {
  try {
    return await docker().getContainer(containerName(id)).inspect();
  } catch {
    return null;
  }
}

function containerIp(info: Docker.ContainerInspectInfo): string | null {
  const nets = info.NetworkSettings?.Networks ?? {};
  return nets[dockerNetwork()]?.IPAddress || Object.values(nets)[0]?.IPAddress || null;
}

export type PreviewState = {
  status: PreviewStatus;
  host: string;
  /** plain preview URL (gate asks for login when opened without the SSO cookie) */
  publicUrl: string;
  error: string | null;
  startedAt: string | null;
  lastActiveAt: string | null;
  container: { exists: boolean; running: boolean; id: string | null } | null;
};

/** DB status reconciled with Docker (RUNNING without a running container → STOPPED). */
export async function previewState(id: string): Promise<PreviewState> {
  const p = await db.builderProject.findUnique({ where: { id }, select: { previewStatus: true, previewError: true, previewStartedAt: true, previewLastActiveAt: true } });
  if (!p) throw new Error("Builder project not found");
  const info = await inspect(id);
  let status = p.previewStatus as PreviewStatus;
  const running = !!info?.State?.Running;
  if (status === "RUNNING" && !running) {
    status = "STOPPED";
    await setStatus(id, "STOPPED");
  }
  const active = Number(await redis().get(K.active(id)).catch(() => null)) || 0;
  const last = Math.max(active, p.previewLastActiveAt?.getTime() ?? 0);
  return {
    status,
    host: previewHost(id),
    publicUrl: previewBaseUrl(id),
    error: p.previewError,
    startedAt: p.previewStartedAt?.toISOString() ?? null,
    lastActiveAt: last ? new Date(last).toISOString() : null,
    container: info ? { exists: true, running, id: info.Id.slice(0, 12) } : { exists: false, running: false, id: null },
  };
}

export async function isPreviewRunning(id: string): Promise<boolean> {
  return !!(await inspect(id))?.State?.Running;
}

// ───────────────────────────── enqueue (API side) ─────────────────────────────

/** Enqueue a lifecycle action on the worker (deduped per project+action). STARTING is set immediately for start/restart. */
export async function requestPreview(id: string, action: "start" | "stop" | "restart", opts: { byUserId?: string | null; reason?: string } = {}) {
  const jobId = `bp-${action}-${id}`;
  const existing = await queues["builder-preview"].raw.getJob(jobId);
  if (existing) {
    const st = await existing.getState();
    if (st === "waiting" || st === "active" || st === "delayed") return { queued: false, jobId };
    await existing.remove().catch(() => {});
  }
  if (action !== "stop") {
    const p = await db.builderProject.findUnique({ where: { id }, select: { teamId: true } });
    const quota = p ? await previewQuotaError(p.teamId) : null;
    if (quota) {
      await setStatus(id, "ERROR", { error: quota });
      return { queued: false, jobId, error: quota };
    }
    await setStatus(id, "STARTING", { error: null });
  }
  await queues["builder-preview"].add({ action, builderId: id, byUserId: opts.byUserId ?? null, reason: opts.reason }, { jobId });
  return { queued: true, jobId };
}

/** Record activity (gate requests, editor polls). Throttled; starts the preview when it isn't running. */
const lastTouch = new Map<string, number>();
export async function touchPreview(id: string, opts: { ensureRunning?: boolean } = {}) {
  const now = Date.now();
  if (now - (lastTouch.get(id) ?? 0) < 15_000) return;
  if (lastTouch.size > 5000) lastTouch.clear();
  lastTouch.set(id, now);
  await redis().set(K.active(id), String(now), "EX", 7 * 86400).catch(() => {});
  if (opts.ensureRunning && !(await isPreviewRunning(id))) await requestPreview(id, "start", { reason: "request" }).catch(() => {});
}

// ───────────────────────────── container lifecycle (worker) ─────────────────────────────

async function egressEnv(id: string): Promise<{ env: string[]; binds: string[] }> {
  const env: string[] = [];
  const binds: string[] = [];
  let proxy = process.env.BUILDER_EGRESS_PROXY || process.env.BASE_EGRESS_PROXY || "";
  let noProxy = process.env.BUILDER_EGRESS_NO_PROXY || "";
  let caPem: string | null = null;
  const caFile = process.env.BUILDER_EGRESS_CA_FILE || process.env.BASE_EGRESS_CA_FILE;
  if (caFile) caPem = await fs.readFile(caFile, "utf8").catch(() => null);
  if (!proxy) {
    const bp = await getSetting("build.proxy").catch(() => ({}) as Record<string, string | undefined>);
    const p = (bp as { httpsProxy?: string; httpProxy?: string }).httpsProxy || (bp as { httpProxy?: string }).httpProxy || "";
    // a proxy on the build host's loopback is unreachable from a bridge network container
    if (p && !/\/\/(127\.|localhost|\[::1\])/.test(p)) {
      proxy = p;
      noProxy ||= (bp as { noProxy?: string }).noProxy ?? "";
      caPem ??= (bp as { caCertPem?: string }).caCertPem ?? null;
    }
  }
  if (proxy) {
    const np = ["localhost", "127.0.0.1", "::1", ".local", previewHost(id), noProxy].filter(Boolean).join(",");
    env.push(`HTTPS_PROXY=${proxy}`, `HTTP_PROXY=${proxy}`, `https_proxy=${proxy}`, `http_proxy=${proxy}`, `NO_PROXY=${np}`, `no_proxy=${np}`);
  }
  if (caPem) {
    const f = path.join(workspaceDir(id), "ca.pem");
    await fs.writeFile(f, caPem, { mode: 0o644 });
    binds.push(`${path.join(hostWorkspaceDir(id), "ca.pem")}:/opt/levant/ca.pem:ro`);
    env.push("NODE_EXTRA_CA_CERTS=/opt/levant/ca.pem", "npm_config_cafile=/opt/levant/ca.pem");
  }
  return { env, binds };
}

async function createContainer(id: string, teamId: string): Promise<Docker.Container> {
  const d = docker();
  await ensureNetwork();
  const { env, binds } = await egressEnv(id);
  const memMb = Number(process.env.BUILDER_PREVIEW_MEMORY_MB || 2048);
  const cpus = Number(process.env.BUILDER_PREVIEW_CPUS || 2);
  return d.createContainer({
    name: containerName(id),
    Image: runtimeImage(),
    User: `${previewUid()}:${previewGid()}`,
    WorkingDir: "/app",
    Env: [
      "NODE_ENV=development",
      "NEXT_PUBLIC_LEVANT_EDITOR=1",
      `LEVANT_PREVIEW_HOST=${previewHost(id)}`,
      `LEVANT_BUILDER_ID=${id}`,
      "NEXT_TELEMETRY_DISABLED=1",
      "PORT=3000",
      "HOSTNAME=0.0.0.0",
      `NODE_OPTIONS=--max-old-space-size=${Math.max(512, Math.floor(memMb * 0.75))}`,
      "WATCHPACK_POLLING=false",
      ...env,
    ],
    ExposedPorts: { "3000/tcp": {} },
    Labels: { [LABELS.managed]: "true", [LABELS.kind]: "builder", "levant.role": "preview", [LABELS.team]: teamId, "levant.builder": id, "levant.instance": instanceLabel() },
    HostConfig: {
      Binds: [`${hostRepoDir(id)}:/app`, ...binds],
      NetworkMode: dockerNetwork(),
      Memory: memMb * 1024 * 1024,
      NanoCpus: Math.round(cpus * 1e9),
      PidsLimit: 1024,
      RestartPolicy: { Name: "no" },
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      LogConfig: { Type: "json-file", Config: { "max-size": "5m", "max-file": "2" } },
      Tmpfs: { "/tmp": "rw,exec,size=1024m" },
    },
    NetworkingConfig: { EndpointsConfig: { [dockerNetwork()]: { Aliases: [previewAlias(id)] } } },
  });
}

async function imageExists(): Promise<boolean> {
  try {
    await docker().getImage(runtimeImage()).inspect();
    return true;
  } catch {
    return false;
  }
}

function httpProbe(host: string, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const req = http.get({ host, port: PREVIEW_PORT, path: "/", timeout: timeoutMs, headers: { host: "localhost" } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}

/** Create/start the container and wait until `next dev` answers (first compile of "/"). Worker. */
export async function startPreviewNow(id: string, opts: { timeoutMs?: number } = {}): Promise<PreviewState> {
  const p = await db.builderProject.findUnique({ where: { id }, select: { id: true, teamId: true } });
  if (!p) throw new Error("Builder project not found");
  if (!(await workspaceExists(id))) {
    await setStatus(id, "ERROR", { error: "The app's workspace is missing" });
    throw new Error("workspace missing");
  }
  if (!(await imageExists())) {
    const msg = `Preview runtime image ${runtimeImage()} is not installed on this server (build it with builder-template/runtime/build.sh)`;
    await setStatus(id, "ERROR", { error: msg });
    throw new Error(msg);
  }
  await setStatus(id, "STARTING", { error: null });
  let info = await inspect(id);
  const imageId = (await docker().getImage(runtimeImage()).inspect().catch(() => null))?.Id;
  if (info && imageId && info.Image !== imageId) {
    // runtime image changed → recreate
    await docker().getContainer(containerName(id)).remove({ force: true }).catch(() => {});
    info = null;
  }
  const c = info ? docker().getContainer(containerName(id)) : await createContainer(id, p.teamId);
  if (!info?.State?.Running) await c.start().catch((e: Error) => {
    if (!/already started/i.test(e.message)) throw e;
  });
  await appendPreviewLog(id, `▲ levant: preview container ${info ? "started" : "created"}`);
  void followPreviewLogs(id);
  info = await inspect(id);
  const ip = info ? containerIp(info) : null;
  const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
  while (Date.now() < deadline) {
    const now = await inspect(id);
    if (!now?.State?.Running) {
      const logs = await containerTail(id, 30);
      const msg = `The preview stopped while starting (exit ${now?.State?.ExitCode ?? "?"}): ${logs.slice(-600)}`;
      await setStatus(id, "ERROR", { error: msg });
      throw new Error(msg);
    }
    if (ip && (await httpProbe(ip, 60_000)) !== null) {
      await setStatus(id, "RUNNING", { error: null, startedAt: new Date() });
      await redis().set(K.active(id), String(Date.now()), "EX", 7 * 86400).catch(() => {});
      return previewState(id);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  await setStatus(id, "ERROR", { error: "The preview did not answer within 3 minutes" });
  throw new Error("preview start timeout");
}

export async function stopPreviewNow(id: string, reason = "stopped") {
  stopFollowing(id);
  const c = docker().getContainer(containerName(id));
  await c.stop({ t: 5 }).catch(() => {});
  await setStatus(id, "STOPPED", { error: null });
  await appendPreviewLog(id, `▲ levant: preview ${reason}`);
}

export async function restartPreviewNow(id: string) {
  await stopPreviewNow(id, "restarting");
  return startPreviewNow(id);
}

/** Remove the container + Redis state (builder project deleted / runtime image upgrade). */
export async function deletePreview(id: string) {
  stopFollowing(id);
  await docker().getContainer(containerName(id)).remove({ force: true }).catch(() => {});
  await redis().del(K.logs(id), K.errors(id), K.lastOk(id), K.active(id)).catch(() => {});
}

/** Stop previews idle for longer than BUILDER_PREVIEW_IDLE_MIN (worker schedule, every minute). */
export async function stopIdlePreviews(now = Date.now()): Promise<string[]> {
  const rows = await db.builderProject.findMany({ where: { previewStatus: { in: ["RUNNING", "STARTING"] } }, select: { id: true, teamId: true, previewLastActiveAt: true, previewStartedAt: true } });
  const stopped: string[] = [];
  // metering: one minute of preview time per running preview (plans: builder.previewHoursMonth)
  const running = new Map<string, number>();
  for (const r of rows) if (await isPreviewRunning(r.id)) running.set(r.teamId, (running.get(r.teamId) ?? 0) + 1);
  await meterPreviewMinute(running, new Date(now)).catch((e) => console.warn("[builder] preview metering:", (e as Error).message));
  for (const r of rows) {
    const active = Number(await redis().get(K.active(r.id)).catch(() => null)) || 0;
    const last = Math.max(active, r.previewLastActiveAt?.getTime() ?? 0, r.previewStartedAt?.getTime() ?? 0);
    if (now - last < idleMs()) continue;
    await stopPreviewNow(r.id, `stopped after ${Math.round(idleMs() / 60_000)} idle minutes`);
    stopped.push(r.id);
  }
  // containers whose project is gone
  const list = await docker()
    .listContainers({ all: true, filters: { label: [`${LABELS.kind}=builder`, "levant.role=preview", `levant.instance=${instanceLabel()}`] } })
    .catch(() => []);
  // containers whose project is gone, and containers stopped for longer than BUILDER_PREVIEW_REMOVE_AFTER_H (24 h):
  // removing them frees their writable layer (installed extra deps); the next start recreates them in seconds
  const removeAfterMs = Math.max(1, Number(process.env.BUILDER_PREVIEW_REMOVE_AFTER_H || 24)) * 3600_000;
  for (const c of list) {
    const bid = c.Labels?.["levant.builder"];
    if (!bid) continue;
    if (!(await db.builderProject.findUnique({ where: { id: bid }, select: { id: true } }))) {
      await deletePreview(bid);
      continue;
    }
    if (c.State !== "running") {
      const info = await docker()
        .getContainer(c.Id)
        .inspect()
        .catch(() => null);
      const finished = info?.State?.FinishedAt ? Date.parse(info.State.FinishedAt) : 0;
      if (finished > 0 && now - finished > removeAfterMs) await docker().getContainer(c.Id).remove({ force: true }).catch(() => {});
    }
  }
  return stopped;
}

// ───────────────────────────── logs + errors ─────────────────────────────

export type PreviewError = { id: string; at: string; source: string; message: string; stack?: string; route?: string; file?: string };

export async function appendPreviewLog(id: string, ...lines: string[]) {
  if (!lines.length) return;
  const r = redis();
  const stamped = lines.map((l) => JSON.stringify({ ts: Date.now(), line: l.slice(0, 4000) }));
  await r.rpush(K.logs(id), ...stamped).catch(() => {});
  await r.ltrim(K.logs(id), -LOG_RING, -1).catch(() => {});
  await r.expire(K.logs(id), 7 * 86400).catch(() => {});
}

export async function recordPreviewError(id: string, e: { source: string; message: string; stack?: string; route?: string; file?: string }) {
  const item: PreviewError = {
    id: randomToken(6),
    at: new Date().toISOString(),
    source: e.source.slice(0, 40),
    message: e.message.slice(0, 4000),
    ...(e.stack ? { stack: e.stack.slice(0, 8000) } : {}),
    ...(e.route ? { route: e.route.slice(0, 300) } : {}),
    ...(e.file ? { file: e.file.slice(0, 300) } : {}),
  };
  const r = redis();
  await r.rpush(K.errors(id), JSON.stringify(item)).catch(() => {});
  await r.ltrim(K.errors(id), -ERROR_RING, -1).catch(() => {});
  await r.expire(K.errors(id), 7 * 86400).catch(() => {});
  return item;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const ERROR_START = /(⨯|Failed to compile|Module not found|Type error:|SyntaxError|ReferenceError|TypeError:|Error:|Unhandled Runtime Error|Build Error|Syntax Error)/;
const LOCATION_ONLY = /^\s*(⨯\s*)?\.?\/?[\w./[\]()@-]+\.(tsx?|jsx?|css|mjs):\d+:\d+\s*$/;
const OK_LINE = /(✓ Compiled|✓ Ready in|GET \/\S* 200 in)/;

/** Dev-server output → error records (compile errors are cleared by the next successful compile). */
export function parseDevLines(lines: string[]): { errors: Array<{ message: string; file?: string }>; ok: boolean } {
  const errors: Array<{ message: string; file?: string }> = [];
  let ok = false;
  let cur: string[] | null = null;
  const flush = () => {
    if (cur?.length) {
      const message = cur.join("\n").trim();
      const file = /(?:\.\/)?((?:app|components|lib|hooks|src)\/[\w./[\]()@-]+\.(?:tsx?|jsx?|css))(?::(\d+):(\d+))?/.exec(message);
      errors.push({ message: message.slice(0, 4000), file: file ? `${file[1]}${file[2] ? `:${file[2]}:${file[3]}` : ""}` : undefined });
    }
    cur = null;
  };
  for (const raw of lines) {
    const l = raw.replace(ANSI, "").replace(/\r/g, "");
    if (OK_LINE.test(l)) {
      flush();
      ok = true;
      continue;
    }
    if (ERROR_START.test(l) && !/^\s*at /.test(l) && !/warn/i.test(l.slice(0, 12))) {
      // "⨯ ./app/page.tsx:12:5" is a header; the message follows on the next line(s)
      if (cur && cur.length === 1 && LOCATION_ONLY.test(cur[0]!)) cur.push(l);
      else {
        flush();
        cur = [l];
      }
      continue;
    }
    if (cur) {
      if (!l.trim() || cur.length > 40) flush();
      else cur.push(l);
    }
  }
  flush();
  return { errors, ok };
}

const followers = new Map<string, { stream: NodeJS.ReadableStream }>();

function stopFollowing(id: string) {
  const f = followers.get(id);
  if (!f) return;
  followers.delete(id);
  try {
    (f.stream as unknown as { destroy?: () => void }).destroy?.();
  } catch {
    /* ignore */
  }
}

/** Follow the container's stdout/stderr into Redis (worker; one follower per project). */
export async function followPreviewLogs(id: string) {
  if (followers.has(id)) return;
  const c = docker().getContainer(containerName(id));
  let stream: NodeJS.ReadableStream;
  try {
    stream = (await c.logs({ follow: true, stdout: true, stderr: true, since: Math.floor(Date.now() / 1000) - 2 })) as unknown as NodeJS.ReadableStream;
  } catch {
    return;
  }
  followers.set(id, { stream });
  const out = new PassThrough();
  docker().modem.demuxStream(stream, out, out);
  let buf = "";
  let pending: string[] = [];
  let timer: NodeJS.Timeout | null = null;
  const flush = async () => {
    timer = null;
    const lines = pending;
    pending = [];
    if (!lines.length) return;
    await appendPreviewLog(id, ...lines.map((l) => l.replace(ANSI, "")));
    const parsed = parseDevLines(lines);
    if (parsed.ok) await redis().set(K.lastOk(id), String(Date.now()), "EX", 7 * 86400).catch(() => {});
    for (const e of parsed.errors) await recordPreviewError(id, { source: "server", message: e.message, file: e.file });
  };
  out.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    pending.push(...parts.filter((l) => l.length));
    timer ??= setTimeout(() => void flush(), 300);
  });
  const end = () => {
    if (buf) pending.push(buf);
    void flush();
    followers.delete(id);
  };
  stream.on("end", end);
  stream.on("error", end);
}

async function containerTail(id: string, tail: number): Promise<string> {
  try {
    const raw = (await docker().getContainer(containerName(id)).logs({ stdout: true, stderr: true, tail, follow: false })) as unknown as Buffer;
    return demuxBuffer(raw).replace(ANSI, "");
  } catch {
    return "";
  }
}

/** Docker multiplexed log buffer → text. */
export function demuxBuffer(buf: Buffer): string {
  let out = "";
  let i = 0;
  if (buf.length >= 8 && (buf[0] === 1 || buf[0] === 2) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0) {
    while (i + 8 <= buf.length) {
      const len = buf.readUInt32BE(i + 4);
      out += buf.subarray(i + 8, i + 8 + len).toString("utf8");
      i += 8 + len;
    }
    return out;
  }
  return buf.toString("utf8");
}

/** Recent dev-server output (newest last). Falls back to `docker logs` when the ring buffer is empty. */
export async function getPreviewLogs(id: string, opts: { tail?: number } = {}): Promise<Array<{ ts: number; line: string }>> {
  const tail = Math.min(Math.max(opts.tail ?? 300, 1), LOG_RING);
  const rows = await redis().lrange(K.logs(id), -tail, -1).catch(() => [] as string[]);
  if (rows.length) return rows.map((r) => JSON.parse(r) as { ts: number; line: string });
  const txt = await containerTail(id, tail);
  return txt
    .split("\n")
    .filter(Boolean)
    .map((line) => ({ ts: 0, line }));
}

/**
 * Current preview errors (newest first): server (compile) errors since the last successful compile + browser errors
 * forwarded by the bridge in the last `windowMs` (default 15 min, and after the last successful compile).
 */
export async function getPreviewErrors(id: string, opts: { windowMs?: number; limit?: number } = {}): Promise<PreviewError[]> {
  const rows = await redis().lrange(K.errors(id), 0, -1).catch(() => [] as string[]);
  const lastOk = Number(await redis().get(K.lastOk(id)).catch(() => null)) || 0;
  const since = Date.now() - (opts.windowMs ?? 15 * 60_000);
  const items = rows.map((r) => JSON.parse(r) as PreviewError);
  const out = items.filter((e) => {
    const t = Date.parse(e.at);
    return e.source === "server" ? t >= lastOk - 1000 : t >= since && t >= lastOk - 120_000;
  });
  // de-duplicate identical messages, newest first
  const seen = new Set<string>();
  const res: PreviewError[] = [];
  for (const e of out.reverse()) {
    const key = `${e.source}:${e.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    res.push(e);
    if (res.length >= (opts.limit ?? 50)) break;
  }
  return res;
}

/** Plain strings for the agents ("[server] app/page.tsx:3:1 Module not found …"). */
export async function getPreviewErrorMessages(id: string): Promise<string[]> {
  return (await getPreviewErrors(id)).map((e) => `[${e.source}]${e.route ? ` ${e.route}` : ""}${e.file ? ` ${e.file}` : ""} ${e.message}`.slice(0, 4000));
}

export async function clearPreviewErrors(id: string) {
  await redis().del(K.errors(id)).catch(() => {});
}

// ───────────────────────────── exec: checks + dependencies ─────────────────────────────

export type ExecResult = { exitCode: number; output: string; durationMs: number; timedOut: boolean; mode: "exec" | "oneoff" };

/**
 * Run a command in the project's runtime: inside the running preview container (docker exec) or, when it is not
 * running, in a one-off container with the same mounts (entrypoint links node_modules first).
 */
export async function execInPreview(id: string, cmd: string[], opts: { env?: string[]; timeoutMs?: number; maxOutput?: number; oneOff?: boolean } = {}): Promise<ExecResult> {
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const maxOut = opts.maxOutput ?? 400_000;
  const info = await inspect(id);
  const d = docker();
  if (info?.State?.Running && !opts.oneOff) {
    const ex = await d.getContainer(containerName(id)).exec({
      Cmd: ["/opt/levant/bin/levant-entrypoint", ...cmd],
      Env: opts.env,
      WorkingDir: "/app",
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await ex.start({ hijack: true, stdin: false });
    const out = new PassThrough();
    d.modem.demuxStream(stream, out, out);
    let text = "";
    out.on("data", (c: Buffer) => {
      if (text.length < maxOut) text += c.toString("utf8");
    });
    const timedOut = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(true), timeoutMs);
      stream.on("end", () => {
        clearTimeout(timer);
        resolve(false);
      });
      stream.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    if (timedOut) (stream as unknown as { destroy?: () => void }).destroy?.();
    const r = await ex.inspect().catch(() => null);
    return { exitCode: timedOut ? 124 : (r?.ExitCode ?? 1), output: text.replace(ANSI, ""), durationMs: Date.now() - t0, timedOut, mode: "exec" };
  }
  // one-off container
  const p = await db.builderProject.findUnique({ where: { id }, select: { teamId: true } });
  const { env, binds } = await egressEnv(id);
  await ensureNetwork();
  const name = `lvb_${id}_task_${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
  const c = await d.createContainer({
    name,
    Image: runtimeImage(),
    User: `${previewUid()}:${previewGid()}`,
    WorkingDir: "/app",
    Cmd: cmd,
    Env: ["NEXT_TELEMETRY_DISABLED=1", "NODE_OPTIONS=--max-old-space-size=1536", ...env, ...(opts.env ?? [])],
    Labels: { [LABELS.managed]: "true", [LABELS.kind]: "builder", "levant.role": "task", [LABELS.team]: p?.teamId ?? "", "levant.builder": id, "levant.instance": instanceLabel() },
    HostConfig: {
      Binds: [`${hostRepoDir(id)}:/app`, ...binds],
      NetworkMode: dockerNetwork(),
      Memory: Number(process.env.BUILDER_PREVIEW_MEMORY_MB || 2048) * 1024 * 1024,
      NanoCpus: Math.round(Number(process.env.BUILDER_PREVIEW_CPUS || 2) * 1e9),
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      Tmpfs: { "/tmp": "rw,exec,size=1024m" },
    },
  });
  try {
    await c.start();
    const waited = await Promise.race([c.wait() as Promise<{ StatusCode: number }>, new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
    if (!waited) await c.kill().catch(() => {});
    const raw = (await c.logs({ stdout: true, stderr: true, follow: false })) as unknown as Buffer;
    const output = demuxBuffer(raw).replace(ANSI, "").slice(-maxOut);
    return { exitCode: waited ? waited.StatusCode : 124, output, durationMs: Date.now() - t0, timedOut: !waited, mode: "oneoff" };
  } finally {
    await c.remove({ force: true }).catch(() => {});
  }
}

export type CheckKind = "typecheck" | "lint" | "build";
export type Diagnostic = { file: string | null; line: number | null; col: number | null; severity: "error" | "warning"; code: string | null; message: string; source: CheckKind };
export type CheckResult = { kind: CheckKind; ok: boolean; durationMs: number; summary: string; diagnostics: Diagnostic[]; output: string; mode: ExecResult["mode"] };

export function parseTsc(output: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const l of output.split("\n")) {
    const m = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/.exec(l.trim());
    if (m) out.push({ file: m[1]!, line: Number(m[2]), col: Number(m[3]), severity: m[4] as "error" | "warning", code: m[5]!, message: m[6]!, source: "typecheck" });
  }
  return out;
}

export function parseEslintJson(output: string, root = "/app/"): Diagnostic[] {
  const start = output.indexOf("[");
  if (start < 0) return [];
  try {
    const files = JSON.parse(output.slice(start)) as Array<{ filePath: string; messages: Array<{ line?: number; column?: number; severity: number; ruleId: string | null; message: string }> }>;
    return files.flatMap((f) =>
      f.messages.map((m) => ({
        file: f.filePath.startsWith(root) ? f.filePath.slice(root.length) : f.filePath,
        line: m.line ?? null,
        col: m.column ?? null,
        severity: m.severity >= 2 ? ("error" as const) : ("warning" as const),
        code: m.ruleId,
        message: m.message,
        source: "lint" as const,
      })),
    );
  } catch {
    return [];
  }
}

export function parseNextBuild(output: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const lines = output.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    // "./app/page.tsx:12:5" followed by "Type error: …" (next build type check) or a webpack error block
    const loc = /^\.\/([\w./[\]()@-]+\.(?:tsx?|jsx?|css|mjs)):(\d+):(\d+)/.exec(l.trim());
    if (loc) {
      const msg = lines.slice(i + 1, i + 6).find((x) => x.trim()) ?? "";
      out.push({ file: loc[1]!, line: Number(loc[2]), col: Number(loc[3]), severity: "error", code: null, message: msg.trim(), source: "build" });
      continue;
    }
    const mod = /^(Module not found: .*|Error: .*|Failed to compile.*)$/.exec(l.trim());
    if (mod && !out.some((d) => d.message === mod[1])) out.push({ file: null, line: null, col: null, severity: "error", code: null, message: mod[1]!, source: "build" });
  }
  return out;
}

/** Run a check in the preview runtime and return structured diagnostics. */
export async function runCheck(id: string, kind: CheckKind, opts: { timeoutMs?: number } = {}): Promise<CheckResult> {
  let r: ExecResult;
  let diagnostics: Diagnostic[];
  if (kind === "typecheck") {
    r = await execInPreview(id, ["tsc", "--noEmit", "--pretty", "false"], { timeoutMs: opts.timeoutMs ?? 180_000 });
    diagnostics = parseTsc(r.output);
  } else if (kind === "lint") {
    r = await execInPreview(id, ["eslint", ".", "--format", "json", "--ignore-pattern", ".levant/**", "--ignore-pattern", ".next/**", "--ignore-pattern", "out/**"], { timeoutMs: opts.timeoutMs ?? 180_000 });
    diagnostics = parseEslintJson(r.output);
  } else {
    r = await execInPreview(id, ["next", "build"], {
      timeoutMs: opts.timeoutMs ?? 600_000,
      env: ["NEXT_PUBLIC_LEVANT_EDITOR=0", "LEVANT_DIST_DIR=.levant/build-check", "NODE_ENV=production", "NEXT_TELEMETRY_DISABLED=1"],
    });
    diagnostics = parseNextBuild(r.output);
    if (r.exitCode !== 0 && !diagnostics.length) diagnostics.push({ file: null, line: null, col: null, severity: "error", code: null, message: r.output.trim().split("\n").slice(-15).join("\n"), source: "build" });
  }
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.length - errors;
  const ok = r.exitCode === 0 && errors === 0;
  const summary = r.timedOut ? `${kind} timed out after ${Math.round(r.durationMs / 1000)}s` : ok ? `${kind} passed${warnings ? ` (${warnings} warning${warnings > 1 ? "s" : ""})` : ""}` : `${kind} failed: ${errors || "?"} error${errors === 1 ? "" : "s"}${warnings ? `, ${warnings} warning(s)` : ""}`;
  return { kind, ok, durationMs: r.durationMs, summary, diagnostics, output: r.output.slice(-60_000), mode: r.mode };
}

const PKG_SPEC = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~<>=|*+ -]{1,60})?$/i;

/** `pnpm add` through the runtime (egress proxy / CA), commit package.json + pnpm-lock.yaml, restart a running preview. */
export async function addDependency(
  id: string,
  pkgs: string[],
  opts: { dev?: boolean; author?: CommitAuthor; timeoutMs?: number; restartPreview?: boolean } = {},
): Promise<{ ok: boolean; output: string; commit: string | null; restarted: boolean }> {
  const list = pkgs.map((p) => p.trim()).filter(Boolean);
  if (!list.length || list.length > 20) throw new Error("Give 1–20 packages");
  for (const p of list) if (!PKG_SPEC.test(p) || p.startsWith("-")) throw new Error(`Invalid package "${p}"`);
  // one-off container: `pnpm add` gets its own memory budget (next dev keeps running); it writes package.json +
  // pnpm-lock.yaml back to the repo, and the running preview is restarted so its entrypoint installs the new packages
  const r = await execInPreview(id, ["lv-add", ...list, ...(opts.dev ? ["--dev"] : [])], { timeoutMs: opts.timeoutMs ?? 300_000, oneOff: true });
  if (r.exitCode !== 0) return { ok: false, output: r.output.slice(-8000), commit: null, restarted: false };
  const commit = await commitAll(id, `add dependenc${list.length > 1 ? "ies" : "y"}: ${list.join(", ")}`, opts.author ?? "system", { paths: ["package.json", "pnpm-lock.yaml"] });
  const restarted = opts.restartPreview !== false && (await isPreviewRunning(id));
  if (restarted) await requestPreview(id, "restart", { reason: "dependencies changed" });
  return { ok: true, output: r.output.slice(-8000), commit, restarted };
}

// ───────────────────────────── gate: SSO tokens, share links, cookies ─────────────────────────────

export const PREVIEW_COOKIE = "__levant_preview";
export const PREVIEW_COOKIE_TTL_SEC = 12 * 3600;
export const SSO_TTL_SEC = 120;

const secret = () => `${process.env.SESSION_SECRET || "dev-only-session-secret-change-me-dev-only-secret"}:levant-builder-preview`;

export async function canViewPreview(builderId: string, userId: string): Promise<boolean> {
  const p = await db.builderProject.findUnique({ where: { id: builderId }, select: { teamId: true } });
  if (!p) return false;
  const [m, u] = await Promise.all([
    db.membership.findUnique({ where: { teamId_userId: { teamId: p.teamId, userId } }, select: { role: true } }),
    db.user.findUnique({ where: { id: userId }, select: { disabledAt: true } }),
  ]);
  return !!m && !!u && !u.disabledAt && hasRole(m.role, "MEMBER");
}

/** Short-lived (2 min) SSO link for the editor iframe / "open preview" (reusable within its lifetime). */
export async function issuePreviewToken(builderId: string, userId: string, next = "/"): Promise<{ url: string; expiresIn: number }> {
  if (!(await canViewPreview(builderId, userId))) throw new Error("not allowed to open this preview");
  const token = randomToken(32);
  await redis().set(K.sso(token), JSON.stringify({ builderId, userId }), "EX", SSO_TTL_SEC);
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  return { url: `${previewBaseUrl(builderId)}/__levant/sso?t=${encodeURIComponent(token)}&next=${encodeURIComponent(safeNext)}`, expiresIn: SSO_TTL_SEC };
}

export async function redeemPreviewToken(token: string, builderId: string): Promise<{ userId: string } | null> {
  if (!token || token.length > 200) return null;
  const raw = await redis().get(K.sso(token)).catch(() => null);
  if (!raw) return null;
  const v = JSON.parse(raw) as { builderId: string; userId: string };
  if (v.builderId !== builderId || !(await canViewPreview(builderId, v.userId))) return null;
  return { userId: v.userId };
}

type ShareSettings = { tokenHash: string; expiresAt: string | null; createdAt: string; createdById?: string | null };

function readShare(settings: unknown): ShareSettings | null {
  const s = (settings as { share?: ShareSettings } | null)?.share;
  return s && typeof s.tokenHash === "string" ? s : null;
}

/** Create (replace) the project's share link (read-only preview for anyone with the link). */
export async function createShareLink(builderId: string, opts: { ttlHours?: number | null; userId?: string | null } = {}): Promise<{ url: string; expiresAt: string | null }> {
  const p = await db.builderProject.findUniqueOrThrow({ where: { id: builderId }, select: { settings: true } });
  const token = randomToken(24);
  const expiresAt = opts.ttlHours ? new Date(Date.now() + opts.ttlHours * 3600_000).toISOString() : null;
  const share: ShareSettings = { tokenHash: sha256(token), expiresAt, createdAt: new Date().toISOString(), createdById: opts.userId ?? null };
  await db.builderProject.update({ where: { id: builderId }, data: { settings: { ...((p.settings as object) ?? {}), share } } });
  return { url: `${previewBaseUrl(builderId)}/__levant/share?t=${encodeURIComponent(token)}`, expiresAt };
}

export async function revokeShareLink(builderId: string) {
  const p = await db.builderProject.findUniqueOrThrow({ where: { id: builderId }, select: { settings: true } });
  const s = { ...((p.settings as Record<string, unknown>) ?? {}) };
  delete s.share;
  await db.builderProject.update({ where: { id: builderId }, data: { settings: s as object } });
}

export async function shareInfo(builderId: string): Promise<{ enabled: boolean; expiresAt: string | null; createdAt: string | null }> {
  const p = await db.builderProject.findUnique({ where: { id: builderId }, select: { settings: true } });
  const s = readShare(p?.settings);
  const live = !!s && (!s.expiresAt || Date.parse(s.expiresAt) > Date.now());
  return { enabled: live, expiresAt: s?.expiresAt ?? null, createdAt: s?.createdAt ?? null };
}

export async function redeemShareToken(token: string, builderId: string): Promise<{ shareHash: string } | null> {
  if (!token || token.length > 200) return null;
  const p = await db.builderProject.findUnique({ where: { id: builderId }, select: { settings: true } });
  const s = readShare(p?.settings);
  if (!s || (s.expiresAt && Date.parse(s.expiresAt) < Date.now())) return null;
  return timingSafeEqual(sha256(token), s.tokenHash) ? { shareHash: s.tokenHash } : null;
}

/** kind u = team member (sub = userId), s = share link (sub = first 16 chars of the share token hash) */
export function signPreviewCookie(builderId: string, kind: "u" | "s", sub: string, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + PREVIEW_COOKIE_TTL_SEC;
  const payload = `${kind}.${sub}.${builderId}.${exp}`;
  return `${payload}.${hmacSha256(secret(), payload)}`;
}

export function parsePreviewCookie(value: string | null | undefined, builderId: string, now = Date.now()): { kind: "u" | "s"; sub: string } | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 5) return null;
  const [kind, sub, id, exp, sig] = parts as [string, string, string, string, string];
  if ((kind !== "u" && kind !== "s") || id !== builderId || !/^\d+$/.test(exp) || Number(exp) * 1000 < now) return null;
  if (!timingSafeEqual(sig, hmacSha256(secret(), `${kind}.${sub}.${id}.${exp}`))) return null;
  return { kind, sub };
}

const accessCache = new Map<string, { at: number; ok: boolean }>();

/** Full gate check (membership / share link still valid; cached 30 s). */
export async function checkPreviewCookie(value: string | null | undefined, builderId: string): Promise<{ kind: "member"; userId: string } | { kind: "share" } | null> {
  const c = parsePreviewCookie(value, builderId);
  if (!c) return null;
  const key = `${c.kind}:${c.sub}:${builderId}`;
  const hit = accessCache.get(key);
  let ok: boolean;
  if (hit && Date.now() - hit.at < 30_000) ok = hit.ok;
  else {
    if (c.kind === "u") ok = await canViewPreview(builderId, c.sub);
    else {
      const p = await db.builderProject.findUnique({ where: { id: builderId }, select: { settings: true } });
      const s = readShare(p?.settings);
      ok = !!s && s.tokenHash.slice(0, 16) === c.sub && (!s.expiresAt || Date.parse(s.expiresAt) > Date.now());
    }
    if (accessCache.size > 5000) accessCache.clear();
    accessCache.set(key, { at: Date.now(), ok });
  }
  if (!ok) return null;
  return c.kind === "u" ? { kind: "member", userId: c.sub } : { kind: "share" };
}

/** Repo dir helper re-exported for callers that only import preview. */
export { repoDir };
