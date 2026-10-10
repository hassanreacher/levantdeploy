/**
 * builder-ui: client-side DTOs for the AI app Builder.
 * Mirrors the JSON returned by the builder-core / builder-agents APIs (see docs/requests/builder-core.md and
 * docs/requests/builder-agents.md). Fields that a server may omit are optional so the UI degrades gracefully.
 */

export type BuilderStatus = "DRAFT" | "GENERATING" | "READY" | "ERROR";
export type PreviewStatus = "STOPPED" | "STARTING" | "RUNNING" | "ERROR";
export type RunStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED";
export type Quality = "fast" | "balanced" | "best";
export type Visibility = "private" | "public";

export type BuilderTheme = {
  /** palette tokens offered in the visual style panel (hex or css color) */
  colors?: Record<string, string>;
  font?: string;
  radius?: string;
  mode?: "light" | "dark" | "system";
};

export type BuilderSettings = {
  knowledge?: string;
  instructions?: string;
  theme?: BuilderTheme;
  quality?: Quality;
  visibility?: Visibility;
  [k: string]: unknown;
};

export type BuilderProject = {
  id: string;
  teamId: string;
  name: string;
  description?: string | null;
  prompt?: string | null;
  template: string;
  status: BuilderStatus | string;
  previewStatus: PreviewStatus | string;
  previewUrl?: string | null;
  previewError?: string | null;
  baseRef?: string | null;
  projectId?: string | null;
  project?: { id: string; slug: string; name: string; url?: string | null } | null;
  settings: BuilderSettings;
  lastCommit?: string | null;
  lastPublishedAt?: string | null;
  lastDeploymentId?: string | null;
  thumbnailUrl?: string | null;
  activeRunId?: string | null;
  share?: { enabled: boolean; expiresAt: string | null } | null;
  createdAt: string;
  updatedAt: string;
  createdBy?: { id: string; name: string | null; email?: string | null } | null;
};

export type Attachment = { kind: "image" | "file" | "element"; name?: string; url?: string; src?: string; text?: string; mime?: string };

export type BuilderMessage = {
  id: string;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  content: string;
  attachments: Attachment[];
  commitSha?: string | null;
  agentRunId?: string | null;
  meta?: Record<string, unknown>;
  createdAt: string;
  author?: { id: string; name: string | null } | null;
};

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";
export type RunStep = { id?: string; role?: string; title: string; status: StepStatus; startedAt?: string | null; finishedAt?: string | null; commitSha?: string | null; detail?: string };

export type FileChange = { path: string; status: "added" | "modified" | "deleted" | "renamed"; additions?: number; deletions?: number; patch?: string; from?: string };

export type CheckResult = { kind: "typecheck" | "lint" | "build" | string; ok: boolean; summary?: string; output?: string; durationMs?: number };

export type ProviderInfo = { provider: string; model?: string; fallbackFrom?: { provider: string; model?: string; reason?: string } | null; role?: string };

export type BuilderRun = {
  id: string;
  status: RunStatus;
  kind: string;
  prompt?: string | null;
  plan?: { summary?: string; steps?: RunStep[]; files?: string[] } | null;
  steps: RunStep[];
  usage?: Record<string, unknown>;
  error?: string | null;
  baseCommit?: string | null;
  resultCommit?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
};

/** One SSE event of a run. `seq` increases per run; the stream resumes from Last-Event-ID. */
export type RunEvent =
  | { seq: number; type: "status"; data: { status: RunStatus; error?: string | null } }
  | { seq: number; type: "plan"; data: { summary?: string; steps: RunStep[]; files?: string[] } }
  | { seq: number; type: "step"; data: RunStep & { index?: number } }
  | { seq: number; type: "delta"; data: { text: string; messageId?: string; role?: string } }
  | { seq: number; type: "message"; data: { id?: string; content: string; role?: string } }
  | { seq: number; type: "tool_call"; data: { id?: string; name: string; args?: Record<string, unknown>; role?: string } }
  | { seq: number; type: "tool_result"; data: { id?: string; name: string; ok: boolean; summary?: string } }
  | { seq: number; type: "commit"; data: { sha: string; message: string; files: FileChange[] } }
  | { seq: number; type: "check"; data: CheckResult }
  | { seq: number; type: "provider"; data: ProviderInfo }
  | { seq: number; type: "usage"; data: { credits?: { used: number; limit: number | null; period?: string }; tokens?: number } }
  | { seq: number; type: "suggestions"; data: { items: string[] } }
  | { seq: number; type: "error"; data: { message: string; code?: string } }
  | { seq: number; type: string; data: Record<string, unknown> };

export type CommitAuthorKind = "agent" | "user" | "visual" | "system";
export type Commit = {
  sha: string;
  shortSha?: string;
  /** first line of the message */
  title?: string;
  message: string;
  date: string;
  author: { kind: CommitAuthorKind; role?: string | null; name?: string | null };
  files?: FileChange[];
  runId?: string | null;
  published?: boolean;
};

export type FileEntry = { path: string; size?: number };

/** builder-core: `url` is a one-time SSO URL for the iframe, `publicUrl` the plain preview origin. */
export type PreviewState = { status: PreviewStatus | string; url?: string | null; publicUrl?: string | null; error?: string | null; errors?: RuntimeError[]; startedAt?: string | null; lastActiveAt?: string | null };
export type RuntimeError = { id?: string; message: string; stack?: string; source?: string; route?: string; at?: string };

export type Template = { id: string; name: string; description: string; prompt?: string; thumbnail?: string | null; tags?: string[]; kind?: "template" | "remix"; projectId?: string };

export type Credits = { usedToday: number; perDay: number | null; usedMonth: number; perMonth: number | null; plan?: string; remaining?: number | null };

export type PublishState = {
  deployment?: { id: string; status: string; url?: string | null; createdAt?: string; number?: number } | null;
  url?: string | null;
  lastPublishedAt?: string | null;
  lastPublishedCommit?: string | null;
  project?: { id: string; slug: string; name: string } | null;
};

/** AST edit operations applied server-side (builder-core visual-edit). `src` = data-lv-src "path:line:col". */
export type VisualEditOp =
  | { op: "setText"; src: string; text: string }
  | { op: "setClass"; src: string; add?: string[]; remove?: string[]; className?: string }
  | { op: "setStyle"; src: string; style: Record<string, string | null> }
  | { op: "setAttr"; src: string; name: string; value: string | null }
  | { op: "move"; src: string; target: string; position: "before" | "after" }
  | { op: "duplicate"; src: string }
  | { op: "delete"; src: string }
  | { op: "insert"; target: string; position: "before" | "after" | "inside"; component: string; props?: Record<string, unknown> };
