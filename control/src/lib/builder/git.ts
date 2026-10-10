import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { repoDir, fixOwnership } from "./workspace";

/**
 * Workspace git (builder-core). Each builder project is a LOCAL git repo (never pushed, except by export.ts on the
 * user's explicit "Export to GitHub"). Every agent turn / visual edit / manual file save is one commit; restore creates
 * a NEW commit whose tree equals the old one (history is never rewritten).
 *
 * Authors: `"agent:<role>"` (agents), `{ name, email }` (users), `"system"` (template, restores done by the platform).
 * Commits are serialized per project with a Redis lock (agents + visual edits may race).
 * Worker-safe.
 */

export type CommitAuthor = string | { name: string; email?: string | null; userId?: string | null };
export type CommitAuthorKind = "agent" | "user" | "visual" | "system";

export type CommitInfo = {
  sha: string;
  shortSha: string;
  message: string;
  /** first line of the message */
  title: string;
  date: string;
  author: { kind: CommitAuthorKind; role: string | null; name: string; email: string };
  parents: string[];
};

export type FileChange = { path: string; status: "added" | "modified" | "deleted" | "renamed"; additions: number; deletions: number; from?: string; binary?: boolean; patch?: string };

export class GitError extends Error {
  constructor(
    message: string,
    public stderr = "",
  ) {
    super(message);
  }
}

const SHA_RE = /^[0-9a-f]{4,40}$/;
export const isSha = (s: string) => SHA_RE.test(s);

const BASE_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_COMMITTER_NAME: "LevantDeploy Builder",
  GIT_COMMITTER_EMAIL: "builder@levantdeploy.local",
  LC_ALL: "C",
};

/** Run git in a repo directory (safe.directory=* — the repo may be owned by the preview container's uid). */
export function gitIn(cwd: string, args: string[], opts: { env?: Record<string, string>; input?: string; maxBuffer?: number; encoding?: "utf8" | "buffer" } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["-c", "safe.directory=*", "-c", "core.quotepath=off", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args],
      { cwd, env: { ...process.env, HOME: process.env.HOME || "/tmp", ...BASE_ENV, ...opts.env }, maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new GitError(`git ${args[0]} failed: ${String(stderr || err.message).trim().slice(0, 2000)}`, String(stderr)));
        else resolve(String(stdout));
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}

/** Binary-safe variant (git archive, git show of images). */
export function gitBuffer(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "safe.directory=*", ...args],
      { cwd, env: { ...process.env, HOME: process.env.HOME || "/tmp", ...BASE_ENV }, encoding: "buffer", maxBuffer: 512 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new GitError(`git ${args[0]} failed: ${String(stderr || err.message).trim().slice(0, 2000)}`, String(stderr)));
        else resolve(stdout as Buffer);
      },
    );
  });
}

export function authorIdentity(a: CommitAuthor): { name: string; email: string } {
  if (typeof a === "string") {
    if (a.startsWith("agent:")) {
      const role = a.slice(6).replace(/[^a-z0-9_-]/gi, "").toLowerCase() || "agent";
      return { name: `agent:${role}`, email: `${role}@agents.levantdeploy.local` };
    }
    if (a === "system") return { name: "LevantDeploy", email: "builder@levantdeploy.local" };
    return { name: a.slice(0, 100), email: "user@levantdeploy.local" };
  }
  const name = (a.name || "User").replace(/[<>\n]/g, "").slice(0, 100);
  return { name, email: (a.email || (a.userId ? `${a.userId}@users.levantdeploy.local` : "user@levantdeploy.local")).replace(/[<>\s]/g, "") };
}

function classify(name: string, message: string): { kind: CommitAuthorKind; role: string | null } {
  if (name.startsWith("agent:")) return { kind: "agent", role: name.slice(6) || null };
  if (/^visual edit:/i.test(message)) return { kind: "visual", role: null };
  if (name === "LevantDeploy") return { kind: "system", role: null };
  return { kind: "user", role: null };
}

// ───────────────────────────── locking ─────────────────────────────

const localLocks = new Map<string, Promise<unknown>>();

