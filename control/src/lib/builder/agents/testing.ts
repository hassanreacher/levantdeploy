/**
 * Test helpers: scripted fake LLM (deterministic tool-call sequences per role), fake checks/backend, temp git workspace.
 * Used by agents.test.ts and the dev scripts; not imported by production code.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitWorkspace, memoryBus, memoryStore, type AgentDeps, type BackendPort, type ChecksPort } from "./adapters";
import { LlmCallError, type ChatRequest, type ChatResult, type CheckKind, type CheckResult, type LlmPort, type RunMode, type RunRecord, type ToolCall } from "./types";

export type Scripted =
  | { text?: string; calls?: { name: string; args: Record<string, unknown> | string }[]; json?: unknown; provider?: string }
  | { fail: string; allFailed?: boolean }
  | { hang: true }
  | ((req: ChatRequest) => Scripted);

/** role → queue of responses. Calls beyond the script: `finish` (agents) / "ok" text. */
export function fakeLlm(script: Partial<Record<string, Scripted[]>>, opts: { providers?: string[]; defaultProvider?: string } = {}) {
  const calls: { role: string; req: ChatRequest; provider: string }[] = [];
  const queues = new Map(Object.entries(script).map(([k, v]) => [k, [...(v ?? [])]]));
  let n = 0;
  const port: LlmPort & { calls: typeof calls; remaining: (role: string) => number } = {
    calls,
    remaining: (role) => queues.get(role)?.length ?? 0,
    async providers() {
      return opts.providers ?? ["gemini"];
    },
    async chat(req): Promise<ChatResult> {
      const role = req.ref?.role ?? "unknown";
      const key = req.provider && queues.has(`${role}@${req.provider}`) ? `${role}@${req.provider}` : role;
      const q = queues.get(key);
      let item: Scripted | undefined = q?.shift();
      while (typeof item === "function") item = item(req);
      const scriptedProvider = item && typeof item === "object" && "provider" in item ? item.provider : undefined;
      const provider = req.provider ?? scriptedProvider ?? [opts.defaultProvider ?? "gemini", ...(opts.providers ?? [])].find((p) => !req.excludeProviders?.includes(p)) ?? "gemini";
      calls.push({ role, req: structuredClone({ ...req, signal: undefined }), provider });
      if (item && "hang" in item) {
        return new Promise<ChatResult>((_res, rej) => req.signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true }));
      }
      if (item && "fail" in item) throw new LlmCallError(`${item.fail}: 429 rate limited`, item.fail, !!item.allFailed);
      const it = (item ?? (req.tools?.length ? { calls: [{ name: "finish", args: { summary: `${role} done` } }] } : { text: `${role} ok` })) as Exclude<Scripted, { fail: string } | { hang: true } | ((r: ChatRequest) => Scripted)>;
      const toolCalls: ToolCall[] = (it.calls ?? []).map((c) => ({ id: `call_${++n}`, name: c.name, arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args) }));
      return {
        content: it.text ?? (it.json !== undefined ? JSON.stringify(it.json) : ""),
        toolCalls,
        provider,
        model: `${provider}-model`,
        usage: { inputTokens: 100, outputTokens: 50 },
        json: it.json,
      };
    },
  };
  return port;
}

export function fakeChecks(script: Partial<Record<CheckKind, CheckResult[]>> = {}, preview: string[][] = []): ChecksPort & { ran: CheckKind[] } {
  const ran: CheckKind[] = [];
  const queues = new Map(Object.entries(script).map(([k, v]) => [k, [...(v ?? [])]]));
  return {
    ran,
    async run(_id, kind) {
      ran.push(kind);
      return queues.get(kind)?.shift() ?? { ok: true, output: `${kind} ok` };
    },
    async previewErrors() {
      return preview.shift() ?? [];
    },
  };
}

export function fakeBackend(): BackendPort & { sqlRan: string[]; buckets: string[] } {
  const sqlRan: string[] = [];
  const buckets: string[] = [];
  return {
    sqlRan,
    buckets,
    async attach() {
      return { ref: "abcdefghijklmnopqrst", url: "https://abcdefghijklmnopqrst.base.levant.localhost", anonKey: "anon" };
    },
    async sql(_ref, sql) {
      sqlRan.push(sql);
      if (/syntax error/.test(sql)) return { ok: false, rowCount: 0, rows: [], error: 'syntax error at or near "x"' };
      return { ok: true, rowCount: 0, rows: [] };
    },
    async createBucket(_ref, name) {
      buckets.push(name);
    },
    async types() {
      return "export type Database = { public: { Tables: {\n      todos: {\n        Row: { id: string; title: string }\n      }\n  } } };\n";
    },
    async deployFunction(ref, slug) {
      return { url: `https://${ref}.base/functions/v1/${slug}` };
    },
  };
}

export const TEMPLATE_FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "app", private: true, dependencies: { next: "15.5.0", react: "19.1.0", "@supabase/supabase-js": "2.0.0" } }, null, 2) + "\n",
  "app/layout.tsx": 'import "./globals.css";\n\nexport const metadata = { title: "App" };\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n',
  "app/page.tsx": 'export default function Home() {\n  return <main className="p-8">Hello</main>;\n}\n',
  "app/globals.css": "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n:root {\n  --primary: 222 47% 11%;\n}\n",
  "components/ui/button.tsx": "export function Button() { return null; }\n",
  "lib/supabase.ts": 'import { createClient } from "@supabase/supabase-js";\nexport const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);\n',
};

export function tempWorkspace(files: Record<string, string> = TEMPLATE_FILES) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "bagents-"));
  const rootFor = (id: string) => path.join(base, id, "repo");
  const init = (id: string) => {
    const d = rootFor(id);
    fs.mkdirSync(d, { recursive: true });
    for (const [p, c] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(d, p)), { recursive: true });
      fs.writeFileSync(path.join(d, p), c);
    }
    const env = { ...process.env, GIT_AUTHOR_NAME: "Template", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "Template", GIT_COMMITTER_EMAIL: "t@x" };
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: d });
    execFileSync("git", ["add", "-A"], { cwd: d });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "Template"], { cwd: d, env });
    return d;
  };
  const gitLog = (id: string) =>
    execFileSync("git", ["log", "--format=%an|%s"], { cwd: rootFor(id) })
      .toString()
      .trim()
      .split("\n");
  return { base, rootFor, init, gitLog, workspace: gitWorkspace(rootFor), cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

export function makeRun(over: Partial<RunRecord> & { id: string; builderProjectId: string; message: string; mode?: RunMode }): RunRecord {
  return {
    teamId: "team1",
    createdById: "user1",
    mode: "build",
    status: "QUEUED",
    phase: null,
    attachments: [],
    plan: null,
    state: null,
    steps: [],
    error: null,
    summary: null,
    startCommit: null,
    endCommit: null,
    cancelRequested: false,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date(),
    ...over,
  };
}

export function testDeps(llm: LlmPort, ws: ReturnType<typeof tempWorkspace>, checks = fakeChecks(), backend = fakeBackend()) {
  const store = memoryStore();
  const bus = memoryBus();
  const deps: AgentDeps = { llm, workspace: ws.workspace, checks, backend, store, bus, sleep: async () => {} };
  return { deps, store, bus, checks, backend };
}
