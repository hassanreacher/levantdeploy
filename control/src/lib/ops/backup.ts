import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { env } from "@/lib/env";
import { redis } from "@/lib/redis";
import { getSetting } from "@/lib/settings";

/**
 * Control-plane database backups (ops area): `pg_dump --format=custom` of DATABASE_URL into
 * STORAGE_DIR/backups/control/levantdeploy-YYYYMMDD-HHMMSS.dump, keeping the newest `backups.control.keep` files.
 * Runs in the worker (`ops` queue, kind "control-backup") — on schedule or "Back up now".
 * Restore: install/restore.sh (pg_restore into the postgres container). Worker-safe.
 */
export const BACKUP_NAME_RE = /^levantdeploy-\d{8}-\d{6}\.dump$/;
const LAST_KEY = "ld:ops:backup:last";
const RUNNING_KEY = "ld:ops:backup:running";

export type BackupFile = { name: string; size: number; createdAt: string };
export type BackupStatus = { ok: boolean; at: string; file: string | null; size: number | null; error: string | null; ms: number };

export function controlBackupDir() {
  return path.join(path.resolve(env.STORAGE_DIR), "backups", "control");
}

export function backupPath(name: string): string | null {
  if (!BACKUP_NAME_RE.test(name)) return null;
  return path.join(controlBackupDir(), name);
}

export async function listControlBackups(): Promise<BackupFile[]> {
  const dir = controlBackupDir();
  let names: string[] = [];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const out: BackupFile[] = [];
  for (const name of names.filter((n) => BACKUP_NAME_RE.test(n))) {
    try {
      const st = await fs.promises.stat(path.join(dir, name));
      out.push({ name, size: st.size, createdAt: st.mtime.toISOString() });
    } catch {}
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

function stamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** pg_dump connection args from DATABASE_URL (password via PGPASSWORD, never on the command line). */
export function pgArgs(databaseUrl: string): { args: string[]; password: string | null } {
  const u = new URL(databaseUrl);
  const db = decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres";
  const args = ["-h", u.hostname, "-p", u.port || "5432", "-U", decodeURIComponent(u.username || "postgres"), "-d", db];
  const schema = u.searchParams.get("schema");
  if (schema && schema !== "public") args.push("-n", schema);
  return { args, password: u.password ? decodeURIComponent(u.password) : null };
}

export async function lastBackupStatus(): Promise<BackupStatus | null> {
  const raw = await redis()
    .get(LAST_KEY)
    .catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BackupStatus;
  } catch {
    return null;
  }
}

export async function backupRunning(): Promise<boolean> {
  return !!(await redis()
    .get(RUNNING_KEY)
    .catch(() => null));
}

export async function rotateControlBackups(keep: number) {
  const files = await listControlBackups();
  for (const f of files.slice(Math.max(1, keep))) await fs.promises.rm(path.join(controlBackupDir(), f.name), { force: true });
}

export async function runControlBackup(): Promise<BackupStatus> {
  const t0 = Date.now();
  const dir = controlBackupDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const name = `levantdeploy-${stamp()}.dump`;
  const final = path.join(dir, name);
  const tmp = `${final}.partial`;
  await redis()
    .set(RUNNING_KEY, "1", "EX", 3600)
    .catch(() => {});
  let status: BackupStatus;
  try {
    const { args, password } = pgArgs(env.DATABASE_URL);
    await new Promise<void>((resolve, reject) => {
      const child = spawn("pg_dump", ["--format=custom", "--compress=6", "--no-owner", "--no-privileges", "--file", tmp, ...args], {
        env: { ...process.env, ...(password ? { PGPASSWORD: password } : {}), PGCONNECT_TIMEOUT: "10" },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr = (stderr + d.toString()).slice(-4000)));
      child.on("error", (e) => reject((e as NodeJS.ErrnoException).code === "ENOENT" ? new Error("pg_dump is not installed in this environment") : e));
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `pg_dump exited with code ${code}`))));
    });
    await fs.promises.rename(tmp, final);
    const size = (await fs.promises.stat(final)).size;
    const { keep } = await getSetting("backups.control");
    await rotateControlBackups(keep);
    status = { ok: true, at: new Date().toISOString(), file: name, size, error: null, ms: Date.now() - t0 };
  } catch (e) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    status = { ok: false, at: new Date().toISOString(), file: null, size: null, error: (e as Error).message.slice(0, 1000), ms: Date.now() - t0 };
  } finally {
    await redis()
      .del(RUNNING_KEY)
      .catch(() => {});
  }
  await redis()
    .set(LAST_KEY, JSON.stringify(status))
    .catch(() => {});
  return status;
}
