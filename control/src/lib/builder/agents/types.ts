/**
 * Builder agents — shared types (builder-agents area). Worker-safe, no next/* imports.
 *
 * The conversation format is OpenAI-chat shaped and provider-agnostic: any provider of the llm router can continue a
 * conversation another provider started (tool calls carry their own ids, results are plain text).
 */
import { z } from "zod";

// ───────────────────────────── conversation ─────────────────────────────

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type ToolCall = {
  id: string;
  name: string;
  arguments: string;
  /** provider-specific opaque data that must be echoed back to the same provider (e.g. Gemini thought signatures) */
  extra?: Record<string, unknown>;
};

export type Msg =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

/** OpenAI function tool schema */
export type ToolSchema = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };

export type ChatRequest = {
  /** router purpose: "builder.plan" | "builder.code" | … (used for model choice + usage accounting) */
  purpose: string;
  messages: Msg[];
  tools?: ToolSchema[];
  /** structured output (JSON) */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  temperature?: number;
  maxTokens?: number;
  /** pin a provider (best-of-N candidates) */
  provider?: string;
  /** providers to skip (orchestrator retry after a provider failed) */
  excludeProviders?: string[];
  signal?: AbortSignal;
  teamId?: string;
  /** usage attribution */
  ref?: { builderProjectId?: string; runId?: string; role?: string };
};

export type ChatResult = {
  content: string;
  toolCalls: ToolCall[];
  provider: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  /** router-level fallbacks that happened inside this call */
  fallbacks?: { from: string; to: string; reason: string }[];
  finishReason?: string;
  /** parsed JSON when jsonSchema was requested (router-repaired) */
  json?: unknown;
};

/** Thrown by the LLM port when a call failed (after the router's own fallbacks). */
export class LlmCallError extends Error {
  constructor(
    message: string,
    public provider: string | null = null,
    /** true when no provider at all could serve the call */
    public allFailed = false,
    public retryable = true,
    /** provider-suggested wait (Retry-After) */
    public retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

export type EnsembleItem = { ok: true; result: ChatResult } | { ok: false; error: string; provider?: string | null };

export interface LlmPort {
  chat(req: ChatRequest): Promise<ChatResult>;
  /** provider ids that are configured + healthy, best first (for best-of-N) */
  providers(purpose: string, opts?: { teamId?: string; needTools?: boolean }): Promise<string[]>;
  /** best-of-N: the same request on N different providers in parallel (optional — emulated with pinned chats otherwise) */
  ensemble?(req: ChatRequest & { candidates: number }): Promise<EnsembleItem[]>;
  /** judge picks the best candidate text (optional — emulated with a judge chat otherwise) */
  judge?(task: string, candidates: string[], opts: { criteria?: string; signal?: AbortSignal; teamId?: string; runId?: string }): Promise<{ winner: number; reasoning: string; provider?: string; model?: string }>;
}

// ───────────────────────────── roles / modes / phases ─────────────────────────────

export const ROLES = ["planner", "designer", "coder", "backend", "fixer", "judge", "summarizer", "chat"] as const;
export type Role = (typeof ROLES)[number];

export const RUN_MODES = ["build", "chat", "fix"] as const;
export type RunMode = (typeof RUN_MODES)[number];

export const PHASES = ["plan", "backend", "design", "code", "check", "summarize", "answer", "done"] as const;
export type Phase = (typeof PHASES)[number];

export type RunStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED";

// ───────────────────────────── plan ─────────────────────────────

export const planSchema = z.object({
  summary: z.string().default(""),
  kind: z.enum(["new_app", "feature", "edit", "fix", "style"]).catch("feature").default("feature"),
  pages: z.array(z.object({ route: z.string(), purpose: z.string().default("") })).catch([]).default([]),
  components: z.array(z.object({ name: z.string(), purpose: z.string().default("") })).catch([]).default([]),
  dataModel: z
    .array(z.object({ table: z.string(), columns: z.array(z.string()).catch([]).default([]), ownerScoped: z.boolean().catch(false).default(false) }))
    .catch([])
    .default([]),
  backend: z
    .object({
      needed: z.boolean().catch(false).default(false),
      auth: z.boolean().catch(false).default(false),
      storageBuckets: z.array(z.string()).catch([]).default([]),
      functions: z.array(z.string()).catch([]).default([]),
      notes: z.string().catch("").default(""),
    })
    .catch({ needed: false, auth: false, storageBuckets: [], functions: [], notes: "" })
    .default({}),
  design: z
    .object({ update: z.boolean().catch(false).default(false), style: z.string().catch("").default(""), palette: z.string().catch("").default("") })
    .catch({ update: false, style: "", palette: "" })
    .default({}),
  files: z
    .array(z.object({ path: z.string(), action: z.enum(["create", "modify", "delete"]).catch("modify").default("modify"), purpose: z.string().catch("").default(""), group: z.string().catch("main").default("main") }))
    .catch([])
    .default([]),
  dependencies: z.array(z.string()).catch([]).default([]),
});
export type Plan = z.infer<typeof planSchema>;

/** JSON schema handed to the planner (structured output). Kept flat/simple so weak models can follow it. */
export const PLAN_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    summary: { type: "string", description: "1-3 sentences: what will be built/changed" },
    kind: { type: "string", enum: ["new_app", "feature", "edit", "fix", "style"] },
    pages: { type: "array", items: { type: "object", properties: { route: { type: "string" }, purpose: { type: "string" } }, required: ["route"] } },
    components: { type: "array", items: { type: "object", properties: { name: { type: "string" }, purpose: { type: "string" } }, required: ["name"] } },
    dataModel: {
      type: "array",
      items: {
        type: "object",
        properties: { table: { type: "string" }, columns: { type: "array", items: { type: "string" } }, ownerScoped: { type: "boolean" } },
        required: ["table"],
      },
    },
    backend: {
      type: "object",
      properties: {
        needed: { type: "boolean" },
        auth: { type: "boolean" },
        storageBuckets: { type: "array", items: { type: "string" } },
        functions: { type: "array", items: { type: "string" } },
        notes: { type: "string" },
      },
      required: ["needed"],
    },
    design: { type: "object", properties: { update: { type: "boolean" }, style: { type: "string" }, palette: { type: "string" } } },
    files: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          action: { type: "string", enum: ["create", "modify", "delete"] },
          purpose: { type: "string" },
          group: { type: "string", description: "files edited together by one coder (e.g. 'layout', 'home', 'todos')" },
        },
        required: ["path", "action"],
      },
    },
    dependencies: { type: "array", items: { type: "string" }, description: "extra npm packages (not already in the template)" },
  },
  required: ["summary", "kind", "files", "backend"],
};

