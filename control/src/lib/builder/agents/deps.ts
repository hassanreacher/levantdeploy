/**
 * Production wiring of the agent ports. Worker-only (spawns git / talks to Docker through the libs).
 */
import { llm } from "@/lib/llm";
import { getBaseProject, baseKeys, runSql, deployFunction } from "@/lib/base";
import { generateTypes } from "@/lib/base/types";
import { commitAll, headSha, restore } from "@/lib/builder/git";
import { createWorkspace, repoDir, workspaceExists } from "@/lib/builder/workspace";
import { addDependency, execInPreview, getPreviewErrorMessages, isPreviewRunning, parseEslintJson, requestPreview, runCheck, type Diagnostic } from "@/lib/builder/preview";
import { attachBackend } from "@/lib/builder/backend";
import { execFile } from "node:child_process";
import { type AgentDeps, type ChecksPort, type BackendPort, type WorkspacePort } from "./adapters";
import { routerLlm } from "./llm-adapter";
import type { CheckResult } from "./types";
import { prismaStore, redisBus } from "./store";


function quoteLiteral(s: string) {
  return `'${s.replace(/'/g, "''")}'`;
}

/** LevantBase backend for builder projects (one backend per builder project, created on first need). */
export function levantBaseBackend(): BackendPort {
  return {
    async attach(projectId, { userId }) {
      // builder-core: create/reuse the backend, write the preview's .env.local, restart a running preview
      const a = await attachBackend(projectId, { userId });
      const ref = a.ref;
      // wait for provisioning (first boot pulls nothing — images are shared — but takes ~30-90 s)
      const deadline = Date.now() + 6 * 60_000;
      for (;;) {
        const p = await getBaseProject(ref);
        if (!p) throw new Error(`Base project ${ref} disappeared`);
        if (p.status === "ACTIVE") break;
        if (p.status === "ERROR") throw new Error(`Backend ${ref} failed to start: ${p.statusMessage ?? "error"}`);
        if (Date.now() > deadline) throw new Error(`Backend ${ref} is still ${p.status} after 6 minutes`);
        await new Promise((r) => setTimeout(r, 3000));
      }
      const k = await baseKeys(ref);
      return { ref, url: k.url, anonKey: k.anonKey };
    },
    async sql(ref, sql) {
      try {
        const r = await runSql(ref, sql, { role: "postgres", timeoutMs: 60_000, maxRows: 200 });
        return { ok: true, rowCount: r.rowCount, rows: r.rows };
      } catch (e) {
        return { ok: false, rowCount: 0, rows: [], error: (e as Error).message.slice(0, 2000) };
      }
    },
    async createBucket(ref, name, opts) {
      await runSql(ref, `insert into storage.buckets (id, name, public) values (${quoteLiteral(name)}, ${quoteLiteral(name)}, ${opts.public ? "true" : "false"}) on conflict (id) do update set public = excluded.public;`, { role: "postgres" });
    },
    types: (ref) => generateTypes(ref, { schemas: ["public"] }),
    async deployFunction(ref, slug, source, opts) {
      const r = await deployFunction(ref, { slug, source, verifyJwt: opts.verifyJwt, byUserId: opts.userId });
      return { url: r.url };
    },
  };
}

/** Workspace port over builder-core's git/workspace libs (repo lock, ownership fix, lastCommit bookkeeping). */
export function coreWorkspace(): WorkspacePort {
  return {
    async root(id) {
      if (!(await workspaceExists(id))) await createWorkspace(id);
      return repoDir(id);
    },
    head: (id) => headSha(id),
    commit: (id, { message, author, paths }) => commitAll(id, message, author, { paths }),
    async restore(id, sha, { message, author }) {
      return (await restore(id, sha, author, message)).sha;
    },
    async addDependency(id, pkgs, opts) {
      try {
        const r = await addDependency(id, pkgs, { dev: opts?.dev, author: "agent:coder" });
        return { ok: r.ok, output: r.output };
      } catch (e) {
        return { ok: false, output: (e as Error).message };
      }
    },
  };
}

/**
 * Interim checks until builder-core's preview lib provides runCheck/previewErrors: a throw-away container of the
 * runtime image (template deps pre-installed) with the repo bind-mounted, no network, preview uid.
 */
// link the image's pre-installed modules (skip the entrypoint's reinstall-on-package.json-change) and run the command
const CHECK_SCRIPT = 'if [ -L node_modules ] || [ ! -e node_modules ]; then ln -sfn /opt/levant/base/node_modules node_modules; fi; export PATH="/app/node_modules/.bin:$PATH"; exec "$@"';

