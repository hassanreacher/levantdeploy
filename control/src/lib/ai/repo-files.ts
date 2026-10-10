import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { PassThrough } from "node:stream";
import { db } from "@/lib/db";
import { ToolError } from "./permissions";

/**
 * Bounded, read-only access to a deployment's source snapshot for the `read_repo_file` tool.
 *   1. STORAGE_DIR/work/{deploymentId}/src (build area's FetchedSource.repoDir), WORK_DIR/{deploymentId}[/src]
 *   2. the upload tarball (STORAGE_DIR/uploads/<id>.tar.gz) for CLI/dashboard uploads
 * Paths are untrusted model output: they are normalised and must stay inside the snapshot root
 * (no "..", no absolute paths, symlinks resolved and re-checked).
 */
export const MAX_FILE_BYTES = 96 * 1024;
const MAX_TAR_SCAN_BYTES = 256 * 1024 * 1024;
const MAX_LIST = 200;

const storageDir = () => path.resolve(process.env.STORAGE_DIR || "./storage");
const workDir = () => path.resolve(process.env.WORK_DIR || path.join(storageDir(), "work"));

/** Normalise a repo-relative path; throws on traversal. Exported for tests. */
export function safeRelPath(p: string): string {
  const raw = p.replace(/\\/g, "/").trim();
  if (raw.includes("\0")) throw new ToolError("INVALID", "Invalid path");
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) throw new ToolError("INVALID", "Use a path relative to the repository root");
  const norm = path.posix.normalize(raw === "" ? "." : raw);
  if (norm === ".." || norm.startsWith("../") || norm.split("/").includes("..")) throw new ToolError("INVALID", "Path escapes the repository root");
  return norm === "." || norm === "./" ? "" : norm.replace(/^\.\//, "").replace(/\/$/, "");
}

