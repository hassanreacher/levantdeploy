/**
 * Ports the orchestrator depends on + thin fallback implementations.
 *
 * Production wiring (`productionDeps()` in ./deps.ts) binds these ports to the real libraries (src/lib/llm,
 * src/lib/builder/{workspace,git,preview}, src/lib/base). Tests inject scripted fakes. Everything the agents do to the
 * outside world goes through one of these ports, so a run is fully deterministic under test.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { CheckKind, CheckResult, LlmPort, ProjectContext, RunEvent, RunEventType, RunRecord, RunStatus } from "./types";

const exec = promisify(execFile);

// ───────────────────────────── ports ─────────────────────────────

export type Author = { name: string; email: string };

export interface WorkspacePort {
  /** absolute path of the project's git work tree */
  root(projectId: string): Promise<string>;
  head(projectId: string): Promise<string | null>;
  /** stage everything (or only `paths`) + commit; null when there was nothing to commit */
  commit(projectId: string, opts: { message: string; author: Author; paths?: string[] }): Promise<string | null>;
  /** new commit whose tree equals `sha` (history is kept) */
  restore(projectId: string, sha: string, opts: { message: string; author: Author }): Promise<string | null>;
  addDependency(projectId: string, pkgs: string[], opts?: { dev?: boolean }): Promise<{ ok: boolean; output: string }>;
}

export interface ChecksPort {
  run(projectId: string, kind: CheckKind, opts?: { signal?: AbortSignal }): Promise<CheckResult>;
  /** dev-server + browser runtime errors captured for the preview (most recent first) */
  previewErrors(projectId: string): Promise<string[]>;
  /** optional: make sure the live preview is running (so runtime errors get captured) */
  prepare?(projectId: string): Promise<void>;
}

export type SqlResult = { ok: boolean; rowCount: number; rows: Record<string, unknown>[]; error?: string };

export interface BackendPort {
  /** creates (or returns) the LevantBase backend of the builder project and wires env vars into the preview */
  attach(projectId: string, opts: { teamId: string; userId: string | null }): Promise<{ ref: string; url: string; anonKey: string }>;
  sql(ref: string, sql: string): Promise<SqlResult>;
  createBucket(ref: string, name: string, opts: { public: boolean }): Promise<void>;
  /** TypeScript types of the public schema */
  types(ref: string): Promise<string>;
  deployFunction(ref: string, slug: string, source: string, opts: { verifyJwt: boolean; userId: string | null }): Promise<{ url: string }>;
}

export type RunPatch = Partial<Pick<RunRecord, "status" | "phase" | "plan" | "state" | "steps" | "error" | "summary" | "startCommit" | "endCommit" | "startedAt" | "finishedAt">>;

export interface RunStorePort {
  getRun(runId: string): Promise<RunRecord | null>;
  updateRun(runId: string, patch: RunPatch): Promise<void>;
  /** compare-and-set on status (returns false when the current status is not in `from`) */
  transition(runId: string, from: RunStatus[], to: RunStatus, patch?: RunPatch): Promise<boolean>;
  appendEvent(runId: string, type: RunEventType, data: Record<string, unknown>): Promise<RunEvent>;
  listEvents(runId: string, afterSeq?: number, limit?: number): Promise<RunEvent[]>;
  isCancelRequested(runId: string): Promise<boolean>;
  /** project facts + chat history before `runId`'s message */
  projectContext(builderProjectId: string, runId?: string): Promise<ProjectContext>;
  /** assistant chat message for the run (BuilderMessage) */
  writeAssistantMessage(run: RunRecord, content: string, commitSha: string | null): Promise<void>;
  /**
   * Execution lease: exactly one executor per run (worker job, resumed job, dev script). `acquireLease` is NX with a
   * TTL; the executor renews it while alive; the resume sweep skips runs whose lease is alive.
   */
  acquireLease(runId: string, owner: string, ttlMs: number): Promise<boolean>;
  renewLease(runId: string, owner: string, ttlMs: number): Promise<boolean>;
  releaseLease(runId: string, owner: string): Promise<void>;
  /** builder project bookkeeping (lastCommit, baseRef) */
  updateProject(builderProjectId: string, patch: { lastCommit?: string | null; baseRef?: string | null; status?: string }): Promise<void>;
}

