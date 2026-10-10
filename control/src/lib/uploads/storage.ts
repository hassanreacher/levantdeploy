import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Upload } from "@prisma/client";
import { db } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { createTarGz, isDefaultIgnored, type TarEntry } from "./tar";

/**
 * Chunked, resumable uploads (CLI + dashboard).
 *   init     → Upload row PENDING (size, totalChunks, expires in 24 h)
 *   chunk i  → STORAGE_DIR/uploads/<id>.parts/<i>   (idempotent, any order, re-sendable)
 *   complete → concatenated to STORAGE_DIR/uploads/<id>.tar.gz, size + sha256 verified → COMPLETE (kept uploads.retentionDays)
 */
export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
export const MAX_CHUNK_SIZE = 32 * 1024 * 1024;
export const PENDING_TTL_MS = 24 * 3600_000;

export class UploadError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const storageDir = () => path.resolve(process.env.STORAGE_DIR || "./storage");
export const uploadRelPath = (id: string) => path.join("uploads", `${id}.tar.gz`);
const partsDir = (id: string) => path.join(storageDir(), "uploads", `${id}.parts`);

export async function maxUploadBytes() {
  // Upload.size is an Int column → hard cap just below 2 GiB
  return Math.min(await getSetting("uploads.maxSizeMb"), 2047) * 1024 * 1024;
}

export async function initUpload(input: { teamId: string; projectId?: string | null; userId?: string | null; size: number; chunkSize?: number }) {
  const max = await maxUploadBytes();
  if (input.size <= 0) throw new UploadError(400, "Empty upload");
  if (input.size > max) throw new UploadError(413, `Upload is larger than the limit (${Math.round(max / 1048576)} MB)`);
  const chunkSize = Math.min(Math.max(input.chunkSize ?? DEFAULT_CHUNK_SIZE, 256 * 1024), MAX_CHUNK_SIZE);
  const totalChunks = Math.ceil(input.size / chunkSize);
  const row = await db.upload.create({
    data: {
      teamId: input.teamId,
      projectId: input.projectId ?? null,
      userId: input.userId ?? null,
      path: "",
      size: input.size,
      totalChunks,
      status: "PENDING",
      expiresAt: new Date(Date.now() + PENDING_TTL_MS),
    },
  });
  const upd = await db.upload.update({ where: { id: row.id }, data: { path: uploadRelPath(row.id) } });
  await fs.promises.mkdir(partsDir(row.id), { recursive: true });
  return { upload: upd, chunkSize };
}

export async function receivedChunks(id: string): Promise<number[]> {
  try {
    return (await fs.promises.readdir(partsDir(id))).filter((f) => /^\d+$/.test(f)).map(Number).sort((a, b) => a - b);
  } catch {
    return [];
  }
}

export async function writeChunk(upload: Upload, index: number, data: Uint8Array, chunkSize: number) {
  if (upload.status !== "PENDING") throw new UploadError(409, `Upload is ${upload.status.toLowerCase()}`);
  if (upload.expiresAt < new Date()) throw new UploadError(410, "Upload expired");
  const total = upload.totalChunks ?? 1;
  if (!Number.isInteger(index) || index < 0 || index >= total) throw new UploadError(400, `Chunk index must be 0..${total - 1}`);
  const expected = index === total - 1 ? upload.size - chunkSize * (total - 1) : chunkSize;
  if (data.length !== expected) throw new UploadError(400, `Chunk ${index} must be ${expected} bytes (got ${data.length})`);
  const dir = partsDir(upload.id);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `${index}.tmp-${crypto.randomBytes(4).toString("hex")}`);
  await fs.promises.writeFile(tmp, data);
  await fs.promises.rename(tmp, path.join(dir, String(index)));
  const received = (await receivedChunks(upload.id)).length;
  await db.upload.update({ where: { id: upload.id }, data: { receivedChunks: received } });
  return { received, total };
}

