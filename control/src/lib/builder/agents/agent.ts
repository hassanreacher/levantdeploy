/**
 * Run context (budgets, cancellation, resilient LLM calls, events, checkpoints) + the generic tool-calling agent loop.
 *
 * Resilience model (BUILDER-SPEC "Router & resilience"):
 *  - the llm router already falls back between providers/models inside one `chat` call;
 *  - if a call still fails, `RunContext.chat` retries the SAME step with the failed provider excluded (then with
 *    backoff), so a step never depends on one provider;
 *  - the conversation is provider-agnostic (OpenAI-shaped, tool results as text) and checkpointed after every turn,
 *    so the next provider — or a restarted worker — continues exactly where the last one stopped.
 */
import type { AgentDeps } from "./adapters";
import { repairToolCalls } from "./repair";
import { executeTool, toolSchemas, type ToolCtx, type ToolDef } from "./tools";
import {
  LlmCallError,
  type AgentCheckpoint,
  type Budgets,
  type ChatRequest,
  type ChatResult,
  type ContentPart,
  type Msg,
  type ProjectContext,
  type Role,
  type RunEventType,
  type RunRecord,
  type RunState,
  type StepItem,
} from "./types";

export class RunCanceledError extends Error {
  constructor() {
    super("Run canceled");
  }
}
export class BudgetExceededError extends Error {}

/** Commit author per role — builder-core's history UI classifies `agent:<role>` authors as agent commits. */
export const roleAuthor = (role: Role) => ({ name: `agent:${role}`, email: `${role}@agents.levantdeploy.local` });

export class RunContext {
  private lastProviderByRole = new Map<string, string>();
  private commitChain: Promise<unknown> = Promise.resolve();
  private lastCancelCheck = 0;

  constructor(
    public deps: AgentDeps,
    public run: RunRecord,
    public state: RunState,
    public budgets: Budgets,
    public project: ProjectContext,
    public root: string,
    public signal: AbortSignal,
  ) {}

  get projectId() {
    return this.run.builderProjectId;
  }

