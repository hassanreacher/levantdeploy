/**
 * Builder run orchestrator — a persisted, resumable state machine:
 *
 *   build: plan → backend? → design? → code (parallel file groups) → check & fix loop → summarize
 *   fix:   check & fix loop (seeded with the user's report) → summarize
 *   chat:  answer (read-only tools, no commits)
 *
 * Every phase checkpoints into BuilderRun.state; a restarted worker skips completed phases and resumes in-flight agent
 * conversations. A failing phase degrades the run instead of killing it ("if one agent fails the next continues") —
 * only cancellation, an exhausted budget or "no LLM at all" stop the pipeline early. Every step commits to the
 * workspace git with the role as author; when the checks cannot be made green the workspace is restored to the last
 * green commit (the broken attempt stays in history).
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentDeps } from "./adapters";
import { BudgetExceededError, RunCanceledError, RunContext, roleAuthor, runAgent } from "./agent";
import { applyEdits, diffStats, lineDiff, type Edit } from "./patch";
import { systemPrompt } from "./prompts";
import { parseJsonLoose } from "./repair";
import { safePath, toolsFor, walkFiles, contentGuard } from "./tools";
import {
  DEFAULT_BUDGETS,
  emptyState,
  LlmCallError,
  PLAN_JSON_SCHEMA,
  planSchema,
  type Budgets,
  type ChatResult,
  type ContentPart,
  type Phase,
  type Plan,
  type RunRecord,
  type RunState,
  type RunStatus,
} from "./types";

export type OrchestratorOptions = { budgets?: Partial<Budgets>; signal?: AbortSignal; codeConcurrency?: number };

const PHASES_BY_MODE: Record<RunRecord["mode"], Phase[]> = {
  build: ["plan", "backend", "design", "code", "check", "summarize"],
  fix: ["check", "summarize"],
  chat: ["answer"],
};

const PHASE_LABEL: Record<Phase, string> = {
  plan: "Planning",
  backend: "Setting up the backend",
  design: "Designing the theme",
  code: "Writing code",
  check: "Checking & fixing",
  summarize: "Summarizing",
  answer: "Answering",
  done: "Done",
};

/** Runs (or resumes) one builder run to a final status. Never throws except for programming errors. */
export async function executeRun(deps: AgentDeps, runId: string, opts: OrchestratorOptions = {}): Promise<RunStatus> {
  const store = deps.store;
  const run = await store.getRun(runId);
  if (!run) throw new Error(`BuilderRun ${runId} not found`);
  if (["SUCCEEDED", "FAILED", "CANCELED"].includes(run.status)) return run.status;

  const resumed = run.status === "RUNNING";
  const budgets = { ...DEFAULT_BUDGETS, ...(opts.budgets ?? {}) };
  const state = run.state ?? emptyState();
  run.steps ??= [];
  if (resumed) {
    state.resumes++;
    if (state.resumes > 3) {
      await finalize(deps, run, "FAILED", "The run was interrupted too many times (worker restarts). Try again.");
      return "FAILED";
    }
  }
  const ac = new AbortController();
  opts.signal?.addEventListener("abort", () => ac.abort(), { once: true });
  if (opts.signal?.aborted) ac.abort();

  // exactly one executor per run
  const owner = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  if (!(await store.acquireLease(runId, owner, LEASE_TTL_MS))) {
    deps.log?.(`run ${runId} is being executed elsewhere — skipping`);
    return run.status;
  }
  let leaseLost = false;
  const beat = setInterval(() => {
    store
      .renewLease(runId, owner, LEASE_TTL_MS)
      .then((ok) => {
        if (!ok) {
          leaseLost = true;
          ac.abort();
        }
      })
      .catch(() => {});
  }, LEASE_TTL_MS / 3);
  try {
    return await executeLeased(deps, run, state, budgets, resumed, ac, opts, () => leaseLost);
  } finally {
    clearInterval(beat);
    await store.releaseLease(runId, owner).catch(() => {});
  }
}

const LEASE_TTL_MS = 60_000;

