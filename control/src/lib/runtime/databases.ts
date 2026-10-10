import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { PassThrough, type Readable, type Writable } from "node:stream";
import type { Database } from "@prisma/client";
import { db } from "@/lib/db";
import { docker, dockerNetwork, ensureNetwork, LABELS } from "@/lib/docker";
import { decryptJson, encryptJson, randomToken } from "@/lib/crypto";
import { env } from "@/lib/env";
import { ENGINES, type DbCredentials } from "./db-engines";
import { EXTRA_LABELS, ensureImage, ensureVolume, inspectSafe, removeContainer, startContainer, stopContainer } from "./containers";
import { cronMatches, parseCron } from "./cron-expr";

/**
 * Database add-ons: one container per database on levant_net (`ld-db-<id>`), data in a named volume
 * (`levant_db_<id>`), generated credentials (encrypted), optional public port, backups to STORAGE_DIR/backups/<id>/.
 */

export const dbContainerName = (d: Pick<Database, "id">) => `levant_db_${d.id}`;
export const dbInternalHost = (d: Pick<Database, "id">) => `ld-db-${d.id}`;
export const dbVolumeName = (d: Pick<Database, "id">) => `levant_db_${d.id}`;
const backupDir = (d: Pick<Database, "id">) => path.resolve(env.STORAGE_DIR, "backups", d.id);

/** URL-safe password without characters that need quoting in shells/URLs. */
export function generatePassword(len = 32) {
  return randomToken(48).replace(/[^a-zA-Z0-9]/g, "").slice(0, len);
}

export function generateCredentials(engine: Database["engine"], name: string): DbCredentials {
  const ident = name.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^[^a-z]+/, "") || "app";
  return {
    user: engine === "REDIS" ? "default" : ident.slice(0, 30) === "root" ? "app" : ident.slice(0, 30),
    password: generatePassword(),
    database: ident.slice(0, 60),
    ...(engine === "MYSQL" ? { rootPassword: generatePassword() } : {}),
  };
}

export function credentials(d: Pick<Database, "credentialsEnc">): DbCredentials {
  const c = decryptJson<DbCredentials>(d.credentialsEnc);
  if (!c) throw new Error("Database credentials cannot be decrypted (ENCRYPTION_KEY changed?)");
  return c;
}

/** Connection strings (internal = for apps on levant_net, public = via the host port). */
export function connectionInfo(d: Database, publicHost?: string) {
  const c = credentials(d);
  const spec = ENGINES[d.engine];
  const internalHost = d.internalHost ?? dbInternalHost(d);
  return {
    engine: d.engine,
    host: internalHost,
    port: spec.port,
    user: c.user,
    password: c.password,
    database: c.database,
    internalUrl: spec.url(c, internalHost, spec.port),
    publicUrl: d.publicPort ? spec.url(c, publicHost || (env.SERVER_IPS.split(",")[0]?.trim() || "localhost"), d.publicPort) : null,
    envNames: spec.envNames,
  };
}

async function execIn(containerId: string, cmd: string[], opts: { stdin?: Readable; stdout?: Writable; envExtra?: string[] } = {}): Promise<{ exitCode: number; stderr: string }> {
  const c = docker().getContainer(containerId);
  const ex = await c.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, AttachStdin: !!opts.stdin, Env: opts.envExtra });
  const stream = (await ex.start({ hijack: true, stdin: !!opts.stdin })) as unknown as NodeJS.ReadWriteStream & { end: () => void };
  const errChunks: Buffer[] = [];
  const stderr = new PassThrough();
  stderr.on("data", (b: Buffer) => {
    if (errChunks.reduce((n, x) => n + x.length, 0) < 64 * 1024) errChunks.push(b);
  });
  const stdout = opts.stdout ?? new PassThrough().resume();
  docker().modem.demuxStream(stream, stdout, stderr);
  const ended = new Promise<void>((res) => {
    stream.on("end", () => res());
    stream.on("close", () => res());
  });
  if (opts.stdin) {
    opts.stdin.on("end", () => {
      // half-close stdin so the command sees EOF
      const s = stream as unknown as { end?: () => void; socket?: { end: () => void } };
      s.end?.();
    });
    opts.stdin.pipe(stream as unknown as NodeJS.WritableStream, { end: false });
  }
  await ended;
  let info = await ex.inspect();
  for (let i = 0; i < 50 && info.Running; i++) {
    await new Promise((r) => setTimeout(r, 100));
    info = await ex.inspect();
  }
  return { exitCode: info.ExitCode ?? 0, stderr: Buffer.concat(errChunks).toString("utf8") };
}