  sleep(ms: number) {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms));
  }

  async emit(type: RunEventType, data: Record<string, unknown>) {
    try {
      const ev = await this.deps.store.appendEvent(this.run.id, type, data);
      await this.deps.bus.publish(this.run.id, ev).catch(() => {});
    } catch (e) {
      this.deps.log?.("emit failed", (e as Error).message);
    }
  }

  async checkpoint() {
    await this.deps.store.updateRun(this.run.id, { state: this.state, steps: this.run.steps, plan: this.run.plan, phase: this.run.phase });
  }

  /** throws RunCanceledError when the run was canceled (abort signal or DB flag, polled at most every 2 s) */
  async assertActive() {
    if (this.signal.aborted) throw new RunCanceledError();
    const now = Date.now();
    if (now - this.lastCancelCheck < 2000) return;
    this.lastCancelCheck = now;
    if (await this.deps.store.isCancelRequested(this.run.id).catch(() => false)) throw new RunCanceledError();
  }

  budgetLeft() {
    return { steps: this.budgets.maxSteps - this.state.usage.steps, tokens: this.budgets.maxTokens - this.state.usage.tokens };
  }

  private account(res: ChatResult | null, provider: string | null, failed: boolean) {
    const u = this.state.usage;
    if (res) {
      u.steps++;
      u.tokens += res.usage.inputTokens + res.usage.outputTokens;
    }
    const id = provider ?? res?.provider;
    if (!id) return;
    const p = (u.providers[id] ??= { calls: 0, inTok: 0, outTok: 0, failures: 0 });
    if (res) {
      p.calls++;
      p.inTok += res.usage.inputTokens;
      p.outTok += res.usage.outputTokens;
    }
    if (failed) p.failures++;
  }

  /**
   * One LLM step with orchestrator-level resilience: on failure retry with the failed provider excluded, then with
   * exponential backoff (all providers cooling down), up to `attempts` times.
   */
  async chat(role: Role, req: Omit<ChatRequest, "signal" | "teamId" | "ref">, opts: { attempts?: number; ignoreBudget?: boolean; maxWaitMs?: number } = {}): Promise<ChatResult> {
    // provider-specific failures: retry on another provider up to `attempts` times; global cooldowns (every
    // candidate rate-limited / all failed): wait with backoff for up to `maxWaitMs` in total
    const attempts = opts.attempts ?? 5;
    const maxWaitMs = opts.maxWaitMs ?? 4 * 60_000;
    const excluded = new Set(req.excludeProviders ?? []);
    let lastErr: Error | null = null;
    let failures = 0;
    let waits = 0;
    let waited = 0;
    for (let i = 0; ; i++) {
      await this.assertActive();
      const left = this.budgetLeft();
      if (!opts.ignoreBudget && (left.steps <= 0 || left.tokens <= 0)) throw new BudgetExceededError(left.steps <= 0 ? "step budget exhausted" : "token budget exhausted");
      try {
        const res = await this.deps.llm.chat({
          ...req,
          excludeProviders: [...excluded],
          signal: this.signal,
          teamId: this.run.teamId,
          ref: { builderProjectId: this.run.builderProjectId, runId: this.run.id, role },
        });
        this.account(res, null, false);
        const prev = this.lastProviderByRole.get(role);
        if (prev !== `${res.provider}/${res.model}` || res.fallbacks?.length || i > 0) {
          await this.emit("provider", {
            role,
            provider: res.provider,
            model: res.model,
            fallbacks: res.fallbacks ?? [],
            ...(i > 0 ? { retriedAfter: lastErr?.message.slice(0, 200) ?? null, attempt: i + 1 } : {}),
          });
          this.lastProviderByRole.set(role, `${res.provider}/${res.model}`);
        }
        return res;
      } catch (e) {
        if (this.signal.aborted) throw new RunCanceledError();
        lastErr = e as Error;
        const err = e instanceof LlmCallError ? e : new LlmCallError((e as Error).message ?? String(e));
        this.account(null, err.provider, true);
        if (!err.retryable) throw err;
        let delay: number;
        if (err.allFailed) {
          // every provider failed / cooling down: clear exclusions and back off (bounded by maxWaitMs)
          excluded.clear();
          for (const x of req.excludeProviders ?? []) excluded.add(x);
          delay = Math.min(60_000, Math.max(err.retryAfterMs ?? 0, 5000 * 2 ** waits));
          waits++;
          if (waited + delay > maxWaitMs) {
            await this.emit("warning", { role, message: `all AI providers are unavailable (${err.message.slice(0, 160)}) — giving up on this step`, attempt: i + 1 });
            throw err;
          }
          waited += delay;
          await this.emit("warning", { role, message: `all AI providers are busy or rate-limited — waiting ${Math.round(delay / 1000)}s and retrying`, attempt: i + 1 });
        } else {
          failures++;
          if (err.provider) excluded.add(err.provider);
          const last = failures >= attempts;
          await this.emit("warning", {
            role,
            message: `${err.provider ?? "LLM"} failed (${err.message.slice(0, 160)}) — ${last ? "giving up on this step" : "retrying with another provider"}`,
            provider: err.provider,
            attempt: i + 1,
          });
          if (last) throw err;
          delay = 300 * failures;
        }
        await this.sleep(delay);
      }
    }
  }

  /** commits are serialised (parallel coders) */
  commit(role: Role, message: string, paths?: string[]): Promise<string | null> {
    const p = this.commitChain.then(async () => {
      const sha = await this.deps.workspace.commit(this.projectId, { message, author: roleAuthor(role), ...(paths ? { paths } : {}) });
      if (sha) await this.emit("commit", { sha, message, author: roleAuthor(role).name });
      return sha;
    });
    this.commitChain = p.catch(() => {});
    return p;
  }

  async stepStart(key: string, role: Role, title: string) {
    const existing = this.run.steps.find((s) => s.key === key);
    if (existing) Object.assign(existing, { status: "running", title });
    else this.run.steps.push({ key, role, title, status: "running", startedAt: new Date().toISOString() });
    await this.checkpoint();
  }

  async stepEnd(key: string, status: StepItem["status"], extra: { commitSha?: string | null; detail?: string } = {}) {
    const s = this.run.steps.find((x) => x.key === key);
    if (s) Object.assign(s, { status, finishedAt: new Date().toISOString() }, extra.commitSha !== undefined ? { commitSha: extra.commitSha } : {}, extra.detail ? { detail: extra.detail } : {});
    await this.checkpoint();
  }

  toolCtx(role: Role, changed: Set<string>, iteration?: number): ToolCtx {
    return {
      deps: this.deps,
      run: this.run,
      projectId: this.projectId,
      root: this.root,
      role,
      signal: this.signal,
      emit: (type, data) => this.emit(type, data),
      baseRef: () => this.state.backendRef ?? this.project.baseRef,
      changed,
      iteration,
    };
  }
}

