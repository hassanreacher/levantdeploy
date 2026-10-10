/**
 * Public types of the LLM router (`@/lib/llm`). Client-safe: no server imports here.
 *
 * Conversation state is provider-agnostic (OpenAI chat shape with camelCase tool fields), so a run can switch
 * provider/model at any step and resume from the last completed tool step.
 */

export const LLM_PURPOSES = ["plan", "code", "fix", "judge", "chat", "vision", "fast"] as const;
export type LlmPurpose = (typeof LLM_PURPOSES)[number];

export type LlmTier = "fast" | "smart";

// ───────────────────────────── messages ─────────────────────────────

export type LlmTextPart = { type: "text"; text: string };
/** `url` is an https URL or a `data:image/png;base64,…` URI. */
export type LlmImagePart = { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };
export type LlmContentPart = LlmTextPart | LlmImagePart;

export type LlmToolCall = {
  /** provider id or a generated `call_…` id (always set) */
  id: string;
  name: string;
  /** JSON-encoded arguments (repaired: fences stripped, trailing commas fixed …); "{}" when the model sent none */
  arguments: string;
  /** parsed `arguments` (object) — `null` when they could not be repaired into JSON */
  input: Record<string, unknown> | null;
  /**
   * opaque provider data that must be echoed back with this call in later turns (e.g. Gemini `thought_signature`).
   * Keep it when you push the assistant message; it is ignored by other providers.
   */
  extra?: { provider: string; data: Record<string, unknown> };
};

export type LlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | LlmContentPart[] }
  | { role: "assistant"; content: string | null; toolCalls?: LlmToolCall[] }
  | { role: "tool"; toolCallId: string; name?: string; content: string };

export type LlmTool = {
  name: string;
  description: string;
  /** JSON schema of the arguments object */
  parameters: Record<string, unknown>;
};

export type LlmToolChoice = "auto" | "none" | "required" | { name: string };

// ───────────────────────────── request / result ─────────────────────────────

export type LlmChatRequest = {
  messages: LlmMessage[];
  purpose: LlmPurpose;
  tools?: LlmTool[];
  toolChoice?: LlmToolChoice;
  /** stream from the provider (default true). Events are delivered through `onEvent` / `llm.stream()` either way. */
  stream?: boolean;
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  /**
   * Ask for JSON output matching this schema. Providers with json_schema support get `response_format: json_schema`,
   * json_object-only providers get json_object + the schema in the system prompt, the rest get the instruction only.
   * The result's `json` holds the parsed (repaired) object; invalid JSON → the next candidate is tried.
   */
  jsonSchema?: { name?: string; schema: Record<string, unknown> };
  /** plain JSON mode (no schema) */
  json?: boolean;
  /** pin one model ("provider/model"); with `pinOnly` no fallback happens */
  model?: string;
  pinOnly?: boolean;
  /** restrict / exclude candidates (provider ids or "provider/model" refs) */
  providers?: string[];
  exclude?: string[];
  /** per-attempt timeout (time to first byte AND idle gap between chunks), default 60 s (owner setting) */
  timeoutMs?: number;
  /** max candidates tried (default 6, owner setting) */
  maxAttempts?: number;
  /** accounting */
  teamId?: string | null;
  runId?: string | null;
  /** receives every event (also in non-stream mode) */
  onEvent?: (e: LlmEvent) => void;
};

export type LlmUsageCounts = { inputTokens: number; outputTokens: number };

export type LlmFinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "error";

export type LlmAttempt = {
  provider: string;
  model: string;
  ok: boolean;
  latencyMs: number;
  /** LlmErrorCode on failure */
  errorCode?: LlmErrorCode;
  error?: string;
};

export type LlmResult = {
  text: string;
  toolCalls: LlmToolCall[];
  finishReason: LlmFinishReason;
  /** parsed JSON when `json` / `jsonSchema` was requested */
  json?: unknown;
  provider: string;
  model: string;
  /** "provider/model" */
  ref: string;
  usage: LlmUsageCounts;
  latencyMs: number;
  /** every attempt including the successful one (last) */
  attempts: LlmAttempt[];
};

/** Unified stream event. */
export type LlmEvent =
  /** a new attempt starts on this model */
  | { type: "provider"; provider: string; model: string; attempt: number }
  | { type: "text"; text: string }
  /** emitted once per call when it is complete (arguments accumulated + repaired) */
  | { type: "tool_call"; call: LlmToolCall }
  | { type: "usage"; usage: LlmUsageCounts }
  /**
   * the attempt failed and the router moves on. `restart: true` ⇒ text/tool calls already emitted for this request
   * must be DISCARDED by the caller (the whole request is re-run on the next model).
   */
  | { type: "retry"; provider: string; model: string; code: LlmErrorCode; message: string; restart: boolean; attempt: number; delayMs: number }
  | { type: "done"; result: LlmResult }
  | { type: "error"; code: LlmErrorCode; message: string };

export type LlmErrorCode =
  | "NO_PROVIDERS" // nothing enabled/configured for the purpose
  | "ALL_FAILED" // every candidate failed (see attempts)
  | "ABORTED" // caller's signal
  | "RATE_LIMITED" // 429 / quota / "high demand"
  | "OVERLOADED" // 503 / 529
  | "TIMEOUT"
  | "NETWORK"
  | "AUTH" // 401/403 (bad key)
  | "NOT_FOUND" // 404 model
  | "BAD_REQUEST" // 400/422 (provider rejected the request)
  | "SERVER" // other 5xx
  | "STREAM_BROKEN" // stream died mid-way
  | "INVALID_OUTPUT"; // empty answer / unparseable JSON