function within(root: string, target: string) {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function candidateDirs(deploymentId: string): string[] {
  return [path.join(storageDir(), "work", deploymentId, "src"), path.join(workDir(), deploymentId, "src"), path.join(workDir(), deploymentId)];
}

/** The on-disk source snapshot of a deployment, if one is kept. */
export function snapshotDir(deploymentId: string): string | null {
  for (const dir of candidateDirs(deploymentId)) if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
  return null;
}

export type RepoFileResult =
  | { kind: "file"; path: string; source: "work" | "upload"; bytes: number; truncated: boolean; content: string }
  | { kind: "dir"; path: string; source: "work" | "upload"; entries: string[]; truncated: boolean };

function isProbablyBinary(buf: Buffer) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function readFromDir(root: string, rel: string): RepoFileResult | null {
  const realRoot = fs.realpathSync(root);
  const target = path.resolve(realRoot, rel);
  if (!within(realRoot, target)) throw new ToolError("INVALID", "Path escapes the repository root");
  if (!fs.existsSync(target)) return null;
  const real = fs.realpathSync(target);
  if (!within(realRoot, real)) throw new ToolError("INVALID", "Path escapes the repository root (symlink)");
  const st = fs.statSync(real);
  if (st.isDirectory()) {
    const entries = fs
      .readdirSync(real, { withFileTypes: true })
      .filter((e) => e.name !== ".git")
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    return { kind: "dir", path: rel || ".", source: "work", entries: entries.slice(0, MAX_LIST), truncated: entries.length > MAX_LIST };
  }
  const fd = fs.openSync(real, "r");
  try {
    const buf = Buffer.alloc(Math.min(st.size, MAX_FILE_BYTES));
    fs.readSync(fd, buf, 0, buf.length, 0);
    if (isProbablyBinary(buf)) throw new ToolError("INVALID", "That file looks binary; only text files can be read");
    return { kind: "file", path: rel, source: "work", bytes: st.size, truncated: st.size > MAX_FILE_BYTES, content: buf.toString("utf8") };
  } finally {
    fs.closeSync(fd);
  }
}

/** Minimal streaming tar(.gz) reader: finds one entry (or lists a directory). Bounded by MAX_TAR_SCAN_BYTES. */
export async function readFromTar(file: string, rel: string): Promise<RepoFileResult | null> {
  const input = fs.createReadStream(file).pipe(file.endsWith(".gz") || file.endsWith(".tgz") ? zlib.createGunzip() : new PassThrough());
  let buf = Buffer.alloc(0);
  let scanned = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  const dirPrefix = rel ? `${rel}/` : "";
  const listing = new Set<string>();
  let skip = 0;
  let collect: { name: string; size: number; chunks: Buffer[]; got: number } | null = null;
  let special: { kind: "L" | "x"; size: number; chunks: Buffer[]; got: number } | null = null;
  let stripPrefix: string | null = null; // tarballs often wrap everything in "./" or "<dir>/"

  const norm = (n: string) => n.replace(/^\.\//, "");
  try {
    for await (const chunk of input as AsyncIterable<Buffer>) {
      scanned += chunk.length;
      if (scanned > MAX_TAR_SCAN_BYTES) break;
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        if (skip > 0) {
          const n = Math.min(skip, buf.length);
          if (collect) {
            const take = Math.min(n, Math.max(0, Math.min(collect.size, MAX_FILE_BYTES) - collect.got));
            if (take > 0) collect.chunks.push(buf.subarray(0, take));
            collect.got += take;
          } else if (special) {
            const take = Math.min(n, Math.max(0, Math.min(special.size, 64 * 1024) - special.got));
            if (take > 0) special.chunks.push(buf.subarray(0, take));
            special.got += take;
          }
          buf = buf.subarray(n);
          skip -= n;
          if (skip > 0) break;
          if (collect) {
            const content = Buffer.concat(collect.chunks);
            if (isProbablyBinary(content)) throw new ToolError("INVALID", "That file looks binary; only text files can be read");
            return { kind: "file", path: rel, source: "upload", bytes: collect.size, truncated: collect.size > MAX_FILE_BYTES, content: content.subarray(0, MAX_FILE_BYTES).toString("utf8") };
          }
          if (special) {
            const text = Buffer.concat(special.chunks).toString("utf8");
            if (special.kind === "L") longName = text.replace(/\0+$/, "");
            else {
              const m = /\d+ path=([^\n]*)\n/.exec(text);
              if (m) paxPath = m[1]!;
            }
            special = null;
          }
          continue;
        }
        if (buf.length < 512) break;
        const h = buf.subarray(0, 512);
        buf = buf.subarray(512);
        if (h.every((b) => b === 0)) continue;
        const str = (o: number, l: number) => h.subarray(o, o + l).toString("utf8").replace(/\0.*$/s, "");
        const size = parseInt(str(124, 12).trim() || "0", 8) || 0;
        const type = String.fromCharCode(h[156] || 48);
        const prefix = str(345, 155);
        let name = paxPath ?? longName ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
        paxPath = null;
        longName = null;
        const padded = Math.ceil(size / 512) * 512;
        if (type === "L" || type === "x") {
          special = { kind: type === "L" ? "L" : "x", size, chunks: [], got: 0 };
          skip = padded;
          continue;
        }
        name = norm(name);
        if (stripPrefix === null) {
          // a single top-level directory entry first ("myapp/") → also match paths without it
          const parts = name.split("/").filter(Boolean);
          stripPrefix = type === "5" && parts.length === 1 ? `${parts[0]}/` : "";
        }
        const candidates = stripPrefix && name.startsWith(stripPrefix) ? [name, name.slice(stripPrefix.length)] : [name];
        const isFile = type === "0" || type === "\0" || type === "7";
        if (isFile && candidates.includes(rel) && rel) {
          collect = { name, size, chunks: [], got: 0 };
          skip = padded;
          if (size === 0) return { kind: "file", path: rel, source: "upload", bytes: 0, truncated: false, content: "" };
          continue;
        }
        // listings use the unwrapped view (paths relative to the wrapper directory when there is one)
        const c = candidates[candidates.length - 1]!;
        if (c.startsWith(dirPrefix) && c !== dirPrefix) {
          const restName = c.slice(dirPrefix.length);
          const head = restName.split("/")[0]!;
          if (head && head !== ".git") listing.add(restName.replace(/\/$/, "").includes("/") || type === "5" ? `${head}/` : head);
        }
        skip = padded;
      }
    }
  } catch (e) {
    if (e instanceof ToolError) throw e;
    return null;
  }
  if (listing.size === 0) return null;
  const entries = [...listing].sort();
  return { kind: "dir", path: rel || ".", source: "upload", entries: entries.slice(0, MAX_LIST), truncated: entries.length > MAX_LIST };
}

/** Read `relPath` (file → text, directory → listing) from a deployment's source snapshot. */
export async function readRepoPath(deploymentId: string, relPath: string): Promise<RepoFileResult> {
  const rel = safeRelPath(relPath);
  for (const dir of candidateDirs(deploymentId)) {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      const res = readFromDir(dir, rel);
      if (res) return res;
      throw new ToolError("NOT_FOUND", `${rel} does not exist in the source snapshot`);
    }
  }
  const d = await db.deployment.findUnique({ where: { id: deploymentId }, select: { upload: { select: { path: true } } } });
  if (d?.upload?.path) {
    const file = path.resolve(storageDir(), d.upload.path);
    if (within(storageDir(), file) && fs.existsSync(file)) {
      const res = await readFromTar(file, rel);
      if (res) return res;
      throw new ToolError("NOT_FOUND", `${rel || "."} does not exist in the uploaded source`);
    }
  }
  throw new ToolError(
    "UNAVAILABLE",
    "No source snapshot is kept for this deployment (work directories are cleaned after builds). Ask the user to paste the file, or check the repository directly.",
  );
}
