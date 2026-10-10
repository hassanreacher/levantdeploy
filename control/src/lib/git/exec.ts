import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GitAuth } from "@/lib/sources/types";

/**
 * Runs git non-interactively with optional credentials:
 *  - token → `-c http.extraHeader=Authorization: Basic …` (never written to disk or the remote URL)
 *  - ssh   → private key in a 0600 temp file + GIT_SSH_COMMAND (accept-new host keys, isolated known_hosts)
 */
export class GitError extends Error {
  constructor(
    message: string,
    public stderr: string,
  ) {
    super(message);
  }
}

export async function runGit(args: string[], opts: { auth?: GitAuth | null; cwd?: string; timeoutMs?: number } = {}): Promise<string> {
  const pre: string[] = [];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/echo",
    SSH_ASKPASS: "/bin/echo",
    GCM_INTERACTIVE: "never",
    LC_ALL: "C",
  };
  let tmp: string | null = null;
  const auth = opts.auth;
  if (auth?.kind === "token") {
    const basic = Buffer.from(`${auth.username || "x-access-token"}:${auth.token}`).toString("base64");
    pre.push("-c", `http.extraHeader=Authorization: Basic ${basic}`);
  } else if (auth?.kind === "ssh") {
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ld-ssh-"));
    const keyFile = path.join(tmp, "id");
    await fs.promises.writeFile(keyFile, auth.privateKey.endsWith("\n") ? auth.privateKey : auth.privateKey + "\n", { mode: 0o600 });
    const kh = path.join(tmp, "known_hosts");
    await fs.promises.writeFile(kh, auth.knownHosts ?? "", { mode: 0o600 });
    env.GIT_SSH_COMMAND = `ssh -i ${keyFile} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${kh} -o ConnectTimeout=15`;
  }
  if (process.env.GIT_ALLOW_FILE_URLS === "1") pre.push("-c", "protocol.file.allow=always");
  try {
    return await new Promise<string>((resolve, reject) => {
      execFile("git", [...pre, ...args], { cwd: opts.cwd, env, timeout: opts.timeoutMs ?? 30_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message)
            .replace(/Authorization: Basic \S+/g, "Authorization: Basic ***")
            .trim()
            .split("\n")
            .slice(-3)
            .join(" ");
          reject(new GitError(msg || "git failed", String(stderr)));
        } else resolve(String(stdout));
      });
    });
  } finally {
    if (tmp) await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** Branch heads + default branch of a remote (`git ls-remote --symref`). */
export async function lsRemote(url: string, auth?: GitAuth | null): Promise<{ heads: Record<string, string>; defaultBranch: string | null }> {
  const out = await runGit(["ls-remote", "--symref", "--", url, "HEAD", "refs/heads/*"], { auth, timeoutMs: 30_000 });
  const heads: Record<string, string> = {};
  let defaultBranch: string | null = null;
  for (const line of out.split("\n")) {
    const sym = /^ref: refs\/heads\/(\S+)\s+HEAD$/.exec(line);
    if (sym) {
      defaultBranch = sym[1]!;
      continue;
    }
    const m = /^([0-9a-f]{40,64})\s+refs\/heads\/(.+)$/.exec(line);
    if (m) heads[m[2]!] = m[1]!;
  }
  return { heads, defaultBranch };
}

/** Shallow clone of one branch into a fresh temp dir (caller removes it). */
export async function shallowClone(url: string, branch: string | null, auth?: GitAuth | null): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ld-clone-"));
  const args = ["clone", "--depth", "1", "--no-tags", "--single-branch"];
  if (branch) args.push("--branch", branch);
  args.push("--", url, dir);
  try {
    await runGit(args, { auth, timeoutMs: 90_000 });
  } catch (e) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  return dir;
}