export class LlmError extends Error {
  constructor(
    public code: LlmErrorCode,
    message: string,
    public extra: { status?: number; retryAfterMs?: number; attempts?: LlmAttempt[]; provider?: string; model?: string } = {},
  ) {
    super(message);
    this.name = "LlmError";
  }
  get attempts() {
    return this.extra.attempts ?? [];
  }
}

// ───────────────────────────── ensemble / judge ─────────────────────────────

export type LlmEnsembleRequest = Omit<LlmChatRequest, "model" | "pinOnly" | "onEvent"> & {
  /** number of DIFFERENT providers to run in parallel (falls back to different models of one provider when fewer are available) */
  candidates: number;
  /** each candidate falls back within its own provider only (default true) */
  sameProviderFallback?: boolean;
  onEvent?: (index: number, e: LlmEvent) => void;
};

export type LlmEnsembleItem = { index: number; ok: true; result: LlmResult } | { index: number; ok: false; ref: string | null; error: { code: LlmErrorCode; message: string } };

export type LlmJudgeVerdict = {
  /** index into `candidates` */
  winner: number;
  /** 0–10 per candidate */
  scores: number[];
  reasoning: string;
  judge: { provider: string; model: string };
};

// ───────────────────────────── catalog / config ─────────────────────────────

export type LlmModelInfo = {
  id: string;
  label?: string;
  tools: boolean;
  vision: boolean;
  contextWindow: number;
  maxOutput: number;
  tier: LlmTier;
  /** zero-cost model (OpenRouter ":free", free providers) */
  free?: boolean;
  /** model-level limits (override the provider's per-model defaults) */
  rpm?: number;
  rpd?: number;
};

export type LlmLimits = {
  /** provider-wide requests per minute / day */
  rpm?: number;
  rpd?: number;
  /** default per-model limits */
  modelRpm?: number;
  modelRpd?: number;
};

export type LlmProviderKind = "openai" | "anthropic";

/** Built-in provider definition (catalog.ts) or an owner-added custom provider. */
export type LlmProviderDef = {
  id: string;
  label: string;
  kind: LlmProviderKind;
  /** may contain `{CLOUDFLARE_ACCOUNT_ID}`-style placeholders resolved from extra vars */
  baseUrl: string;
  /** env var holding the key */
  envKey: string | null;
  /** works without a key (anonymous tier) */
  keyOptional?: boolean;
  /** extra variables (e.g. CLOUDFLARE_ACCOUNT_ID): name → env var */
  extraVars?: string[];
  docsUrl?: string;
  defaultEnabled: boolean;
  /** shown as a warning badge (e.g. "logs your prompts") */
  warning?: string;
  headers?: Record<string, string>;
  /** GET {base}/models works */
  modelsEndpoint: boolean;
  jsonMode: "schema" | "object" | "none";
  /** rotate across models (1 req/min/model providers) */
  rotate?: boolean;
  limits: LlmLimits;
  models: LlmModelInfo[];
  custom?: boolean;
  /** sandbox note / misc */
  notes?: string;
};

/** Owner overrides stored (per provider) in Setting "llm.providers". */
export type LlmProviderOverride = {
  enabled?: boolean;
  baseUrl?: string | null;
  headers?: Record<string, string>;
  /** encryptString(key) */
  apiKeyEnc?: string | null;
  /** extra vars, e.g. { CLOUDFLARE_ACCOUNT_ID: "…" } (not secret) */
  vars?: Record<string, string>;
  /** manual model list (replaces the built-in list; merged with fetched /models) */
  models?: LlmModelInfo[];
  /** per-model capability overrides by id */
  modelOverrides?: Record<string, Partial<LlmModelInfo> & { disabled?: boolean }>;
  limits?: LlmLimits;
  /** custom providers only */
  custom?: { label: string; jsonMode?: "schema" | "object" | "none"; modelsEndpoint?: boolean };
};

/** Resolved runtime view of a provider (never contains the key in client payloads). */
export type LlmProviderView = {
  id: string;
  label: string;
  kind: LlmProviderKind;
  custom: boolean;
  enabled: boolean;
  configured: boolean;
  keySource: "setting" | "env" | null;
  /** masked (last 4) */
  keyHint: string;
  baseUrl: string;
  defaultBaseUrl: string;
  headers: Record<string, string>;
  vars: Record<string, string>;
  extraVars: string[];
  warning?: string;
  notes?: string;
  docsUrl?: string;
  jsonMode: "schema" | "object" | "none";
  modelsEndpoint: boolean;
  rotate: boolean;
  limits: LlmLimits;
  models: (LlmModelInfo & { disabled?: boolean; source: "builtin" | "manual" | "fetched" })[];
  modelsFetchedAt: string | null;
};

export type LlmHealth = {
  /** "provider" or "provider/model" */
  scope: string;
  success: number;
  failure: number;
  /** 0..1 over the recent window (1 when no data) */
  successRate: number;
  /** EWMA latency in ms (null = no data) */
  latencyMs: number | null;
  lastErrors: { at: string; code: string; message: string }[];
  lastOkAt: string | null;
  /** ISO time until which the scope is cooled down (null = available) */
  cooldownUntil: string | null;
  cooldownReason: string | null;
  rpm: number;
  rpd: number;
};

export type LlmStatus = "ok" | "degraded" | "down" | "cooldown" | "unknown" | "disabled" | "unconfigured";

export type LlmPreferences = Record<LlmPurpose, string[]>;

export type LlmRoutingSettings = {
  timeoutMs: number;
  maxAttempts: number;
  /** retries on the same model before failing over (for transient errors) */
  sameModelRetries: number;
};
