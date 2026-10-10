import fs from "node:fs/promises";
import path from "node:path";
import { repoDir, fixOwnership } from "./workspace";
import { gitIn, showFile, lsTree, commitAll, withRepoLock, type CommitAuthor } from "./git";

/**
 * File operations on a builder workspace (builder-core) with path safety:
 *  - relative posix paths only; no "..", no absolute paths, no NUL, ≤ 300 chars, ≤ 20 segments
 *  - never inside .git / node_modules / .next / .levant; .env* files are not readable or writable through the API
 *  - resolved real path must stay inside the repo (symlinks can't escape)
 *  - text writes ≤ 1 MB, uploads ≤ 5 MB; binary detection (NUL byte / known extensions)
 * Worker-safe.
 */

export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_BINARY_BYTES = 5 * 1024 * 1024;
export const MAX_READ_BYTES = 2 * 1024 * 1024;

export class FileError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const BLOCKED_DIRS = new Set([".git", "node_modules", ".next", ".levant", ".turbo", ".vercel"]);
const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp", "tiff", "pdf", "zip", "gz", "tgz", "tar", "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "mp4", "webm", "mov", "wav", "ogg", "wasm",
]);

/** Normalize + validate a repo-relative path. Throws FileError(400). */
export function safeRelPath(input: string, opts: { allowEnv?: boolean } = {}): string {
  if (typeof input !== "string" || !input.trim()) throw new FileError(400, "Path is required");
  if (input.includes("\0")) throw new FileError(400, "Invalid path");
  const raw = input.replace(/\\/g, "/").trim();
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) throw new FileError(400, "Path must be relative to the project root");
  const norm = path.posix.normalize(raw).replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!norm || norm === "." || norm.startsWith("../") || norm === ".." || norm.split("/").includes("..")) throw new FileError(400, "Path escapes the project");
  if (norm.length > 300) throw new FileError(400, "Path is too long");
  const parts = norm.split("/");
  if (parts.length > 20) throw new FileError(400, "Path is too deep");
  if (parts.some((p) => BLOCKED_DIRS.has(p))) throw new FileError(400, `"${norm}" is not editable`);
  if (!opts.allowEnv && /^\.env(\..*)?$/.test(parts[parts.length - 1]!)) throw new FileError(400, "Environment files are managed by the platform (Backend / Environment settings)");
  return norm;
}

export function isBinaryPath(p: string) {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return BINARY_EXT.has(ext);
}

export function looksBinary(buf: Uint8Array) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Absolute path inside the repo (realpath of the existing prefix must stay inside the repo). */
async function absPath(builderId: string, rel: string): Promise<string> {
  const root = await fs.realpath(repoDir(builderId)).catch(() => {
    throw new FileError(404, "Workspace not found");
  });
  const abs = path.join(root, rel);
  // walk up to the deepest existing ancestor and realpath it
  let probe = abs;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      const rest = path.relative(probe, abs);
      const full = path.join(real, rest);
      if (full !== root && !full.startsWith(root + path.sep)) throw new FileError(400, "Path escapes the project");
      return full;
    } catch (e) {
      if (e instanceof FileError) throw e;
      const parent = path.dirname(probe);
      if (parent === probe) throw new FileError(400, "Invalid path");
      probe = parent;
    }
  }
}

export type FileEntry = { path: string; size: number; tracked: boolean };

/** Files of the working tree (tracked + untracked non-ignored), or of a commit when `ref` is given. */
export async function listFiles(builderId: string, opts: { ref?: string } = {}): Promise<FileEntry[]> {
  if (opts.ref && opts.ref !== "WORKTREE") return (await lsTree(builderId, opts.ref)).map((f) => ({ ...f, tracked: true }));
  const dir = repoDir(builderId);
  const tracked = new Set((await gitIn(dir, ["ls-files", "-z"])).split("\0").filter(Boolean));
  const all = (await gitIn(dir, ["ls-files", "-z", "-co", "--exclude-standard"])).split("\0").filter(Boolean);
  const out: FileEntry[] = [];
  for (const p of [...new Set(all)].sort()) {
    const st = await fs.stat(path.join(dir, p)).catch(() => null);
    if (!st?.isFile()) continue; // deleted in the worktree
    out.push({ path: p, size: st.size, tracked: tracked.has(p) });
  }
  return out;
}

export type FileContent = { path: string; size: number; binary: boolean; encoding: "utf8" | "base64"; content: string; truncated?: boolean };