export async function completeUpload(upload: Upload, sha256?: string | null): Promise<Upload> {
  if (upload.status === "COMPLETE") return upload;
  if (upload.status !== "PENDING") throw new UploadError(409, `Upload is ${upload.status.toLowerCase()}`);
  const total = upload.totalChunks ?? 1;
  const have = await receivedChunks(upload.id);
  const missing = [];
  for (let i = 0; i < total; i++) if (!have.includes(i)) missing.push(i);
  if (missing.length) throw new UploadError(409, `Missing chunks: ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? "…" : ""}`);
  const file = path.join(storageDir(), uploadRelPath(upload.id));
  const tmp = file + ".tmp";
  const hash = crypto.createHash("sha256");
  const out = fs.createWriteStream(tmp);
  let size = 0;
  let magic: Buffer | null = null;
  for (let i = 0; i < total; i++) {
    const buf = await fs.promises.readFile(path.join(partsDir(upload.id), String(i)));
    if (i === 0) magic = buf.subarray(0, 512);
    hash.update(buf);
    size += buf.length;
    if (!out.write(buf)) await new Promise<void>((r) => out.once("drain", () => r()));
  }
  await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
  const digest = hash.digest("hex");
  const fail = async (msg: string) => {
    await fs.promises.rm(tmp, { force: true });
    throw new UploadError(400, msg);
  };
  if (size !== upload.size) await fail(`Size mismatch: expected ${upload.size}, got ${size}`);
  if (sha256 && sha256.toLowerCase() !== digest) await fail("sha256 mismatch — the upload was corrupted, please retry");
  if (!magic || !isArchive(magic)) await fail("Upload must be a .tar.gz, .tar or .zip archive");
  await fs.promises.rename(tmp, file);
  await fs.promises.rm(partsDir(upload.id), { recursive: true, force: true });
  const days = await getSetting("uploads.retentionDays");
  return db.upload.update({
    where: { id: upload.id },
    data: { status: "COMPLETE", sha256: digest, receivedChunks: total, expiresAt: new Date(Date.now() + days * 86400_000) },
  });
}

/** gzip (1f 8b), zip (PK\x03\x04) or plain tar ("ustar" at offset 257). */
export function isArchive(m: Uint8Array) {
  if (m[0] === 0x1f && m[1] === 0x8b) return true;
  if (m[0] === 0x50 && m[1] === 0x4b && m[2] === 0x03 && m[3] === 0x04) return true;
  return m.length >= 262 && Buffer.from(m.subarray(257, 262)).toString() === "ustar";
}

/** Packs a local directory (templates) into a COMPLETE Upload. */
export async function uploadFromDirectory(dir: string, input: { teamId: string; projectId?: string | null; userId?: string | null }): Promise<Upload> {
  const entries: TarEntry[] = [];
  const walk = async (rel: string) => {
    for (const d of await fs.promises.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (isDefaultIgnored(r)) continue;
      if (d.isDirectory()) await walk(r);
      else if (d.isFile()) {
        const st = await fs.promises.stat(path.join(dir, r));
        entries.push({ path: r, data: new Uint8Array(await fs.promises.readFile(path.join(dir, r))), mode: st.mode & 0o777, mtime: st.mtimeMs / 1000 });
      }
    }
  };
  await walk("");
  if (!entries.length) throw new UploadError(400, "The folder is empty");
  const bytes = Buffer.from(createTarGz(entries));
  if (bytes.length > (await maxUploadBytes())) throw new UploadError(413, "Folder is larger than the upload limit");
  const days = await getSetting("uploads.retentionDays");
  const row = await db.upload.create({
    data: {
      teamId: input.teamId,
      projectId: input.projectId ?? null,
      userId: input.userId ?? null,
      path: "",
      size: bytes.length,
      totalChunks: 1,
      receivedChunks: 1,
      status: "COMPLETE",
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      expiresAt: new Date(Date.now() + days * 86400_000),
    },
  });
  const rel = uploadRelPath(row.id);
  await fs.promises.mkdir(path.join(storageDir(), "uploads"), { recursive: true });
  await fs.promises.writeFile(path.join(storageDir(), rel), bytes);
  return db.upload.update({ where: { id: row.id }, data: { path: rel } });
}

/** Deletes expired uploads (files + parts) and marks rows EXPIRED. Uploads used by an active deployment are kept. */
export async function expireUploads(): Promise<number> {
  const rows = await db.upload.findMany({ where: { status: { in: ["PENDING", "COMPLETE", "FAILED"] }, expiresAt: { lt: new Date() } }, take: 500 });
  let n = 0;
  for (const u of rows) {
    const inUse = await db.deployment.count({ where: { uploadId: u.id, status: { in: ["QUEUED", "BUILDING"] } } });
    if (inUse) continue;
    await fs.promises.rm(path.join(storageDir(), uploadRelPath(u.id)), { force: true });
    await fs.promises.rm(partsDir(u.id), { recursive: true, force: true });
    await db.upload.update({ where: { id: u.id }, data: { status: "EXPIRED" } });
    n++;
  }
  return n;
}