// ───────────────────────────── message compaction ─────────────────────────────

const msgSize = (m: Msg) =>
  (typeof m.content === "string" ? m.content.length : m.content.reduce((n, p) => n + (p.type === "text" ? p.text.length : 1000), 0)) +
  (m.role === "assistant" ? (m.toolCalls ?? []).reduce((n, t) => n + t.arguments.length, 0) : 0);

/** Shrinks old tool results / big tool-call arguments when the conversation grows beyond `maxChars`. */
export function compactMessages(messages: Msg[], maxChars = 140_000, keepTail = 8): Msg[] {
  let total = messages.reduce((n, m) => n + msgSize(m), 0);
  if (total <= maxChars) return messages;
  const out = messages.map((m) => ({ ...m })) as Msg[];
  for (let i = 2; i < out.length - keepTail && total > maxChars; i++) {
    const m = out[i];
    const before = msgSize(m);
    if (m.role === "tool" && m.content.length > 400) {
      out[i] = { ...m, content: `${m.content.slice(0, 300)}\n… [older tool output truncated — call the tool again if you need it]` };
    } else if (m.role === "assistant" && m.toolCalls?.some((t) => t.arguments.length > 600)) {
      out[i] = {
        ...m,
        toolCalls: m.toolCalls.map((t) => {
          if (t.arguments.length <= 600) return t;
          let path = "";
          try {
            path = String((JSON.parse(t.arguments) as { path?: string }).path ?? "");
          } catch {}
          return { ...t, arguments: JSON.stringify({ path, note: `[${t.arguments.length} chars of arguments omitted]` }) };
        }),
      };
    } else if (m.role === "assistant" && m.content.length > 1500) {
      out[i] = { ...m, content: `${m.content.slice(0, 600)} …[truncated]` };
    }
    total -= before - msgSize(out[i]);
  }
  return out;
}

// ───────────────────────────── agent loop ─────────────────────────────

export type AgentSpec = {
  /** checkpoint key, unique per run ("design", "code:home", "fix:2") */
  key: string;
  role: Role;
  purpose: string;
  system: string;
  user: string | ContentPart[];
  tools: ToolDef[];
  maxTurns?: number;
  /** writer roles get nudged when they answer without touching files */
  mustWrite?: boolean;
  /** pin/exclude providers (best-of-N) */
  provider?: string;
  excludeProviders?: string[];
  iteration?: number;
  temperature?: number;
  writeAllow?: ToolCtx["writeAllow"];
};

export type AgentResult = { text: string; finished: boolean; turns: number; changed: string[] };