export interface EventBusPort {
  publish(runId: string, ev: RunEvent): Promise<void>;
}

export type AgentDeps = {
  llm: LlmPort;
  workspace: WorkspacePort;
  checks: ChecksPort;
  backend: BackendPort;
  store: RunStorePort;
  bus: EventBusPort;
  sleep?: (ms: number) => Promise<void>;
  log?: (...a: unknown[]) => void;
};

// ───────────────────────────── git-CLI workspace (fallback) ─────────────────────────────

/** Workspace on disk with the git CLI. `rootFor(id)` maps a project id to its repo directory. */
export function gitWorkspace(rootFor: (projectId: string) => string): WorkspacePort {
  const git = async (cwd: string, args: string[], env: Record<string, string> = {}) => {
    const r = await exec("git", args, { cwd, env: { ...process.env, ...env }, maxBuffer: 32 * 1024 * 1024 });
    return r.stdout.trim();
  };
  const ensure = async (dir: string) => {
    await fs.mkdir(dir, { recursive: true });
    try {
      await fs.stat(path.join(dir, ".git"));
    } catch {
      await git(dir, ["init", "-q", "-b", "main"]);
    }
  };
  const authorEnv = (a: Author) => ({ GIT_AUTHOR_NAME: a.name, GIT_AUTHOR_EMAIL: a.email, GIT_COMMITTER_NAME: "LevantDeploy Builder", GIT_COMMITTER_EMAIL: "builder@levantdeploy.local" });
  return {
    async root(id) {
      const d = rootFor(id);
      await ensure(d);
      return d;
    },
    async head(id) {
      const d = rootFor(id);
      try {
        return await git(d, ["rev-parse", "HEAD"]);
      } catch {
        return null;
      }
    },
    async commit(id, { message, author, paths }) {
      const d = rootFor(id);
      await ensure(d);
      if (paths?.length) await git(d, ["add", "-A", "--", ...paths]);
      else await git(d, ["add", "-A"]);
      const staged = await git(d, ["diff", "--cached", "--name-only"]);
      if (!staged) return null;
      await git(d, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", message], authorEnv(author));
      return git(d, ["rev-parse", "HEAD"]);
    },
    async restore(id, sha, { message, author }) {
      const d = rootFor(id);
      await git(d, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "."]).catch(() => "");
      await git(d, ["checkout", sha, "--", "."]);
      await git(d, ["clean", "-fdq", "-e", "node_modules", "-e", ".next", "-e", ".env*"]);
      await git(d, ["add", "-A"]);
      const status = await git(d, ["status", "--porcelain"]);
      if (!status) return git(d, ["rev-parse", "HEAD"]);
      await git(d, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", message], authorEnv(author));
      return git(d, ["rev-parse", "HEAD"]);
    },
    async addDependency(id, pkgs) {
      // without the preview runtime we only record the dependency in package.json; the runtime installs on start
      const d = rootFor(id);
      const file = path.join(d, "package.json");
      const pj = JSON.parse(await fs.readFile(file, "utf8").catch(() => "{}")) as { dependencies?: Record<string, string> };
      pj.dependencies ??= {};
      for (const p of pkgs) {
        const m = /^(@?[^@]+)(?:@(.+))?$/.exec(p);
        if (m) pj.dependencies[m[1]] = m[2] ?? "latest";
      }
      await fs.writeFile(file, JSON.stringify(pj, null, 2) + "\n");
      return { ok: true, output: `added to package.json: ${pkgs.join(", ")} (installed when the preview starts)` };
    },
  };
}

// ───────────────────────────── local checks (fallback) ─────────────────────────────

/** Runs tsc / next lint / next build in the work tree when node_modules exists there; otherwise "skipped". */
export function localChecks(workspace: WorkspacePort): ChecksPort {
  return {
    async run(id, kind) {
      const d = await workspace.root(id);
      try {
        await fs.stat(path.join(d, "node_modules", ".bin"));
      } catch {
        return { ok: true, skipped: true, output: "no node_modules in the workspace — check skipped" };
      }
      const cmd = kind === "typecheck" ? ["tsc", "--noEmit", "-p", "."] : kind === "lint" ? ["next", "lint", "--quiet"] : ["next", "build"];
      try {
        const r = await exec(path.join(d, "node_modules", ".bin", cmd[0]), cmd.slice(1), { cwd: d, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
        return { ok: true, output: (r.stdout + r.stderr).slice(-4000) };
      } catch (e) {
        const x = e as { stdout?: string; stderr?: string; message: string };
        return { ok: false, output: ((x.stdout ?? "") + (x.stderr ?? "") || x.message).slice(-8000) };
      }
    },
    async previewErrors() {
      return [];
    },
  };
}

// ───────────────────────────── in-memory store + bus (tests / dev) ─────────────────────────────

export type MemoryStore = RunStorePort & {
  leases: Map<string, { owner: string; until: number }>;
  runs: Map<string, RunRecord>;
  events: Map<string, RunEvent[]>;
  messages: { runId: string; content: string; commitSha: string | null }[];
  projects: Map<string, ProjectContext & { lastCommit?: string | null; status?: string }>;
  requestCancel(runId: string): void;
};

export function memoryStore(): MemoryStore {
  const runs = new Map<string, RunRecord>();
  const events = new Map<string, RunEvent[]>();
  const projects = new Map<string, ProjectContext & { lastCommit?: string | null; status?: string }>();
  const messages: MemoryStore["messages"] = [];
  const leases = new Map<string, { owner: string; until: number }>();
  return {
    leases,
    async acquireLease(id, owner, ttl) {
      const l = leases.get(id);
      if (l && l.until > Date.now() && l.owner !== owner) return false;
      leases.set(id, { owner, until: Date.now() + ttl });
      return true;
    },
    async renewLease(id, owner, ttl) {
      const l = leases.get(id);
      if (!l || l.owner !== owner) return false;
      l.until = Date.now() + ttl;
      return true;
    },
    async releaseLease(id, owner) {
      if (leases.get(id)?.owner === owner) leases.delete(id);
    },
    runs,
    events,
    messages,
    projects,
    requestCancel(id) {
      const r = runs.get(id);
      if (r) r.cancelRequested = true;
    },
    async getRun(id) {
      const r = runs.get(id);
      return r ? structuredClone(r) : null;
    },
    async updateRun(id, patch) {
      const r = runs.get(id);
      if (r) Object.assign(r, structuredClone(patch));
    },
    async transition(id, from, to, patch) {
      const r = runs.get(id);
      if (!r || !from.includes(r.status)) return false;
      Object.assign(r, structuredClone(patch ?? {}), { status: to });
      return true;
    },
    async appendEvent(id, type, data) {
      const list = events.get(id) ?? [];
      const ev: RunEvent = { seq: list.length + 1, type, data: structuredClone(data), at: new Date().toISOString() };
      list.push(ev);
      events.set(id, list);
      return ev;
    },
    async listEvents(id, after = 0, limit = 1000) {
      return (events.get(id) ?? []).filter((e) => e.seq > after).slice(0, limit);
    },
    async isCancelRequested(id) {
      return !!runs.get(id)?.cancelRequested;
    },
    async projectContext(pid) {
      const p = projects.get(pid);
      if (!p) return { id: pid, teamId: "team", name: "app", knowledge: "", baseRef: null, history: [] };
      return structuredClone(p);
    },
    async writeAssistantMessage(run, content, commitSha) {
      messages.push({ runId: run.id, content, commitSha });
    },
    async updateProject(pid, patch) {
      const p = projects.get(pid);
      if (p) {
        if (patch.baseRef !== undefined) p.baseRef = patch.baseRef;
        if (patch.lastCommit !== undefined) p.lastCommit = patch.lastCommit;
        if (patch.status !== undefined) p.status = patch.status;
      }
    },
  };
}

export function memoryBus(): EventBusPort & { published: RunEvent[] } {
  const published: RunEvent[] = [];
  return {
    published,
    async publish(_id, ev) {
      published.push(ev);
    },
  };
}