// ───────────────────────────── events ─────────────────────────────

export type RunEventType =
  | "status" // { status, phase? }
  | "phase" // { phase, label }
  | "thinking" // { role, text }
  | "plan" // { plan }
  | "tool" // { role, name, args (short), ok, result (short) }
  | "file" // { role, path, action: create|modify|delete|rename, diff?, from? }
  | "check" // { kind, ok, iteration, output (excerpt), skipped? }
  | "provider" // { role, provider, model, fallback?: {from, reason} }
  | "commit" // { sha, message, author }
  | "restore" // { sha, reason }
  | "backend" // { ref, url, action }
  | "sql" // { description, ok, error? }
  | "warning" // { message }
  | "error" // { message, role? }
  | "message" // { content } final assistant message
  | "usage"; // { tokens, steps, providers }

export type RunEvent = { seq: number; type: RunEventType; data: Record<string, unknown>; at: string };

// ───────────────────────────── persisted run state (checkpoint) ─────────────────────────────

export type UsageAcc = { steps: number; tokens: number; providers: Record<string, { calls: number; inTok: number; outTok: number; failures: number }> };

export type AgentCheckpoint = {
  /** key: phase + sub key ("code:home") */
  key: string;
  role: Role;
  messages: Msg[];
  turns: number;
  done: boolean;
  /** final text / finish summary once done (messages are dropped then to keep the checkpoint small) */
  summary?: string;
  /** files changed by this agent */
  changed?: string[];
};

export type RunState = {
  version: 1;
  completed: Phase[];
  /** in-progress agent conversations (resume after worker restart) */
  agents: Record<string, AgentCheckpoint>;
  /** code groups done */
  groupsDone: string[];
  checkIteration: number;
  lastGreenCommit: string | null;
  lastErrors: string | null;
  usage: UsageAcc;
  backendRef: string | null;
  /** soft failures (phases that failed but the run continued) */
  degraded: string[];
  resumes: number;
  /** checks still failing after the fix loop → workspace restored to lastGreenCommit */
  checkFailed: boolean;
  /** notes handed from one role to the next (designer tokens, backend summary) */
  notes: Record<string, string>;
};

export const emptyState = (): RunState => ({
  version: 1,
  completed: [],
  agents: {},
  groupsDone: [],
  checkIteration: 0,
  lastGreenCommit: null,
  lastErrors: null,
  usage: { steps: 0, tokens: 0, providers: {} },
  backendRef: null,
  degraded: [],
  resumes: 0,
  checkFailed: false,
  notes: {},
});

export type StepItem = {
  key: string;
  role: Role;
  title: string;
  status: "running" | "done" | "failed" | "skipped";
  startedAt?: string;
  finishedAt?: string;
  commitSha?: string | null;
  detail?: string;
};

export type RunRecord = {
  id: string;
  builderProjectId: string;
  teamId: string;
  createdById: string | null;
  mode: RunMode;
  status: RunStatus;
  phase: string | null;
  message: string;
  attachments: { url: string; name?: string; type?: string }[];
  plan: Plan | null;
  state: RunState | null;
  /** UI progress list (BuilderRun.steps) */
  steps: StepItem[];
  error: string | null;
  summary: string | null;
  startCommit: string | null;
  endCommit: string | null;
  cancelRequested: boolean;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
};

export type ProjectContext = {
  id: string;
  teamId: string;
  name: string;
  /** owner's custom instructions / knowledge */
  knowledge: string;
  baseRef: string | null;
  /** last few chat messages (oldest first), for follow-ups */
  history: { role: "user" | "assistant"; content: string }[];
};

export type CheckKind = "typecheck" | "lint" | "build";
export type CheckResult = { ok: boolean; output: string; skipped?: boolean };

export type Budgets = {
  /** LLM calls per run */
  maxSteps: number;
  /** total tokens per run */
  maxTokens: number;
  /** turns per agent conversation */
  maxTurns: number;
  /** fix iterations */
  maxFixIterations: number;
  /** best-of-N candidates for plan / hard fixes */
  ensembleSize: number;
};

export const DEFAULT_BUDGETS: Budgets = { maxSteps: 160, maxTokens: 3_000_000, maxTurns: 24, maxFixIterations: 5, ensembleSize: 2 };