async function executeLeased(
  deps: AgentDeps,
  run: RunRecord,
  state: RunState,
  budgets: Budgets,
  resumed: boolean,
  ac: AbortController,
  opts: OrchestratorOptions,
  leaseLost: () => boolean,
): Promise<RunStatus> {
  const store = deps.store;
  const runId = run.id;

  if (run.cancelRequested) {
    await finalize(deps, run, "CANCELED", null);
    return "CANCELED";
  }
  if (!resumed) {
    const ok = await store.transition(run.id, ["QUEUED"], "RUNNING", { startedAt: new Date(), state });
    if (!ok) return (await store.getRun(run.id))?.status ?? "FAILED";
  }

  const project = await store.projectContext(run.builderProjectId, run.id);
  const root = await deps.workspace.root(run.builderProjectId);
  const rc = new RunContext(deps, run, state, budgets, project, root, ac.signal);
  await rc.emit("status", { status: "RUNNING", resumed, mode: run.mode });
  if (resumed) await rc.emit("warning", { message: "The worker restarted — resuming the run from its last checkpoint." });

  if (!run.startCommit) {
    // make sure the starting point is committed (e.g. pending visual edits) so it can be restored
    await deps.workspace.commit(run.builderProjectId, { message: "Snapshot before AI run", author: roleAuthor("summarizer") }).catch(() => null);
    run.startCommit = await deps.workspace.head(run.builderProjectId);
    await store.updateRun(run.id, { startCommit: run.startCommit });
  }
  state.lastGreenCommit ??= run.startCommit;
  state.backendRef ??= project.baseRef;

  let fatal: string | null = null;
  try {
    for (const phase of PHASES_BY_MODE[run.mode]) {
      if (state.completed.includes(phase)) continue;
      await rc.assertActive();
      run.phase = phase;
      await rc.emit("phase", { phase, label: PHASE_LABEL[phase] });
      await rc.checkpoint();
      try {
        await PHASE_FNS[phase](rc, opts);
      } catch (e) {
        if (e instanceof RunCanceledError) throw e;
        if (e instanceof BudgetExceededError) {
          state.degraded.push(`budget: ${e.message}`);
          await rc.emit("warning", { message: `Run budget exhausted (${e.message}) — wrapping up.` });
          if (phase !== "summarize" && run.mode !== "chat") {
            state.completed.push(phase);
            await summarizePhase(rc, { ...opts, deterministic: true });
            state.completed.push("summarize");
          }
          break;
        }
        const msg = errMessage(e);
        state.degraded.push(`${phase}: ${msg}`);
        await rc.emit("error", { phase, message: msg });
        // no LLM at all → stop, nothing else can work
        if (e instanceof LlmCallError && e.allFailed && (phase === "plan" || phase === "answer" || !rc.state.usage.steps)) {
          fatal = `No AI provider could answer: ${msg}`;
          break;
        }
      }
      state.completed.push(phase);
      await rc.checkpoint();
    }
  } catch (e) {
    if (leaseLost()) {
      deps.log?.(`run ${runId}: lease lost — another executor took over; stopping without finalizing`);
      return "RUNNING";
    }
    if (e instanceof RunCanceledError || ac.signal.aborted) {
      const sha = await deps.workspace
        .commit(run.builderProjectId, { message: "Partial changes (run canceled)", author: roleAuthor("summarizer") })
        .catch(() => null);
      if (sha) await rc.emit("commit", { sha, message: "Partial changes (run canceled)", author: roleAuthor("summarizer").name });
      await finalize(deps, run, "CANCELED", null, rc);
      return "CANCELED";
    }
    fatal = errMessage(e);
  }

  if (fatal) {
    // restore whatever partial state to the last green commit
    await restoreToGreen(rc, "run failed").catch(() => {});
    await finalize(deps, run, "FAILED", fatal, rc);
    return "FAILED";
  }
  const status: RunStatus = state.checkFailed ? "FAILED" : "SUCCEEDED";
  await finalize(
    deps,
    run,
    status,
    state.checkFailed ? `Checks still failing after ${budgets.maxFixIterations} fix attempts — restored the last working version.` : null,
    rc,
  );
  return status;
}

function errMessage(e: unknown): string {
  return ((e as Error)?.message ?? String(e)).slice(0, 500);
}

async function finalize(deps: AgentDeps, run: RunRecord, status: RunStatus, error: string | null, rc?: RunContext) {
  const head = await deps.workspace.head(run.builderProjectId).catch(() => null);
  for (const s of run.steps ?? []) if (s.status === "running") s.status = status === "CANCELED" ? "skipped" : "failed";
  run.phase = "done";
  const patch = { finishedAt: new Date(), error, endCommit: head, phase: "done", steps: run.steps, state: rc?.state ?? run.state };
  const ok = await deps.store.transition(run.id, ["RUNNING", "QUEUED"], status, patch);
  if (!ok) await deps.store.updateRun(run.id, patch);
  await deps.store
    .updateProject(run.builderProjectId, { ...(head ? { lastCommit: head } : {}), status: status === "FAILED" && run.mode === "build" && !head ? "ERROR" : "READY" })
    .catch(() => {});
  if (status !== "SUCCEEDED" && run.mode !== "chat") {
    const already = rc?.state.completed.includes("summarize");
    if (!already) {
      const text =
        status === "CANCELED"
          ? "Stopped. The changes made so far are saved in the version history."
          : `Sorry — the run failed: ${error ?? "unknown error"}. Your app was kept at the last working version.`;
      await deps.store.writeAssistantMessage(run, text, head).catch(() => {});
      if (rc) await rc.emit("message", { content: text });
    }
  }
  const usage = rc?.state.usage;
  const ev = async (type: "usage" | "status", data: Record<string, unknown>) => {
    if (rc) return rc.emit(type, data);
    const e = await deps.store.appendEvent(run.id, type, data);
    await deps.bus.publish(run.id, e).catch(() => {});
  };
  if (usage) await ev("usage", { tokens: usage.tokens, steps: usage.steps, providers: usage.providers });
  await ev("status", { status, error, commit: head });
}

// ───────────────────────────── helpers ─────────────────────────────

