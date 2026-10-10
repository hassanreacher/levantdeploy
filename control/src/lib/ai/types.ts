/**
 * Client-safe types shared by the AI API routes and the chat UI (no server imports here).
 *
 * The agent loop stores raw Anthropic content blocks (SDK `Beta*` types) in AgentMessage.content;
 * these "Ui*" shapes are the trimmed view the browser receives.
 */

export const AI_MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", hint: "Most capable (default)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", hint: "Balanced speed and quality" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", hint: "Fastest, lowest cost" },
] as const;
export type AiModelId = (typeof AI_MODELS)[number]["id"];
export const DEFAULT_MODEL: AiModelId = "claude-opus-5-5";

export const AI_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AiEffort = (typeof AI_EFFORTS)[number];
export const DEFAULT_EFFORT: AiEffort = "medium";

/** AgentAction.status (Prisma enum). PENDING_APPROVAL ≙ "proposed", SUCCEEDED ≙ "executed". */
export type UiActionStatus = "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "RUNNING" | "SUCCEEDED" | "FAILED";

export type UiAction = {
  id: string;
  toolUseId: string | null;
  tool: string;
  /** display-safe input (secret values masked) */
  input: Record<string, unknown>;
  output: unknown;
  status: UiActionStatus;
  requiresApproval: boolean;
  /** approval needs the user to type `confirmText` (destructive actions) */
  confirmText: string | null;
  /** one-line human summary ("Set DATABASE_URL on production + preview") */
  summary: string;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type UiBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; isError: boolean; text: string }
  | { type: "fallback"; from: string; to: string }
  | { type: "notice"; tone: "info" | "warning" | "danger"; text: string };

export type UiMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
  blocks: UiBlock[];
  model?: string | null;
  stopReason?: string | null;
  createdAt: string;
};

export type UiConversation = {
  id: string;
  title: string;
  projectId: string | null;
  projectSlug: string | null;
  teamSlug: string;
  model: string | null;
  updatedAt: string;
};

/** The conversation is waiting on the user (approvals) or idle. */
export type RunState = "idle" | "awaiting_approval" | "running";

/** Server-sent events emitted by POST /messages, /approve and /reject (one JSON object per `data:` line). */
export type AgentEvent =
  | { type: "run_start"; conversationId: string }
  | { type: "message_start"; model: string }
  | { type: "text_delta"; index: number; text: string }
  | { type: "thinking_delta"; index: number; text: string }
  | { type: "tool_use_start"; index: number; id: string; name: string }
  | { type: "fallback"; from: string; to: string }
  | { type: "message"; message: UiMessage }
  | { type: "action"; action: UiAction }
  | { type: "awaiting_approval"; actionIds: string[] }
  | { type: "refusal"; category: string | null; explanation: string | null }
  | { type: "error"; code: string; message: string }
  | { type: "title"; title: string }
  | { type: "done"; state: RunState };

/** Marker for the volatile context block we prepend to each user turn (hidden in the UI). */
export const CONTEXT_TAG = "levant_context";

/** Event name used to open the global assistant panel: window.dispatchEvent(new CustomEvent(AI_OPEN_EVENT, { detail })) */
export const AI_OPEN_EVENT = "ld:ai:open";
export type AiOpenDetail = { prompt?: string; autoSend?: boolean; projectSlug?: string | null };