/** Read a file from the working tree (or a commit). Binary files come back base64-encoded. */
export async function readFile(builderId: string, file: string, opts: { ref?: string } = {}): Promise<FileContent> {
  const rel = safeRelPath(file);
  let buf: Buffer;
  if (opts.ref && opts.ref !== "WORKTREE") {
    const b = await showFile(builderId, opts.ref, rel);
    if (!b) throw new FileError(404, `${rel} not found in ${opts.ref.slice(0, 7)}`);
    buf = b;
  } else {
    const abs = await absPath(builderId, rel);
    const st = await fs.stat(abs).catch(() => null);
    if (!st?.isFile()) throw new FileError(404, `${rel} not found`);
    if (st.size > MAX_READ_BYTES * 4) throw new FileError(413, "File is too large to open");
    buf = await fs.readFile(abs);
  }
  const binary = isBinaryPath(rel) || looksBinary(buf);
  const truncated = !binary && buf.length > MAX_READ_BYTES;
  const data = truncated ? buf.subarray(0, MAX_READ_BYTES) : buf;
  return { path: rel, size: buf.length, binary, encoding: binary ? "base64" : "utf8", content: binary ? data.toString("base64") : data.toString("utf8"), ...(truncated ? { truncated } : {}) };
}

/** Write (create/overwrite) a file. Text by default; `encoding: "base64"` for binary uploads. Optionally commits. */
export async function writeFile(
  builderId: string,
  file: string,
  content: string | Uint8Array,
  opts: { encoding?: "utf8" | "base64"; commit?: { message: string; author: CommitAuthor } | false } = {},
): Promise<{ path: string; size: number; commit: string | null }> {
  const rel = safeRelPath(file);
  const buf = typeof content === "string" ? Buffer.from(content, opts.encoding === "base64" ? "base64" : "utf8") : Buffer.from(content);
  const binary = typeof content !== "string" || opts.encoding === "base64" || isBinaryPath(rel);
  if (buf.length > (binary ? MAX_BINARY_BYTES : MAX_TEXT_BYTES)) throw new FileError(413, `File is larger than ${binary ? "5 MB" : "1 MB"}`);
  return withRepoLock(builderId, async () => {
    const abs = await absPath(builderId, rel);
    const st = await fs.lstat(abs).catch(() => null);
    if (st?.isDirectory()) throw new FileError(409, `${rel} is a directory`);
    if (st?.isSymbolicLink()) throw new FileError(400, `${rel} is a symlink`);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, buf);
    await fixOwnership(repoDir(builderId)).catch(() => {});
    const sha = opts.commit ? await commitAll(builderId, opts.commit.message, opts.commit.author, { paths: [rel], lock: false }) : null;
    return { path: rel, size: buf.length, commit: sha };
  });
}

export async function deleteFile(builderId: string, file: string, opts: { commit?: { message: string; author: CommitAuthor } | false } = {}) {
  const rel = safeRelPath(file);
  return withRepoLock(builderId, async () => {
    const abs = await absPath(builderId, rel);
    const st = await fs.lstat(abs).catch(() => null);
    if (!st) throw new FileError(404, `${rel} not found`);
    if (st.isDirectory()) await fs.rm(abs, { recursive: true, force: true });
    else await fs.unlink(abs);
    const sha = opts.commit ? await commitAll(builderId, opts.commit.message, opts.commit.author, { paths: [rel], lock: false }) : null;
    return { path: rel, commit: sha };
  });
}

export async function renameFile(builderId: string, from: string, to: string, opts: { commit?: { message: string; author: CommitAuthor } | false } = {}) {
  const a = safeRelPath(from);
  const b = safeRelPath(to);
  return withRepoLock(builderId, async () => {
    const absA = await absPath(builderId, a);
    const absB = await absPath(builderId, b);
    if (!(await fs.lstat(absA).catch(() => null))) throw new FileError(404, `${a} not found`);
    if (await fs.lstat(absB).catch(() => null)) throw new FileError(409, `${b} already exists`);
    await fs.mkdir(path.dirname(absB), { recursive: true });
    await fs.rename(absA, absB);
    await fixOwnership(repoDir(builderId)).catch(() => {});
    const sha = opts.commit ? await commitAll(builderId, opts.commit.message, opts.commit.author, { paths: [a, b], lock: false }) : null;
    return { from: a, to: b, commit: sha };
  });
}

/** Plain-text search over tracked + untracked text files (git grep). */
export async function searchFiles(builderId: string, q: string, opts: { limit?: number } = {}): Promise<Array<{ path: string; line: number; text: string }>> {
  const query = q.trim();
  if (!query || query.length > 200) return [];
  const out = await gitIn(repoDir(builderId), ["grep", "-n", "-I", "-F", "-i", "--untracked", "--no-color", "-e", query]).catch(() => "");
  const limit = opts.limit ?? 200;
  const items: Array<{ path: string; line: number; text: string }> = [];
  for (const l of out.split("\n")) {
    const m = l.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    items.push({ path: m[1]!, line: Number(m[2]), text: m[3]!.slice(0, 300) });
    if (items.length >= limit) break;
  }
  return items;
}