async function projectSnapshot(rc: RunContext, opts: { withKeyFiles?: boolean } = {}): Promise<string> {
  const files = await walkFiles(rc.root, "", [], 400);
  const tree = files.map((f) => f.path).filter((p) => !p.startsWith("components/ui/"));
  const ui = files.filter((f) => f.path.startsWith("components/ui/")).map((f) => path.basename(f.path, path.extname(f.path)));
  let deps = "";
  try {
    const pj = JSON.parse(await fs.readFile(path.join(rc.root, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    deps = Object.keys(pj.dependencies ?? {}).join(", ");
  } catch {}
  const parts = [`Files:\n${tree.slice(0, 250).join("\n") || "(empty)"}`];
  if (ui.length) parts.push(`shadcn/ui components available (components/ui): ${ui.join(", ")}`);
  if (deps) parts.push(`Installed packages: ${deps}`);
  if (opts.withKeyFiles) {
    for (const f of ["app/page.tsx", "app/layout.tsx"]) {
      const c = await fs.readFile(path.join(rc.root, f), "utf8").catch(() => null);
      if (c) parts.push(`--- ${f} ---\n${c.slice(0, 3000)}`);
    }
  }
  return parts.join("\n\n");
}

function userContent(rc: RunContext, text: string): string | ContentPart[] {
  const images = (rc.run.attachments ?? []).filter((a) => a.url && (!a.type || a.type.startsWith("image")));
  if (!images.length) return text;
  return [{ type: "text", text }, ...images.slice(0, 4).map((a) => ({ type: "image_url" as const, image_url: { url: a.url } }))];
}

function historyText(rc: RunContext): string {
  const h = rc.project.history.slice(-6);
  if (!h.length) return "";
  return `Earlier conversation (oldest first):\n${h.map((m) => `${m.role}: ${m.content.slice(0, 600)}`).join("\n")}`;
}

function isFirstBuild(rc: RunContext) {
  return !rc.project.history.some((m) => m.role === "assistant");
}

/** Heuristic plan when the planner is unavailable (the coders still get the full request). */
export function fallbackPlan(message: string, firstBuild: boolean): Plan {
  const needsBackend = /\b(login|log in|sign ?up|sign ?in|auth|account|users?|database|save|store|persist|todo|crud|upload)\b/i.test(message);
  return planSchema.parse({
    summary: message.slice(0, 300),
    kind: firstBuild ? "new_app" : "feature",
    backend: { needed: needsBackend, auth: /\b(login|log in|sign ?up|sign ?in|auth|account)\b/i.test(message) },
    design: { update: firstBuild },
    files: [],
  });
}

export function normalizePlan(plan: Plan, firstBuild: boolean): Plan {
  const seen = new Set<string>();
  const files = plan.files
    .map((f) => ({ ...f, path: f.path.trim().replace(/^\.?\//, "").replace(/\\/g, "/") }))
    .filter((f) => f.path && !f.path.startsWith("components/ui/") && !/(^|\/)\.env/.test(f.path) && !f.path.includes("node_modules") && !f.path.startsWith(".."))
    .filter((f) => (seen.has(f.path) ? false : (seen.add(f.path), true)))
    .map((f) => ({ ...f, group: (f.group || "main").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 40) || "main" }));
  const out: Plan = { ...plan, files };
  if (firstBuild || plan.kind === "new_app") out.design = { ...plan.design, update: true };
  if (plan.backend.auth || plan.dataModel.length) out.backend = { ...plan.backend, needed: plan.backend.needed || plan.backend.auth || plan.dataModel.length > 0 };
  return out;
}

/** Groups the plan's files for parallel coders (max 6 groups; designer/backend-owned files excluded). */
export function codeGroups(plan: Plan): { name: string; files: Plan["files"] }[] {
  const owned = (p: string) => p.startsWith("supabase/") || p === "lib/database.types.ts";
  const map = new Map<string, Plan["files"]>();
  for (const f of plan.files) {
    if (owned(f.path)) continue;
    const list = map.get(f.group) ?? [];
    list.push(f);
    map.set(f.group, list);
  }
  let groups = [...map.entries()].map(([name, files]) => ({ name, files }));
  if (groups.length > 6) {
    const head = groups.slice(0, 5);
    head.push({ name: "rest", files: groups.slice(5).flatMap((g) => g.files) });
    groups = head;
  }
  return groups;
}

async function pLimit<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
      while (queue.length) await fn(queue.shift()!);
    }),
  );
}

async function restoreToGreen(rc: RunContext, reason: string) {
  const green = rc.state.lastGreenCommit;
  if (!green) return;
  // keep the attempt in history, then restore (a new commit whose tree equals the green one)
  await rc.commit("fixer", `WIP: ${reason} (kept for reference)`).catch(() => null);
  const head = await rc.deps.workspace.head(rc.projectId);
  if (head === green) return;
  const sha = await rc.deps.workspace.restore(rc.projectId, green, { message: `Restore last working version (${green.slice(0, 7)}) — ${reason}`, author: roleAuthor("fixer") });
  await rc.emit("restore", { sha, to: green, reason });
}

// ───────────────────────────── phases ─────────────────────────────

type PhaseFn = (rc: RunContext, opts: OrchestratorOptions & { deterministic?: boolean }) => Promise<void>;

async function planPhase(rc: RunContext) {
  await rc.stepStart("plan", "planner", "Planning");
  const first = isFirstBuild(rc);
  const snapshot = await projectSnapshot(rc, { withKeyFiles: !first });
  const text = [
    `User request:\n${rc.run.message}`,
    historyText(rc),
    rc.state.backendRef ? `A backend is already attached (ref ${rc.state.backendRef}).` : "No backend attached yet.",
    first ? "This is the FIRST build of the app (template only)." : "This is a follow-up change to an existing app — list only the files that change.",
    snapshot,
    "Return the plan JSON now.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const messages = [
    { role: "system" as const, content: systemPrompt("planner", { knowledge: rc.project.knowledge }) },
    { role: "user" as const, content: userContent(rc, text) },
  ];
  const parse = (r: ChatResult): Plan | null => {
    try {
      const raw = r.json ?? parseJsonLoose(r.content);
      const p = planSchema.safeParse(raw);
      return p.success && (p.data.files.length || p.data.summary) ? p.data : null;
    } catch {
      return null;
    }
  };

  let plan: Plan | null = null;
  // best-of-N on different providers + judge
  const candidates = await bestOfN(rc, "planner", { purpose: "plan", messages, jsonSchema: { name: "plan", schema: PLAN_JSON_SCHEMA }, temperature: 0.3 }, parse);
  if (candidates.length > 1) {
    const idx = await judgePick(
      rc,
      `Pick the best implementation plan for this request:\n${rc.run.message}`,
      candidates.map((c) => JSON.stringify(c.value, null, 1).slice(0, 6000)),
    );
    plan = candidates[idx].value;
    await rc.emit("thinking", { role: "judge", text: `Chose the plan from ${candidates[idx].provider} (${candidates.length} candidates).` });
  } else if (candidates.length === 1) plan = candidates[0].value;
  else {
    // single resilient call (retries across providers)
    for (let i = 0; i < 2 && !plan; i++) {
      const r = await rc.chat("planner", { purpose: "plan", messages, jsonSchema: { name: "plan", schema: PLAN_JSON_SCHEMA }, temperature: 0.2 });
      plan = parse(r);
    }
  }
  if (!plan) {
    plan = fallbackPlan(rc.run.message, first);
    rc.state.degraded.push("plan: planner output unusable — heuristic plan");
    await rc.emit("warning", { message: "The planner's answer could not be used — continuing with a simple plan." });
  }
  plan = normalizePlan(plan, first);
  rc.run.plan = plan;
  await rc.emit("plan", { plan });
  await rc.stepEnd("plan", "done", { detail: plan.summary.slice(0, 200) });
}

type Candidate<T> = { value: T; provider: string; model: string };

/** Runs the request on N different providers (llm.ensemble when available) and returns the parsable candidates. */
async function bestOfN<T>(rc: RunContext, role: "planner" | "fixer", req: Parameters<RunContext["chat"]>[1], parse: (r: ChatResult) => T | null): Promise<Candidate<T>[]> {
  const n = rc.budgets.ensembleSize;
  if (n < 2 || rc.budgetLeft().steps < n + 4) return [];
  const providers = await rc.deps.llm.providers(req.purpose, { teamId: rc.run.teamId }).catch(() => [] as string[]);
  if (providers.length < 2) return [];
  await rc.assertActive();
  let results: ({ ok: true; result: ChatResult } | { ok: false; error: string; provider?: string | null })[];
  if (rc.deps.llm.ensemble) {
    results = await rc.deps.llm.ensemble({ ...req, candidates: Math.min(n, providers.length), signal: rc.signal, teamId: rc.run.teamId, ref: { runId: rc.run.id, role } });
  } else {
    results = await Promise.all(
      providers.slice(0, n).map(async (p) => {
        try {
          return { ok: true as const, result: await rc.deps.llm.chat({ ...req, provider: p, signal: rc.signal, teamId: rc.run.teamId, ref: { runId: rc.run.id, role } }) };
        } catch (e) {
          return { ok: false as const, error: errMessage(e), provider: e instanceof LlmCallError ? e.provider : p };
        }
      }),
    );
  }
  if (rc.signal.aborted) throw new RunCanceledError();
  const out: Candidate<T>[] = [];
  for (const r of results) {
    if (!r.ok) {
      await rc.emit("warning", { role, message: `candidate on ${r.provider ?? "a provider"} failed: ${r.error.slice(0, 160)}` });
      continue;
    }
    const u = rc.state.usage;
    u.steps++;
    u.tokens += r.result.usage.inputTokens + r.result.usage.outputTokens;
    const pu = (u.providers[r.result.provider] ??= { calls: 0, inTok: 0, outTok: 0, failures: 0 });
    pu.calls++;
    pu.inTok += r.result.usage.inputTokens;
    pu.outTok += r.result.usage.outputTokens;
    await rc.emit("provider", { role, provider: r.result.provider, model: r.result.model, candidate: true });
    const v = parse(r.result);
    if (v !== null) out.push({ value: v, provider: r.result.provider, model: r.result.model });
  }
  return out;
}

/** Judge picks the best candidate (index). Falls back to 0 when the judge fails. */
async function judgePick(rc: RunContext, task: string, candidates: string[]): Promise<number> {
  try {
    if (rc.deps.llm.judge) {
      const v = await rc.deps.llm.judge(task, candidates, { criteria: "correctness, completeness, follows Next.js 15 / shadcn / Supabase RLS conventions, minimal", signal: rc.signal, teamId: rc.run.teamId, runId: rc.run.id });
      rc.state.usage.steps++;
      if (v.winner >= 0 && v.winner < candidates.length) {
        await rc.emit("thinking", { role: "judge", text: v.reasoning.slice(0, 500) });
        return v.winner;
      }
    }
    const r = await rc.chat("judge", {
      purpose: "judge",
      messages: [
        { role: "system", content: systemPrompt("judge") },
        { role: "user", content: `${task}\n\n${candidates.map((c, i) => `### Candidate ${i}\n${c}`).join("\n\n")}\n\nAnswer with JSON {"best": index, "reason": "..."}` },
      ],
      jsonSchema: { name: "verdict", schema: { type: "object", properties: { best: { type: "integer" }, reason: { type: "string" } }, required: ["best"] } },
      temperature: 0,
    }, { attempts: 2 });
    const v = (r.json ?? parseJsonLoose(r.content)) as { best?: number; reason?: string };
    if (typeof v.best === "number" && v.best >= 0 && v.best < candidates.length) {
      if (v.reason) await rc.emit("thinking", { role: "judge", text: v.reason.slice(0, 500) });
      return v.best;
    }
  } catch (e) {
    if (e instanceof RunCanceledError) throw e;
    await rc.emit("warning", { role: "judge", message: `judge unavailable (${errMessage(e).slice(0, 120)}) — using the first candidate` });
  }
  return 0;
}

async function backendPhase(rc: RunContext) {
  const plan = rc.run.plan;
  if (!plan?.backend.needed) return;
  await rc.stepStart("backend", "backend", "Backend: database, security & auth");
  if (!rc.state.backendRef) {
    try {
      const b = await rc.deps.backend.attach(rc.projectId, { teamId: rc.run.teamId, userId: rc.run.createdById });
      rc.state.backendRef = b.ref;
      rc.state.notes.backendUrl = b.url;
      await rc.deps.store.updateProject(rc.projectId, { baseRef: b.ref });
      await rc.emit("backend", { ref: b.ref, url: b.url, action: "attached" });
      await rc.checkpoint();
    } catch (e) {
      await rc.stepEnd("backend", "failed", { detail: errMessage(e) });
      rc.state.notes.backend = `NO BACKEND: creating the backend failed (${errMessage(e)}). Build the UI so it degrades gracefully.`;
      throw e;
    }
  }
  const ref = rc.state.backendRef!;
  const task = [
    `User request:\n${rc.run.message}`,
    `Plan summary: ${plan.summary}`,
    `Data model:\n${plan.dataModel.map((t) => `- ${t.table}${t.ownerScoped ? " (owned by the signed-in user)" : ""}: ${t.columns.join(", ")}`).join("\n") || "(derive it from the request)"}`,
    `Auth needed: ${plan.backend.auth ? "yes — build the login/sign-up page and a sign-out control" : "no"}`,
    plan.backend.storageBuckets.length ? `Storage buckets: ${plan.backend.storageBuckets.join(", ")}` : "",
    plan.backend.notes ? `Notes: ${plan.backend.notes}` : "",
    `Files planned for you or related: ${plan.files.filter((f) => f.path.startsWith("supabase/") || f.group === "auth" || f.path.includes("login")).map((f) => f.path).join(", ") || "(none listed)"}`,
    "Other files (pages/components) are written by the Coders after you — finish with a summary they can rely on (tables, columns, helpers, auth components).",
  ]
    .filter(Boolean)
    .join("\n\n");
  const res = await runAgent(rc, {
    key: "backend",
    role: "backend",
    purpose: "code",
    system: systemPrompt("backend", { knowledge: rc.project.knowledge, backend: { ref, url: rc.state.notes.backendUrl ?? "" } }),
    user: task,
    tools: toolsFor("backend"),
    mustWrite: false,
    maxTurns: Math.max(rc.budgets.maxTurns, 30),
  });
  // make sure the typed client exists when the schema changed
  const typesFile = path.join(rc.root, "lib/database.types.ts");
  const hasTypes = await fs.stat(typesFile).then(() => true).catch(() => false);
  if (!hasTypes || res.changed.some((p) => p.startsWith("supabase/migrations/"))) {
    try {
      const ts = await rc.deps.backend.types(ref);
      const before = await fs.readFile(typesFile, "utf8").catch(() => null);
      if (before !== ts) {
        await fs.mkdir(path.dirname(typesFile), { recursive: true });
        await fs.writeFile(typesFile, ts);
        await rc.emit("file", { role: "backend", path: "lib/database.types.ts", action: before === null ? "create" : "modify", diff: lineDiff(before ?? "", ts, { maxLines: 60 }) });
      }
    } catch (e) {
      await rc.emit("warning", { role: "backend", message: `type generation failed: ${errMessage(e).slice(0, 200)}` });
    }
  }
  rc.state.notes.backend = res.text || "Backend ready.";
  const sha = await rc.commit("backend", `Backend: ${plan.dataModel.map((t) => t.table).join(", ") || "schema"}${plan.backend.auth ? " + auth" : ""}`);
  await rc.stepEnd("backend", "done", { commitSha: sha, detail: res.text.slice(0, 300) });
}

async function designPhase(rc: RunContext) {
  const plan = rc.run.plan;
  if (!plan?.design.update) return;
  await rc.stepStart("design", "designer", "Design system & layout");
  const task = [
    `User request:\n${rc.run.message}`,
    `Plan summary: ${plan.summary}`,
    `Style: ${plan.design.style || "derive from the request"}${plan.design.palette ? `; palette: ${plan.design.palette}` : ""}`,
    `Pages that will be built: ${plan.pages.map((p) => p.route).join(", ") || "/"}`,
    await projectSnapshot(rc),
  ].join("\n\n");
  const res = await runAgent(rc, {
    key: "design",
    role: "designer",
    purpose: "code",
    system: systemPrompt("designer", { knowledge: rc.project.knowledge }),
    user: userContent(rc, task),
    tools: toolsFor("designer"),
    mustWrite: true,
    writeAllow: {
      re: /^(app\/globals\.css|tailwind\.config\.ts|app\/layout\.tsx|components\/(site|layout)-[\w-]+\.tsx|public\/.+)$/,
      why: "the Designer only edits app/globals.css, tailwind.config.ts, app/layout.tsx and components/site-*.tsx; pages are written by the Coders next",
    },
  });
  rc.state.notes.design = res.text || "Theme updated in app/globals.css.";
  const sha = await rc.commit("designer", `Design: ${plan.design.style ? plan.design.style.slice(0, 60) : "theme & layout"}`);
  await rc.stepEnd("design", "done", { commitSha: sha, detail: res.text.slice(0, 300) });
}

async function codePhase(rc: RunContext, opts: OrchestratorOptions) {
  const plan = rc.run.plan ?? fallbackPlan(rc.run.message, isFirstBuild(rc));
  let groups = codeGroups(plan);
  if (!groups.length) groups = [{ name: "main", files: [] }];
  const allFiles = plan.files.map((f) => `- ${f.path} [${f.action}] (${f.group}) ${f.purpose}`).join("\n");
  const snapshot = await projectSnapshot(rc);
  const failed: string[] = [];

  const runGroup = async (g: { name: string; files: Plan["files"] }, attempt: number, exclude?: string[]) => {
    const key = `code:${g.name}${attempt ? `:retry${attempt}` : ""}`;
    if (rc.state.groupsDone.includes(g.name)) return;
    await rc.stepStart(`code:${g.name}`, "coder", `Code: ${g.name}`);
    const task = [
      `User request:\n${rc.run.message}`,
      historyText(rc),
      `Plan summary: ${plan.summary}`,
      `Whole plan (other coders write the other groups in parallel — you may import their components by the planned paths/names):\n${allFiles || "(no file list — implement the request)"}`,
      g.files.length ? `YOUR files (group "${g.name}"):\n${g.files.map((f) => `- ${f.path} [${f.action}] ${f.purpose}`).join("\n")}` : "Implement the user request (decide the files yourself).",
      plan.components.length ? `Components planned: ${plan.components.map((c) => `${c.name} — ${c.purpose}`).join("; ")}` : "",
      rc.state.notes.design ? `Designer notes: ${rc.state.notes.design.slice(0, 1500)}` : "",
      rc.state.notes.backend ? `Backend notes: ${rc.state.notes.backend.slice(0, 2500)}` : rc.state.backendRef ? `Backend attached (ref ${rc.state.backendRef}).` : "No backend: do not use supabase.",
      snapshot,
    ]
      .filter(Boolean)
      .join("\n\n");
    try {
      const res = await runAgent(rc, {
        key,
        role: "coder",
        purpose: "code",
        system: systemPrompt("coder", { knowledge: rc.project.knowledge, backend: rc.state.backendRef ? { ref: rc.state.backendRef, url: rc.state.notes.backendUrl ?? "" } : null }),
        user: userContent(rc, task),
        tools: toolsFor("coder", { backend: false }),
        mustWrite: true,
        excludeProviders: exclude,
      });
      const sha = await rc.commit("coder", `Code (${g.name}): ${(res.text || g.files.map((f) => f.path).join(", ")).split("\n")[0].slice(0, 90)}`, res.changed.length ? res.changed : undefined);
      rc.state.groupsDone.push(g.name);
      await rc.stepEnd(`code:${g.name}`, "done", { commitSha: sha, detail: res.text.slice(0, 300) });
    } catch (e) {
      if (e instanceof RunCanceledError || e instanceof BudgetExceededError) throw e;
      failed.push(g.name);
      await rc.stepEnd(`code:${g.name}`, "failed", { detail: errMessage(e) });
      await rc.emit("error", { role: "coder", message: `group ${g.name} failed: ${errMessage(e)}` });
    }
    await rc.checkpoint();
  };

  // parallel coders only when there is more than one provider (free-tier rate limits otherwise just double the 429s)
  let concurrency = opts.codeConcurrency;
  if (!concurrency) {
    const ps = await rc.deps.llm.providers("code", { teamId: rc.run.teamId, needTools: true }).catch(() => [] as string[]);
    concurrency = new Set(ps.map((p) => p.split("/")[0])).size >= 2 ? 2 : 1;
  }
  await pLimit(groups, concurrency, (g) => runGroup(g, 0));
  // second chance for failed groups (sequential, fresh conversation; the router picks the healthiest providers)
  const retry = groups.filter((g) => failed.includes(g.name));
  failed.length = 0;
  for (const g of retry) await runGroup(g, 1);
  if (failed.length) rc.state.degraded.push(`code: groups failed: ${failed.join(", ")}`);
  // anything left uncommitted (e.g. a crashed group) goes into one commit
  await rc.commit("coder", "Code: remaining changes").catch(() => null);
}

const ERROR_LINE = /(error|failed|cannot|can't|unexpected|not assignable|does not exist|is not defined|warning:)/i;

function condenseErrors(out: string, max = 7000): string {
  const lines = out.split("\n");
  const keep = lines.filter((l) => ERROR_LINE.test(l) || /\.(tsx?|jsx?|css):?\(?\d+/.test(l));
  const text = keep.length >= 1 && keep.join("\n").length > 50 ? keep.join("\n") : out;
  return text.length > max ? text.slice(0, max) + "\n…" : text;
}

function signature(errors: string) {
  return errors
    .split("\n")
    .filter((l) => ERROR_LINE.test(l))
    .map((l) => l.replace(/\(\d+,\d+\)|:\d+:\d+/g, "").trim())
    .sort()
    .join("|")
    .slice(0, 4000);
}

async function runChecks(rc: RunContext, iteration: number): Promise<{ ok: boolean; errors: string; skippedAll: boolean }> {
  const failures: string[] = [];
  let skipped = 0;
  let ran = 0;
  for (const kind of ["typecheck", "lint", "build"] as const) {
    if (kind === "build" && failures.length) break; // build only once typecheck + lint pass
    await rc.assertActive();
    const r = await rc.deps.checks.run(rc.projectId, kind, { signal: rc.signal });
    ran++;
    if (r.skipped) skipped++;
    await rc.emit("check", { kind, ok: r.ok, skipped: !!r.skipped, iteration, output: r.output.slice(-3000) });
    if (!r.ok) failures.push(`### ${kind} failed\n${condenseErrors(r.output)}`);
  }
  const preview = await rc.deps.checks.previewErrors(rc.projectId).catch(() => [] as string[]);
  if (preview.length) {
    await rc.emit("check", { kind: "preview", ok: false, iteration, output: preview.slice(0, 5).join("\n---\n").slice(0, 3000) });
    failures.push(`### preview runtime errors\n${preview.slice(0, 5).join("\n---\n").slice(0, 3000)}`);
  }
  return { ok: failures.length === 0, errors: failures.join("\n\n"), skippedAll: skipped === ran };
}

async function checkPhase(rc: RunContext) {
  const max = rc.budgets.maxFixIterations;
  await rc.deps.checks.prepare?.(rc.projectId).catch(() => {});
  let prevSig = rc.state.lastErrors ? signature(rc.state.lastErrors) : "";
  let userFixDone = rc.run.mode !== "fix";
  for (let i = rc.state.checkIteration; i <= max; i++) {
    await rc.assertActive();
    await rc.stepStart(`check:${i}`, "fixer", i === 0 ? "Checks (typecheck, lint, build)" : `Re-check #${i}`);
    const r = await runChecks(rc, i);
    if (r.ok && userFixDone) {
      const sha = await rc.commit("fixer", i === 0 ? "Checks passed" : `Checks passed after ${i} fix iteration${i > 1 ? "s" : ""}`);
      rc.state.lastGreenCommit = sha ?? (await rc.deps.workspace.head(rc.projectId)) ?? rc.state.lastGreenCommit;
      rc.state.lastErrors = null;
      await rc.stepEnd(`check:${i}`, "done", { commitSha: sha, detail: r.skippedAll ? "checks skipped (no runtime)" : "all checks passed" });
      return;
    }
    await rc.stepEnd(`check:${i}`, r.ok ? "done" : "failed", { detail: r.ok ? "checks passed" : r.errors.split("\n")[1]?.slice(0, 200) });
    if (i === max) break;

    const sig = signature(r.errors);
    const repeated = !!sig && sig === prevSig;
    const hard = !r.ok && (i >= 2 || repeated);
    prevSig = sig;
    rc.state.lastErrors = r.errors || null;
    await rc.stepStart(`fix:${i}`, "fixer", hard ? `Fix #${i + 1} (best-of-N)` : `Fix #${i + 1}`);
    let fixed = false;
    if (hard) fixed = await ensembleFix(rc, r.errors, i).catch((e) => {
      if (e instanceof RunCanceledError || e instanceof BudgetExceededError) throw e;
      return false;
    });
    if (!fixed) {
      const report = !userFixDone ? `The user reports:\n${rc.run.message}\n\n` : "";
      userFixDone = true;
      await runAgent(rc, {
        key: `fix:${i}`,
        role: "fixer",
        purpose: "fix",
        system: systemPrompt("fixer", { knowledge: rc.project.knowledge, backend: rc.state.backendRef ? { ref: rc.state.backendRef, url: rc.state.notes.backendUrl ?? "" } : null }),
        user: userContent(
          rc,
          `${report}${r.ok ? "All automatic checks pass — fix the reported problem." : `Fix these errors with minimal changes:\n\n${r.errors}`}${repeated ? "\n\nNOTE: the previous attempt did not change these errors — try a different approach." : ""}`,
        ),
        tools: toolsFor("fixer", { backend: !!rc.state.backendRef }),
        mustWrite: true,
        iteration: i,
        maxTurns: 16,
      });
    }
    const lines = r.errors.split("\n");
    const first = lines.find((l) => /\.(tsx?|jsx?|css|mjs)[:(]\d/.test(l)) ?? lines[1];
    const sha = await rc.commit("fixer", `Fix #${i + 1}: ${first?.trim().replace(/^\.\//, "").slice(0, 100) || "reported issue"}`);
    rc.state.checkIteration = i + 1;
    await rc.stepEnd(`fix:${i}`, "done", { commitSha: sha });
  }
  // still red
  rc.state.checkFailed = true;
  await rc.emit("error", { role: "fixer", message: `Checks still failing after ${max} fix attempts.`, errors: (rc.state.lastErrors ?? "").slice(0, 3000) });
  await restoreToGreen(rc, "checks failing");
}

/** Hard fix: N providers propose search/replace edits (JSON) for the failing files, the judge picks, we apply. */
async function ensembleFix(rc: RunContext, errors: string, iteration: number): Promise<boolean> {
  const paths = [...new Set([...errors.matchAll(/((?:app|components|lib|hooks|src|pages|styles|types|utils)\/[\w./()[\]@-]+\.(?:tsx?|jsx?|css|json|mjs))/g)].map((m) => m[1]))].slice(0, 6);
  if (!paths.length) return false;
  const files: Record<string, string> = {};
  let total = 0;
  for (const p of paths) {
    const { abs } = await safePath(rc.root, p).catch(() => ({ abs: "" }));
    if (!abs) continue;
    const c = await fs.readFile(abs, "utf8").catch(() => null);
    if (c === null || total + c.length > 60_000) continue;
    files[p] = c;
    total += c.length;
  }
  if (!Object.keys(files).length) return false;
  const schema = {
    type: "object",
    properties: {
      explanation: { type: "string" },
      edits: { type: "array", items: { type: "object", properties: { path: { type: "string" }, search: { type: "string" }, replace: { type: "string" } }, required: ["path", "search", "replace"] } },
    },
    required: ["edits"],
  };
  const messages = [
    { role: "system" as const, content: systemPrompt("fixer", { knowledge: rc.project.knowledge }) },
    {
      role: "user" as const,
      content: `Errors:\n${errors}\n\nFiles:\n${Object.entries(files).map(([p, c]) => `--- ${p} ---\n${c}`).join("\n\n")}\n\nReturn JSON {"explanation": "...", "edits": [{"path", "search", "replace"}]} — search must be exact lines from the files above, as small as possible. Fix the root cause.`,
    },
  ];
  type Fix = { edits: (Edit & { path: string })[]; explanation: string; results: Record<string, string> };
  const parse = (r: ChatResult): Fix | null => {
    try {
      const v = (r.json ?? parseJsonLoose(r.content)) as { edits?: (Edit & { path: string })[]; explanation?: string };
      if (!Array.isArray(v.edits) || !v.edits.length) return null;
      const results: Record<string, string> = {};
      for (const e of v.edits) {
        if (typeof e.path !== "string" || typeof e.search !== "string" || typeof e.replace !== "string") return null;
        const p = e.path.replace(/^\.?\//, "");
        const base = results[p] ?? files[p];
        if (base === undefined) return null;
        results[p] = applyEdits(base, [e]).content;
      }
      return { edits: v.edits, explanation: v.explanation ?? "", results };
    } catch {
      return null;
    }
  };
  const cands = await bestOfN(rc, "fixer", { purpose: "fix", messages, jsonSchema: { name: "fix", schema }, temperature: 0.2 }, parse);
  if (!cands.length) return false;
  const idx =
    cands.length > 1
      ? await judgePick(
          rc,
          `Which candidate fix resolves these errors correctly with the smallest change?\n${errors.slice(0, 3000)}`,
          cands.map((c) => `${c.value.explanation}\n${c.value.edits.map((e) => `${e.path}:\n- ${e.search.slice(0, 600)}\n+ ${e.replace.slice(0, 600)}`).join("\n")}`.slice(0, 5000)),
        )
      : 0;
  const chosen = cands[idx];
  for (const [p, content] of Object.entries(chosen.value.results)) {
    const guard = contentGuard(p, content);
    if (guard) return false;
    const { abs } = await safePath(rc.root, p, { write: true });
    const before = files[p];
    await fs.writeFile(abs, content);
    const diff = lineDiff(before, content, { maxLines: 200 });
    await rc.emit("file", { role: "fixer", path: p, action: "modify", diff, ...diffStats(diff), via: `best-of-${cands.length} (${chosen.provider})`, iteration });
  }
  await rc.emit("thinking", { role: "fixer", text: `Applied the fix from ${chosen.provider}/${chosen.model}: ${chosen.value.explanation.slice(0, 400)}` });
  return true;
}

async function summarizePhase(rc: RunContext, opts: { deterministic?: boolean } = {}) {
  await rc.stepStart("summarize", "summarizer", "Summary");
  const plan = rc.run.plan;
  const changed = [...new Set(Object.values(rc.state.agents).flatMap((a) => a.changed ?? []))];
  const facts = [
    `User request: ${rc.run.message}`,
    plan ? `Plan: ${plan.summary}` : "",
    changed.length ? `Files changed (${changed.length}): ${changed.slice(0, 30).join(", ")}` : "No files changed.",
    rc.state.backendRef ? `Backend: ${rc.state.notes.backend?.slice(0, 800) ?? `attached (${rc.state.backendRef})`}` : "",
    rc.state.checkFailed ? `Checks FAILED after all fix attempts; the app was restored to the last working version. Last errors:\n${(rc.state.lastErrors ?? "").slice(0, 800)}` : "Checks: passed.",
    rc.state.degraded.length ? `Problems along the way: ${rc.state.degraded.join("; ").slice(0, 600)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  let text = "";
  if (!opts.deterministic) {
    try {
      const r = await rc.chat("summarizer", { purpose: "fast", messages: [{ role: "system", content: systemPrompt("summarizer") }, { role: "user", content: facts }], temperature: 0.4, maxTokens: 600 }, { attempts: 3, ignoreBudget: true });
      text = r.content.trim();
    } catch (e) {
      if (e instanceof RunCanceledError) throw e;
    }
  }
  if (!text) {
    text = rc.state.checkFailed
      ? `I worked on "${rc.run.message.slice(0, 80)}" but couldn't get the app to pass its checks, so I restored the last working version. The attempt is saved in the history.`
      : `Done: ${plan?.summary || rc.run.message.slice(0, 120)}${changed.length ? ` (${changed.length} files changed)` : ""}.`;
  }
  const sha = (await rc.commit("summarizer", (plan?.summary || rc.run.message).split("\n")[0].slice(0, 100))) ?? (await rc.deps.workspace.head(rc.projectId));
  await rc.deps.store.writeAssistantMessage(rc.run, text, sha);
  await rc.deps.store.updateRun(rc.run.id, { summary: text });
  await rc.emit("message", { content: text, commit: sha });
  await rc.stepEnd("summarize", "done", { commitSha: sha });
}

async function answerPhase(rc: RunContext) {
  await rc.stepStart("answer", "chat", "Answering");
  const res = await runAgent(rc, {
    key: "answer",
    role: "chat",
    purpose: "chat",
    system: systemPrompt("chat", { knowledge: rc.project.knowledge, backend: rc.state.backendRef ? { ref: rc.state.backendRef, url: "" } : null }),
    user: userContent(rc, [historyText(rc), `Question:\n${rc.run.message}`, await projectSnapshot(rc)].filter(Boolean).join("\n\n")),
    tools: toolsFor("chat"),
    maxTurns: 10,
  });
  const text = res.text.trim() || "I couldn't find an answer — could you rephrase the question?";
  await rc.deps.store.writeAssistantMessage(rc.run, text, null);
  await rc.deps.store.updateRun(rc.run.id, { summary: text });
  await rc.emit("message", { content: text });
  await rc.stepEnd("answer", "done");
}

const PHASE_FNS: Record<Phase, PhaseFn> = {
  plan: planPhase,
  backend: backendPhase,
  design: designPhase,
  code: codePhase,
  check: checkPhase,
  summarize: summarizePhase,
  answer: answerPhase,
  done: async () => {},
};