/** Serialize mutations of one workspace (in-process queue + Redis mutex across processes). */
export async function withRepoLock<T>(builderId: string, fn: () => Promise<T>, opts: { waitMs?: number; ttlMs?: number } = {}): Promise<T> {
  const prev = localLocks.get(builderId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chained = prev.then(() => mine);
  localLocks.set(builderId, chained);
  await prev.catch(() => {});
  const key = `lb:builder:lock:${builderId}`;
  const token = Math.random().toString(36).slice(2);
  const ttl = opts.ttlMs ?? 120_000;
  const deadline = Date.now() + (opts.waitMs ?? 60_000);
  let haveRedis = true;
  try {
    for (;;) {
      let ok: string | null;
      try {
        ok = await redis().set(key, token, "PX", ttl, "NX");
      } catch {
        haveRedis = false;
        break;
      }
      if (ok === "OK") break;
      if (Date.now() > deadline) throw new GitError("Another change is being saved to this app — try again in a moment");
      await new Promise((r) => setTimeout(r, 150));
    }
    return await fn();
  } finally {
    if (haveRedis) {
      try {
        if ((await redis().get(key)) === token) await redis().del(key);
      } catch {
        /* ignore */
      }
    }
    release();
    if (localLocks.get(builderId) === chained) localLocks.delete(builderId);
  }
}

// ───────────────────────────── basics ─────────────────────────────

export async function initRepo(dir: string) {
  await gitIn(dir, ["init", "-q", "-b", "main"]);
  await gitIn(dir, ["config", "user.name", "LevantDeploy"]);
  await gitIn(dir, ["config", "user.email", "builder@levantdeploy.local"]);
}

export async function headSha(builderId: string): Promise<string | null> {
  try {
    return (await gitIn(repoDir(builderId), ["rev-parse", "--verify", "-q", "HEAD"])).trim() || null;
  } catch {
    return null;
  }
}

async function resolveSha(builderId: string, ref: string): Promise<string> {
  if (ref !== "HEAD" && !isSha(ref)) throw new GitError(`Invalid commit "${ref}"`);
  try {
    return (await gitIn(repoDir(builderId), ["rev-parse", "--verify", "-q", `${ref}^{commit}`])).trim();
  } catch {
    throw new GitError(`Commit ${ref} not found`);
  }
}

async function recordHead(builderId: string, sha: string) {
  await db.builderProject.update({ where: { id: builderId }, data: { lastCommit: sha } }).catch(() => {});
}

/**
 * Stage everything (or only `paths`) and commit. Returns the new sha, or null when nothing changed.
 * `.env.local` and other ignored files are never committed (template .gitignore).
 */
export async function commitAll(builderId: string, message: string, author: CommitAuthor, opts: { paths?: string[]; allowEmpty?: boolean; lock?: boolean } = {}): Promise<string | null> {
  const run = async () => {
    const dir = repoDir(builderId);
    if (opts.paths?.length) await gitIn(dir, ["add", "-A", "--", ...opts.paths]);
    else await gitIn(dir, ["add", "-A"]);
    const staged = (await gitIn(dir, ["diff", "--cached", "--name-only"])).trim();
    if (!staged && !opts.allowEmpty) return null;
    const who = authorIdentity(author);
    const msg = message.trim().slice(0, 4000) || "Update";
    await gitIn(dir, ["commit", "-q", ...(opts.allowEmpty ? ["--allow-empty"] : []), "-F", "-"], {
      input: msg + "\n",
      env: { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email },
    });
    const sha = (await gitIn(dir, ["rev-parse", "HEAD"])).trim();
    await recordHead(builderId, sha);
    await fixOwnership(dir).catch(() => {});
    return sha;
  };
  return opts.lock === false ? run() : withRepoLock(builderId, run);
}

const LOG_FMT = ["%H", "%h", "%an", "%ae", "%aI", "%P", "%B"].join("%x1f") + "%x1e";

function parseLog(out: string): CommitInfo[] {
  return out
    .split("\x1e")
    .map((r) => r.replace(/^\n/, ""))
    .filter((r) => r.trim())
    .map((r) => {
      const [sha, shortSha, name, email, date, parents, body] = r.split("\x1f") as [string, string, string, string, string, string, string];
      const message = (body ?? "").trim();
      return {
        sha,
        shortSha,
        message,
        title: message.split("\n")[0] ?? "",
        date,
        author: { ...classify(name, message), name, email },
        parents: parents ? parents.split(" ").filter(Boolean) : [],
      };
    });
}

/** Commit history, newest first. `before` = paginate from (exclusive) this sha. */
export async function log(builderId: string, opts: { limit?: number; before?: string; path?: string } = {}): Promise<CommitInfo[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const head = await headSha(builderId);
  if (!head) return [];
  const from = opts.before ? `${await resolveSha(builderId, opts.before)}~1` : "HEAD";
  try {
    const out = await gitIn(repoDir(builderId), ["log", `--max-count=${limit}`, `--format=${LOG_FMT}`, from, ...(opts.path ? ["--", safeGitPath(opts.path)] : [])]);
    return parseLog(out);
  } catch (e) {
    if (opts.before && /unknown revision|bad revision/.test((e as GitError).stderr)) return []; // root commit reached
    throw e;
  }
}

export async function getCommit(builderId: string, ref: string): Promise<CommitInfo> {
  const sha = await resolveSha(builderId, ref);
  const out = await gitIn(repoDir(builderId), ["log", "-1", `--format=${LOG_FMT}`, sha]);
  const c = parseLog(out)[0];
  if (!c) throw new GitError(`Commit ${ref} not found`);
  return c;
}

function safeGitPath(p: string): string {
  const n = path.posix.normalize(p.replace(/\\/g, "/")).replace(/^\/+/, "");
  if (!n || n.startsWith("..") || n.includes("\0")) throw new GitError("Invalid path");
  return n;
}

/**
 * Files changed by a commit (vs its first parent; the root commit vs the empty tree) or between two refs.
 * `patches: true` includes unified diffs (each truncated to `maxPatchBytes`).
 */
export async function diff(builderId: string, ref: string, opts: { against?: string; patches?: boolean; maxPatchBytes?: number; path?: string } = {}): Promise<FileChange[]> {
  const dir = repoDir(builderId);
  const to = await resolveSha(builderId, ref);
  let from: string;
  if (opts.against) from = await resolveSha(builderId, opts.against);
  else {
    const c = await getCommit(builderId, to);
    from = c.parents[0] ?? (await gitIn(dir, ["hash-object", "-t", "tree", "/dev/null"])).trim();
  }
  const scope = opts.path ? ["--", safeGitPath(opts.path)] : [];
  const numstat = await gitIn(dir, ["diff", "--numstat", "-M", "-z", from, to, ...scope]);
  const status = await gitIn(dir, ["diff", "--name-status", "-M", "-z", from, to, ...scope]);
  // name-status -z: STATUS\0path\0 (R/C: STATUS\0from\0to\0)
  const st = status.split("\0").filter((x) => x !== "");
  const changes: FileChange[] = [];
  for (let i = 0; i < st.length; ) {
    const code = st[i++]!;
    if (code.startsWith("R") || code.startsWith("C")) {
      const fromP = st[i++]!;
      const toP = st[i++]!;
      changes.push({ path: toP, from: fromP, status: "renamed", additions: 0, deletions: 0 });
    } else {
      const p = st[i++]!;
      changes.push({ path: p, status: code === "A" ? "added" : code === "D" ? "deleted" : "modified", additions: 0, deletions: 0 });
    }
  }
  // numstat -z: "add\tdel\tpath\0" or for renames "add\tdel\t\0from\0to\0"
  const ns = numstat.split("\0");
  for (let i = 0; i < ns.length; i++) {
    const rec = ns[i];
    if (!rec) continue;
    const [a, d, p] = rec.split("\t") as [string, string, string | undefined];
    let file = p;
    if (p === "") {
      i += 2;
      file = ns[i];
    }
    const ch = changes.find((c) => c.path === file);
    if (!ch) continue;
    if (a === "-" && d === "-") ch.binary = true;
    else {
      ch.additions = Number(a) || 0;
      ch.deletions = Number(d) || 0;
    }
  }
  if (opts.patches) {
    const max = opts.maxPatchBytes ?? 200_000;
    for (const ch of changes) {
      if (ch.binary) continue;
      const args = ["diff", "--no-color", "-M", from, to, "--", ...(ch.from ? [ch.from] : []), ch.path];
      const p = await gitIn(dir, args).catch(() => "");
      ch.patch = p.length > max ? p.slice(0, max) + "\n… (diff truncated)\n" : p;
    }
  }
  return changes;
}

/** Unified diff text (whole commit or between refs). */
export async function diffText(builderId: string, ref: string, opts: { against?: string; path?: string } = {}): Promise<string> {
  const files = await diff(builderId, ref, { ...opts, patches: true });
  return files.map((f) => f.patch ?? `Binary file ${f.path} ${f.status}\n`).join("");
}

/**
 * Restore = a NEW commit whose tree equals `sha`'s tree (tracked files added later are removed; ignored files —
 * node_modules, .next, .env.local — are untouched). Returns the new sha (or HEAD when the tree is already equal).
 */
export async function restore(builderId: string, ref: string, author: CommitAuthor, message?: string): Promise<{ sha: string; changed: boolean }> {
  return withRepoLock(builderId, async () => {
    const dir = repoDir(builderId);
    const sha = await resolveSha(builderId, ref);
    const target = await getCommit(builderId, sha);
    await gitIn(dir, ["read-tree", "-u", "--reset", sha]);
    // untracked (non-ignored) leftovers from later commits' working changes
    await gitIn(dir, ["clean", "-fdq"]).catch(() => "");
    const staged = (await gitIn(dir, ["diff", "--cached", "--name-only", "HEAD"])).trim();
    if (!staged) return { sha: (await headSha(builderId))!, changed: false };
    const who = authorIdentity(author);
    const msg = message ?? `Restore to ${target.shortSha}: ${target.title.replace(/^(Restore to [0-9a-f]+: )+/, "")}`.slice(0, 300);
    await gitIn(dir, ["commit", "-q", "-F", "-"], { input: `${msg}\n\nRestored-From: ${sha}\n`, env: { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email } });
    const head = (await gitIn(dir, ["rev-parse", "HEAD"])).trim();
    await recordHead(builderId, head);
    await fixOwnership(dir).catch(() => {});
    return { sha: head, changed: true };
  });
}

/** Content of a file at a commit (null when missing). */
export async function showFile(builderId: string, ref: string, file: string): Promise<Buffer | null> {
  const sha = await resolveSha(builderId, ref);
  try {
    return await gitBuffer(repoDir(builderId), ["show", `${sha}:${safeGitPath(file)}`]);
  } catch {
    return null;
  }
}

/** Tracked files at a commit (paths + sizes). */
export async function lsTree(builderId: string, ref: string): Promise<Array<{ path: string; size: number }>> {
  const sha = await resolveSha(builderId, ref);
  const out = await gitIn(repoDir(builderId), ["ls-tree", "-r", "-l", "-z", sha]);
  return out
    .split("\0")
    .filter(Boolean)
    .map((l) => {
      const tab = l.indexOf("\t");
      const meta = l.slice(0, tab).split(/\s+/);
      return { path: l.slice(tab + 1), size: Number(meta[3]) || 0 };
    });
}

/** tar.gz / zip of a commit's tree (git archive; only committed files — never .env.local / node_modules). */
export async function archive(builderId: string, opts: { ref?: string; format?: "tar.gz" | "zip" | "tar"; prefix?: string } = {}): Promise<Buffer> {
  const sha = await resolveSha(builderId, opts.ref ?? "HEAD");
  const fmt = opts.format ?? "tar.gz";
  const prefix = opts.prefix ? `${opts.prefix.replace(/[^\w.-]/g, "-")}/` : "";
  return gitBuffer(repoDir(builderId), ["archive", `--format=${fmt === "tar.gz" ? "tgz" : fmt}`, ...(prefix ? [`--prefix=${prefix}`] : []), sha]);
}

/** Working tree differs from HEAD? (uncommitted edits) */
export async function isDirty(builderId: string): Promise<boolean> {
  const out = await gitIn(repoDir(builderId), ["status", "--porcelain"]);
  return out.trim().length > 0;
}

export async function repoExists(builderId: string): Promise<boolean> {
  try {
    await fs.access(path.join(repoDir(builderId), ".git"));
    return true;
  } catch {
    return false;
  }
}
