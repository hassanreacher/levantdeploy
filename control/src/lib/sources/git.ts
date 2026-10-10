import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execStream, execCapture, ExecError } from "@/lib/build/exec";
import type { GitAuth } from "./types";

/**
 * Shallow git clone at a branch / commit.
 *  - HTTPS tokens go through `http.extraHeader` via GIT_CONFIG_* env (never in argv, .git/config or logs)
 *  - SSH keys are written to a 0600 temp file used by GIT_SSH_COMMAND and deleted afterwards
 */
export type CloneOptions = {
  url: string;
  dest: string;
  branch?: string | null;
  commitSha?: string | null;
  auth?: GitAuth | null;
  log?: (line: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  submodules?: boolean;
};

export type CloneResult = { commitSha: string; commitMessage: string; commitAuthor: string; branch: string | null };

/** Remove credentials from a URL for display. */
export function displayUrl(url: string): string {
  try {
    if (/^[a-z]+:\/\//i.test(url)) {
      const u = new URL(url);
      u.username = "";
      u.password = "";
      return u.toString().replace(/\/$/, "");
    }
  } catch {
    /* scp-like */
  }
  return url.replace(/\/\/[^@/]+@/, "//");
}

export async function gitEnv(auth: GitAuth | null | undefined): Promise<{ env: NodeJS.ProcessEnv; redact: string[]; cleanup: () => Promise<void> }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "echo",
    GCM_INTERACTIVE: "never",
    LC_ALL: "C",
  };
  const redact: string[] = [];
  let cleanup = async () => {};
  if (auth?.kind === "token") {
    const basic = Buffer.from(`${auth.username || "x-access-token"}:${auth.token}`).toString("base64");
    // appended after any GIT_CONFIG_* the environment already defines
    const n = Number(env.GIT_CONFIG_COUNT || 0);
    env.GIT_CONFIG_COUNT = String(n + 1);
    env[`GIT_CONFIG_KEY_${n}`] = "http.extraHeader";
    env[`GIT_CONFIG_VALUE_${n}`] = `Authorization: Basic ${basic}`;
    redact.push(auth.token, basic);
  } else if (auth?.kind === "ssh") {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "levant-ssh-"));
    const keyFile = path.join(dir, "id");
    const known = path.join(dir, "known_hosts");
    await fsp.writeFile(keyFile, auth.privateKey.replace(/\r\n/g, "\n").trimEnd() + "\n", { mode: 0o600 });
    await fsp.writeFile(known, auth.knownHosts ?? "", { mode: 0o600 });
    env.GIT_SSH_COMMAND = `ssh -i ${keyFile} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${known} -o ConnectTimeout=20`;
    cleanup = async () => {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    };
  }
  return { env, redact, cleanup };
}

const SHA_RE = /^[0-9a-f]{7,40}$/i;

export async function cloneRepo(o: CloneOptions): Promise<CloneResult> {
  const { env, redact, cleanup } = await gitEnv(o.auth);
  const log = o.log ?? (() => {});
  const started = Date.now();
  const deadline = o.timeoutMs ? started + o.timeoutMs : null;
  const left = () => (deadline ? Math.max(1000, deadline - Date.now()) : undefined);
  const git = async (args: string[], quietFail = false) => {
    const r = await execStream("git", args, {
      cwd: o.dest,
      env,
      signal: o.signal,
      timeoutMs: left(),
      redact,
      onLine: (l) => {
        // drop git's percentage progress lines (\r-separated), keep the final "done" ones
        if (!l.trim() || (/\d+% \(\d+\/\d+\)/.test(l) && !/done/.test(l))) return;
        log(l);
      },
    });
    if (r.aborted) throw new ExecError("Clone canceled", r);
    if (r.timedOut) throw new ExecError("Clone timed out", r);
    if (r.code !== 0 && !quietFail) throw new ExecError(`git ${args[0]} failed (exit ${r.code})`, r);
    return r.code === 0;
  };
  try {
    await fsp.mkdir(o.dest, { recursive: true });
    await git(["init", "-q"]);
    await git(["remote", "add", "origin", o.url]);
    await git(["config", "advice.detachedHead", "false"]);
    const sha = o.commitSha && SHA_RE.test(o.commitSha) ? o.commitSha : null;
    let fetched = false;
    if (sha && sha.length === 40) {
      // most servers (GitHub, GitLab, Gitea) allow fetching a reachable commit directly
      fetched = await git(["fetch", "--depth", "1", "--no-tags", "--progress", "origin", sha], true);
      if (fetched) await git(["checkout", "-q", "FETCH_HEAD"]);
    }
    if (!fetched) {
      const ref = o.branch || "HEAD";
      await git(["fetch", "--depth", sha ? "200" : "1", "--no-tags", "--progress", "origin", ref]);
      if (sha) {
        const ok = await git(["checkout", "-q", sha], true);
        if (!ok) throw new Error(`Commit ${sha.slice(0, 12)} not found on ${ref} (history depth 200)`);
      } else await git(["checkout", "-q", "FETCH_HEAD"]);
    }
    if (o.submodules !== false) {
      const hasModules = await fsp
        .stat(path.join(o.dest, ".gitmodules"))
        .then(() => true)
        .catch(() => false);
      if (hasModules) {
        log("Updating submodules…");
        await git(["submodule", "update", "--init", "--recursive", "--depth", "1"]);
      }
    }
    const info = await execCapture("git", ["log", "-1", "--format=%H%x00%s%x00%an"], { cwd: o.dest, env });
    const [commitSha = "", commitMessage = "", commitAuthor = ""] = info.stdout.trim().split("\0");
    return { commitSha, commitMessage, commitAuthor, branch: o.branch ?? null };
  } finally {
    await cleanup();
  }
}

/** Resolve a branch (or tag) to its head commit with `git ls-remote` (null when the ref doesn't exist). */
export async function resolveRemoteRef(url: string, ref: string, auth?: GitAuth | null, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string | null> {
  const { env, cleanup } = await gitEnv(auth);
  try {
    const r = await execCapture("git", ["ls-remote", "--", url, `refs/heads/${ref}`, `refs/tags/${ref}`, ref], { env, signal: opts.signal, timeoutMs: opts.timeoutMs ?? 60_000 });
    if (r.code !== 0) throw new Error(`git ls-remote failed: ${r.stderr.trim().split("\n").pop() ?? ""}`);
    const lines = r.stdout.trim().split("\n").filter(Boolean).map((l) => l.split(/\s+/));
    const pick = lines.find((l) => l[1] === `refs/heads/${ref}`) ?? lines.find((l) => l[1] === `refs/tags/${ref}^{}`) ?? lines.find((l) => l[1] === `refs/tags/${ref}`) ?? lines[0];
    return pick?.[0] && /^[0-9a-f]{40}$/.test(pick[0]) ? pick[0] : null;
  } finally {
    await cleanup();
  }
}

/** Random suffix helper for temp dirs */
export const rand = () => crypto.randomBytes(4).toString("hex");