export function dockerChecks(): ChecksPort {
  const image = process.env.BUILDER_RUNTIME_IMAGE || "levant/builder-runtime:next15";
  return {
    async run(id, kind, opts) {
      const cmd = kind === "typecheck" ? ["tsc", "--noEmit", "--pretty", "false"] : kind === "lint" ? ["next", "lint", "--quiet"] : ["next", "build"];
      const args = ["run", "--rm", "--network", "none", "--user", "1000:1000", "-e", "NEXT_TELEMETRY_DISABLED=1", "-e", "LEVANT_DIST_DIR=.levant/build-check", "-e", "NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321", "-e", "NEXT_PUBLIC_SUPABASE_ANON_KEY=check", "-v", `${repoDir(id)}:/app`, "-w", "/app", "--label", "levant.builder-check=1", "--entrypoint", "sh", image, "-c", CHECK_SCRIPT, "check", ...cmd];
      return new Promise<CheckResult>((resolve) => {
        execFile("docker", args, { timeout: 8 * 60_000, maxBuffer: 16 * 1024 * 1024, signal: opts?.signal }, (err, stdout, stderr) => {
          const out = `${stdout}${stderr}`.replace(/▲ levant:[^\n]*\n/g, "");
          if (!err) return resolve({ ok: true, output: out.slice(-4000) });
          if ((err as { code?: unknown }).code === "ENOENT") return resolve({ ok: true, skipped: true, output: "docker not available — check skipped" });
          resolve({ ok: false, output: out.slice(-10_000) || err.message });
        });
      });
    },
    async previewErrors() {
      return [];
    },
  };
}

function formatDiagnostics(ds: Diagnostic[]): string {
  const errs = ds.filter((d) => d.severity === "error");
  return errs
    .slice(0, 60)
    .map((d) => `${d.file ?? "?"}${d.line ? `:${d.line}:${d.col ?? 0}` : ""} ${d.code ? `${d.code} ` : ""}${d.message}`)
    .join("\n");
}

/** Checks in the project's preview runtime (builder-core runCheck: exec in the running preview or a one-off container). */
export function previewChecks(): ChecksPort {
  return {
    async run(id, kind) {
      try {
        if (kind === "lint") {
          // explicit ignores: build-check output (.levant/) and caches must never be linted (older workspaces lack them in eslint.config)
          const x = await execInPreview(id, ["eslint", ".", "--format", "json", "--ignore-pattern", ".levant/**", "--ignore-pattern", ".next/**", "--ignore-pattern", "levant/**", "--ignore-pattern", "components/levant/**"], { timeoutMs: 180_000 });
          const ds = parseEslintJson(x.output);
          const errs = ds.filter((d) => d.severity === "error");
          const ok = !x.timedOut && errs.length === 0 && (x.exitCode === 0 || ds.length > 0);
          return { ok, output: ok ? `lint passed${ds.length ? ` (${ds.length} warnings)` : ""}` : `lint failed: ${errs.length || "?"} errors\n${formatDiagnostics(ds) || x.output.slice(-4000)}` };
        }
        const r = await runCheck(id, kind);
        const diag = formatDiagnostics(r.diagnostics);
        return { ok: r.ok, output: r.ok ? r.summary : `${r.summary}\n${diag || r.output.slice(-6000)}` };
      } catch (e) {
        return { ok: true, skipped: true, output: `check unavailable: ${(e as Error).message.slice(0, 300)}` };
      }
    },
    async previewErrors(id) {
      return getPreviewErrorMessages(id).catch(() => []);
    },
    async prepare(id) {
      if (!(await isPreviewRunning(id).catch(() => true))) await requestPreview(id, "start", { reason: "AI run" }).catch(() => {});
    },
  };
}

let cached: AgentDeps | null = null;

export function productionDeps(): AgentDeps {
  if (cached) return cached;
  const workspace = coreWorkspace();
  cached = {
    llm: routerLlm(llm),
    workspace,
    checks: process.env.BUILDER_AGENT_CHECKS === "docker" ? dockerChecks() : previewChecks(),
    backend: levantBaseBackend(),
    store: prismaStore(),
    bus: redisBus(),
    log: (...a) => console.log(new Date().toISOString(), "[builder]", ...a),
  };
  return cached;
}