async function waitReady(d: Database, timeoutMs = 120_000) {
  const spec = ENGINES[d.engine];
  const c = credentials(d);
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < timeoutMs) {
    const info = await inspectSafe(dbContainerName(d));
    if (info && !info.State.Running && info.State.Status === "exited") throw new Error(`Database container exited (code ${info.State.ExitCode})`);
    if (info?.State.Running) {
      const r = await execIn(dbContainerName(d), spec.ready(c)).catch((e) => ({ exitCode: 1, stderr: String(e) }));
      if (r.exitCode === 0) return;
      last = r.stderr;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Database did not become ready in ${timeoutMs / 1000}s ${last ? `(${last.slice(0, 300)})` : ""}`);
}

/** Create the container (pull image, volume) and wait until it accepts connections. Idempotent. */
export async function provisionDatabase(id: string) {
  const d = await db.database.findUniqueOrThrow({ where: { id } });
  const spec = ENGINES[d.engine];
  const c = credentials(d);
  try {
    await ensureNetwork();
    const image = `${spec.image}:${d.version}`;
    await ensureImage(image);
    const vol = d.volumeName ?? dbVolumeName(d);
    await ensureVolume(vol, { [LABELS.team]: d.teamId, [EXTRA_LABELS.database]: d.id });
    await removeContainer(dbContainerName(d)).catch(() => {});
    const container = await docker().createContainer({
      name: dbContainerName(d),
      Image: image,
      Env: spec.env(c),
      ...(spec.cmd ? { Cmd: spec.cmd(c) } : {}),
      Labels: { [LABELS.managed]: "true", [LABELS.team]: d.teamId, [EXTRA_LABELS.role]: "db", [EXTRA_LABELS.database]: d.id, ...(d.projectId ? { [LABELS.project]: d.projectId } : {}) },
      ExposedPorts: { [`${spec.port}/tcp`]: {} },
      HostConfig: {
        NetworkMode: dockerNetwork(),
        RestartPolicy: { Name: "unless-stopped" },
        Mounts: [{ Type: "volume", Source: vol, Target: spec.dataDir }],
        LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
        ...(d.publicPort ? { PortBindings: { [`${spec.port}/tcp`]: [{ HostIp: "0.0.0.0", HostPort: String(d.publicPort) }] } } : {}),
      },
      NetworkingConfig: { EndpointsConfig: { [dockerNetwork()]: { Aliases: [dbInternalHost(d)] } } },
    });
    await container.start();
    await db.database.update({ where: { id }, data: { containerId: container.id, volumeName: vol, internalHost: dbInternalHost(d), status: "PROVISIONING", lastError: null } });
    await waitReady({ ...d, volumeName: vol });
    await db.database.update({ where: { id }, data: { status: "RUNNING" } });
  } catch (e) {
    await db.database.update({ where: { id }, data: { status: "ERROR", lastError: (e as Error).message.slice(0, 2000) } });
    throw e;
  }
}

export async function setDatabaseRunning(id: string, running: boolean) {
  const d = await db.database.findUniqueOrThrow({ where: { id } });
  if (!(await inspectSafe(dbContainerName(d)))) {
    if (running) return provisionDatabase(id);
    return;
  }
  if (running) {
    await startContainer(dbContainerName(d));
    await waitReady(d);
    await db.database.update({ where: { id }, data: { status: "RUNNING", lastError: null } });
  } else {
    await stopContainer(dbContainerName(d), 20);
    await db.database.update({ where: { id }, data: { status: "STOPPED" } });
  }
}

/** Remove container + volume + backup files and the row. */
export async function deleteDatabase(id: string, opts: { keepBackups?: boolean } = {}) {
  const d = await db.database.findUnique({ where: { id } });
  if (!d) return;
  await removeContainer(dbContainerName(d)).catch(() => {});
  await docker()
    .getVolume(d.volumeName ?? dbVolumeName(d))
    .remove()
    .catch(() => {});
  if (!opts.keepBackups) await fs.promises.rm(backupDir(d), { recursive: true, force: true });
  await db.database.delete({ where: { id } });
}

/** Run a backup into STORAGE_DIR/backups/<dbId>/<timestamp>.<ext>, then apply retention. */
export async function runBackup(backupId: string) {
  const b = await db.backup.findUniqueOrThrow({ where: { id: backupId }, include: { database: true } });
  const d = b.database;
  const spec = ENGINES[d.engine];
  const c = credentials(d);
  const dir = backupDir(d);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rel = path.join("backups", d.id, `${ts}.${spec.backup.ext}`);
  const file = path.resolve(env.STORAGE_DIR, rel);
  await db.backup.update({ where: { id: b.id }, data: { status: "RUNNING", startedAt: new Date(), path: rel } });
  try {
    const out = fs.createWriteStream(file, { mode: 0o600 });
    const pass = new PassThrough();
    const writing = spec.backup.gzip ? pipeline(pass, zlib.createGzip(), out) : pipeline(pass, out);
    const r = await execIn(dbContainerName(d), spec.backup.cmd(c), { stdout: pass });
    pass.end();
    await writing;
    if (r.exitCode !== 0) throw new Error(`backup command exited with ${r.exitCode}: ${r.stderr.slice(0, 500)}`);
    const size = (await fs.promises.stat(file)).size;
    if (size < 20) throw new Error("backup is empty");
    await db.backup.update({ where: { id: b.id }, data: { status: "SUCCESS", sizeBytes: size, finishedAt: new Date(), error: null } });
  } catch (e) {
    await fs.promises.rm(file, { force: true });
    await db.backup.update({ where: { id: b.id }, data: { status: "FAILED", error: (e as Error).message.slice(0, 2000), finishedAt: new Date(), path: null } });
    throw e;
  }
  await applyRetention(d);
}

export async function applyRetention(d: Pick<Database, "id" | "backupRetention">) {
  const ok = await db.backup.findMany({ where: { databaseId: d.id, status: "SUCCESS" }, orderBy: { createdAt: "desc" } });
  for (const old of ok.slice(Math.max(1, d.backupRetention))) {
    if (old.path) await fs.promises.rm(path.resolve(env.STORAGE_DIR, old.path), { force: true });
    await db.backup.delete({ where: { id: old.id } });
  }
  // failed backups older than 7 days
  await db.backup.deleteMany({ where: { databaseId: d.id, status: "FAILED", createdAt: { lt: new Date(Date.now() - 7 * 86400_000) } } });
}

export function backupFilePath(b: { path: string | null }) {
  return b.path ? path.resolve(env.STORAGE_DIR, b.path) : null;
}

/** Restore a successful backup (overwrites current data). */
export async function restoreBackup(backupId: string) {
  const b = await db.backup.findUniqueOrThrow({ where: { id: backupId }, include: { database: true } });
  const d = b.database;
  const spec = ENGINES[d.engine];
  const c = credentials(d);
  const file = backupFilePath(b);
  if (!file || !fs.existsSync(file)) throw new Error("Backup file not found");
  if (d.engine === "REDIS") {
    // stop → replace dump.rdb in the volume through a helper container → start
    const vol = d.volumeName ?? dbVolumeName(d);
    await stopContainer(dbContainerName(d), 20);
    const helper = await docker().createContainer({
      Image: `${spec.image}:${d.version}`,
      Cmd: ["sh", "-c", "cat > /data/dump.rdb && chown redis:redis /data/dump.rdb 2>/dev/null; true"],
      OpenStdin: true,
      StdinOnce: true,
      AttachStdin: true,
      Labels: { [LABELS.managed]: "true", [EXTRA_LABELS.role]: "db-restore" },
      HostConfig: { Mounts: [{ Type: "volume", Source: vol, Target: "/data" }], AutoRemove: false },
    });
    try {
      const s = (await helper.attach({ stream: true, stdin: true, hijack: true })) as unknown as NodeJS.WritableStream;
      await helper.start();
      await pipeline(fs.createReadStream(file), zlib.createGunzip(), s);
      await helper.wait();
    } finally {
      await helper.remove({ force: true }).catch(() => {});
    }
    await startContainer(dbContainerName(d));
    await waitReady(d);
    return;
  }
  const input = spec.restore.gunzip ? fs.createReadStream(file).pipe(zlib.createGunzip()) : fs.createReadStream(file);
  const r = await execIn(dbContainerName(d), spec.restore.cmd(c), { stdin: input });
  if (r.exitCode !== 0) throw new Error(`restore exited with ${r.exitCode}: ${r.stderr.slice(0, 500)}`);
}

/** Backups tick: create scheduled backups whose cron matches the current minute. */
export async function scheduledBackups(now = new Date()) {
  const due: string[] = [];
  const list = await db.database.findMany({ where: { backupSchedule: { not: null }, status: "RUNNING" } });
  for (const d of list) {
    try {
      if (!cronMatches(parseCron(d.backupSchedule!), now.getTime(), "UTC")) continue;
    } catch {
      continue;
    }
    const minuteStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    const dup = await db.backup.findFirst({ where: { databaseId: d.id, trigger: "SCHEDULED", createdAt: { gte: minuteStart } } });
    if (dup) continue;
    const b = await db.backup.create({ data: { databaseId: d.id, trigger: "SCHEDULED", status: "PENDING" } });
    due.push(b.id);
  }
  return due;
}

/** Pick a free host port for public access. */
export async function allocatePublicPort(engine: Database["engine"]): Promise<number> {
  const base = { POSTGRES: 15432, MYSQL: 13306, REDIS: 16379, MONGO: 17017 }[engine];
  const used = new Set((await db.database.findMany({ where: { publicPort: { not: null } }, select: { publicPort: true } })).map((x) => x.publicPort!));
  const net = await import("node:net");
  for (let p = base; p < base + 500; p++) {
    if (used.has(p)) continue;
    const free = await new Promise<boolean>((res) => {
      const s = net.createServer();
      s.once("error", () => res(false));
      s.listen(p, "0.0.0.0", () => s.close(() => res(true)));
    });
    if (free) return p;
  }
  throw new Error("No free public port available");
}

export function newDatabaseData(input: { teamId: string; projectId?: string | null; name: string; engine: Database["engine"]; version?: string }) {
  const spec = ENGINES[input.engine];
  return {
    teamId: input.teamId,
    projectId: input.projectId ?? null,
    name: input.name,
    engine: input.engine,
    version: input.version ?? spec.defaultVersion,
    credentialsEnc: encryptJson(generateCredentials(input.engine, input.name)),
    status: "PROVISIONING" as const,
    port: spec.port,
  };
}