export async function runAgent(rc: RunContext, spec: AgentSpec): Promise<AgentResult> {
  const existing = rc.state.agents[spec.key];
  if (existing?.done) return { text: existing.summary ?? "", finished: true, turns: existing.turns, changed: existing.changed ?? [] };
  const cp: AgentCheckpoint =
    existing ??
    (rc.state.agents[spec.key] = {
      key: spec.key,
      role: spec.role,
      messages: [
        { role: "system", content: spec.system },
        { role: "user", content: spec.user },
      ],
      turns: 0,
      done: false,
      changed: [],
    });
  if (existing && !existing.done) {
    cp.messages.push({ role: "user", content: "(The session was interrupted and resumed. Continue the task from where you stopped — check the files first if unsure.)" });
  }
  const changed = new Set<string>(cp.changed ?? []);
  const ctx = { ...rc.toolCtx(spec.role, changed, spec.iteration), writeAllow: spec.writeAllow };
  const allowed = new Set(spec.tools.map((t) => t.name));
  const schemas = toolSchemas(spec.tools);
  const maxTurns = spec.maxTurns ?? rc.budgets.maxTurns;
  let finalText = "";
  let finished = false;
  let nudges = 0;

  while (cp.turns < maxTurns) {
    await rc.assertActive();
    cp.messages = compactMessages(cp.messages);
    const res = await rc.chat(spec.role, {
      purpose: spec.purpose,
      messages: cp.messages,
      tools: schemas.length ? schemas : undefined,
      provider: spec.provider,
      excludeProviders: spec.excludeProviders,
      temperature: spec.temperature ?? 0.2,
    });
    cp.turns++;
    let calls = res.toolCalls.filter((c) => c.name);
    let content = res.content ?? "";
    if (!calls.length && allowed.size) {
      const repaired = repairToolCalls(content, allowed);
      if (repaired.length) {
        calls = repaired;
        await rc.emit("warning", { role: spec.role, message: `repaired ${repaired.length} tool call(s) written as text by ${res.provider}/${res.model}` });
        content = "";
      }
    }
    cp.messages.push({ role: "assistant", content, ...(calls.length ? { toolCalls: calls } : {}) });
    if (content.trim()) await rc.emit("thinking", { role: spec.role, text: content.trim().slice(0, 1500) });

    if (!calls.length) {
      if (spec.mustWrite && changed.size === 0 && nudges < 2) {
        nudges++;
        cp.messages.push({
          role: "user",
          content: "You have not changed any file yet. Do the task now by calling the tools (write_file / apply_patch) — do not paste code in the chat. Call finish when done.",
        });
        await rc.checkpoint();
        continue;
      }
      finalText = content;
      finished = true;
      break;
    }

    let finishCalled = false;
    for (const call of calls) {
      await rc.assertActive();
      const r = await executeTool(call.name, call.arguments, ctx, allowed);
      cp.messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: r.output });
      if (call.name === "finish") {
        finishCalled = true;
        try {
          finalText = String((JSON.parse(call.arguments) as { summary?: string }).summary ?? "");
        } catch {
          finalText = r.output.replace(/^finished: /, "");
        }
      } else if (!["write_file", "apply_patch", "delete_file", "rename_file", "run_check"].includes(call.name) || !r.ok) {
        // file events are emitted by the tools themselves; log the rest (and failures) as tool events
        await rc.emit("tool", { role: spec.role, name: call.name, args: shortArgs(call.arguments), ok: r.ok, result: r.output.slice(0, 400) });
      }
    }
    cp.changed = [...changed];
    await rc.checkpoint();
    if (finishCalled) {
      if (spec.mustWrite && changed.size === 0 && nudges < 2) {
        nudges++;
        cp.messages.push({ role: "user", content: "finish was called but no file was changed. Write the planned files with write_file / apply_patch first." });
        continue;
      }
      finished = true;
      break;
    }
  }
  if (!finished) await rc.emit("warning", { role: spec.role, message: `${spec.key}: stopped after ${maxTurns} turns` });
  cp.done = true;
  cp.summary = finalText.slice(0, 4000);
  cp.changed = [...changed];
  cp.messages = []; // keep the checkpoint small once the agent is done
  await rc.checkpoint();
  return { text: finalText, finished, turns: cp.turns, changed: [...changed] };
}

function shortArgs(args: string): string {
  try {
    const o = JSON.parse(args) as Record<string, unknown>;
    return Object.entries(o)
      .map(([k, v]) => `${k}=${typeof v === "string" ? (v.length > 80 ? `${v.slice(0, 80)}…` : v) : JSON.stringify(v).slice(0, 80)}`)
      .join(" ")
      .slice(0, 300);
  } catch {
    return args.slice(0, 200);
  }
}
