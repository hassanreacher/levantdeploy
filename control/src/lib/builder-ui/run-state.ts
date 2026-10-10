/** builder-ui: pure reducer turning a run's SSE events into what the chat panel renders. */
import type { CheckResult, FileChange, ProviderInfo, RunEvent, RunStatus, RunStep } from "./types";

export type ToolActivity = { id: string; name: string; label: string; ok?: boolean; summary?: string; done: boolean };
export type RunCommit = { sha: string; message: string; files: FileChange[] };

export type RunView = {
  runId: string;
  status: RunStatus;
  lastSeq: number;
  /** current orchestrator phase (builder-agents "phase" events) */
  phase?: string | null;
  /** short reasoning lines (judge / fixer "thinking" events) */
  thoughts: { role?: string; text: string }[];
  /** non-fatal notices (warnings, soft errors, backend attached, restored…) */
  notices: { kind: "warning" | "error" | "info"; text: string }[];
  /** files changed since the last commit event (attached to the next commit card) */
  pendingFiles: FileChange[];
  /** assistant text streamed so far (final message replaces it) */
  text: string;
  planSummary?: string;
  steps: RunStep[];
  commits: RunCommit[];
  checks: CheckResult[];
  providers: ProviderInfo[];
  tools: ToolActivity[];
  suggestions: string[];
  error?: string | null;
  credits?: { used: number; limit: number | null; period?: string };
  planFiles?: number;
};

/** Append a notice; a notice whose first 24 chars match the previous one replaces it (retry/backoff chatter). */
function pushNotice(list: RunView["notices"], n: RunView["notices"][number]): RunView["notices"] {
  const last = list[list.length - 1];
  const key = (t: string) => t.replace(/\d+/g, "#").slice(0, 24);
  if (last && last.kind === n.kind && key(last.text) === key(n.text)) return [...list.slice(0, -1), n];
  return [...list, n].slice(-8);
}

export function emptyRun(runId: string, status: RunStatus = "QUEUED"): RunView {
  return { runId, status, lastSeq: 0, text: "", steps: [], commits: [], checks: [], providers: [], tools: [], suggestions: [], thoughts: [], notices: [], pendingFiles: [] };
}

export const TOOL_LABELS: Record<string, string> = {
  list_files: "Listing files",
  read_file: "Reading",
  write_file: "Writing",
  apply_patch: "Editing",
  delete_file: "Deleting",
  rename_file: "Renaming",
  add_dependency: "Installing",
  run_check: "Running check",
  get_preview_errors: "Checking preview errors",
  screenshot_preview: "Taking a screenshot",
  base_sql: "Running SQL",
  base_create_bucket: "Creating storage bucket",
  deploy_function: "Deploying function",
  search_docs: "Searching docs",
};

function toolLabel(name: string, args?: Record<string, unknown> | string): string {
  const base = TOOL_LABELS[name] ?? name.replace(/_/g, " ");
  if (typeof args === "string") {
    // builder-agents sends a short JSON-ish string: pull "path" out when present
    // builder-agents: `path=app/page.tsx start_line=1` (JSON-ish strings are accepted too)
    const m = /(?:^|\s)(?:path|file|from|kind|packages|query|q)=(\S+)/.exec(args) ?? /"(?:path|file|kind|name)"\s*:\s*"([^"]+)"/.exec(args);
    return m ? `${base} ${m[1]}` : base;
  }
  const target = (args?.path ?? args?.file ?? args?.kind ?? args?.name ?? (Array.isArray(args?.packages) ? (args!.packages as string[]).join(", ") : undefined)) as string | undefined;
  return target ? `${base} ${String(target)}` : base;
}

const FILE_STATUS: Record<string, FileChange["status"]> = { create: "added", added: "added", modify: "modified", modified: "modified", delete: "deleted", deleted: "deleted", rename: "renamed", renamed: "renamed" };

const TERMINAL: RunStatus[] = ["SUCCEEDED", "FAILED", "CANCELED"];
export const isTerminal = (s: RunStatus | string) => (TERMINAL as string[]).includes(s);

function upsertStep(steps: RunStep[], s: RunStep & { index?: number }): RunStep[] {
  const out = steps.slice();
  let i = typeof s.index === "number" ? s.index : -1;
  if (i < 0 && s.id) i = out.findIndex((x) => x.id === s.id);
  if (i < 0) i = out.findIndex((x) => x.title === s.title);
  const { index: _i, ...step } = s;
  if (i >= 0 && i < out.length) out[i] = { ...out[i]!, ...step };
  else if (i >= out.length) {
    while (out.length < i) out.push({ title: "…", status: "pending" });
    out.push(step);
  } else out.push(step);
  return out;
}

export function reduceRun(state: RunView, ev: RunEvent): RunView {
  if (ev.seq && ev.seq <= state.lastSeq) return state; // duplicate after reconnect
  const s: RunView = { ...state, lastSeq: ev.seq || state.lastSeq };
  const d = ev.data as Record<string, unknown>;
  switch (ev.type) {
    case "status": {
      s.status = d.status as RunStatus;
      if (d.error) s.error = String(d.error);
      if (isTerminal(s.status)) {
        // anything still running is finished now
        s.steps = s.steps.map((x) => (x.status === "running" ? { ...x, status: s.status === "SUCCEEDED" ? "done" : "failed" } : x));
        s.tools = s.tools.map((t) => ({ ...t, done: true }));
      }
      return s;
    }
    case "phase": {
      const phase = String(d.phase ?? "");
      s.phase = phase;
      const finish = (x: RunStep): RunStep => (x.status === "running" ? { ...x, status: "done" } : x);
      if (phase === "done") {
        s.steps = s.steps.map(finish);
        return s;
      }
      // builder-agents drives progress with phases: each phase becomes a step (planned steps keep their slots)
      const label = String(d.label ?? phase);
      const idx = s.steps.findIndex((x) => x.id === phase || (x as { key?: string }).key === phase || x.title === label);
      s.steps = s.steps.map(finish);
      if (idx >= 0) s.steps[idx] = { ...s.steps[idx]!, status: "running" };
      else s.steps = [...s.steps, { id: phase, title: label, status: "running", startedAt: (ev as { at?: string }).at }];
      return s;
    }
    case "plan": {
      const plan = (d.plan ?? d) as { summary?: string; steps?: RunStep[]; files?: unknown[] };
      s.planSummary = plan.summary || s.planSummary;
      if (Array.isArray(plan.steps)) s.steps = plan.steps.map((x) => ({ ...x, status: x.status ?? "pending" }));
      if (Array.isArray(plan.files)) s.planFiles = plan.files.length;
      return s;
    }
    case "thinking":
      if (d.text) s.thoughts = [...s.thoughts, { role: d.role as string | undefined, text: String(d.text) }].slice(-6);
      return s;
    case "tool": {
      const t: ToolActivity = { id: `${s.lastSeq}`, name: String(d.name), label: toolLabel(String(d.name), d.args as string | Record<string, unknown>), ok: d.ok === undefined ? undefined : Boolean(d.ok), summary: d.result as string | undefined, done: d.ok !== undefined };
      s.tools = [...s.tools, t].slice(-30);
      return s;
    }
    case "file": {
      const diff = typeof d.diff === "string" ? d.diff : undefined;
      let additions = d.additions as number | undefined;
      let deletions = d.deletions as number | undefined;
      if (diff && additions === undefined) {
        additions = 0;
        deletions = 0;
        for (const l of diff.split("\n")) {
          if (l.startsWith("+")) additions++;
          else if (l.startsWith("-")) deletions++;
        }
      }
      const f: FileChange = { path: String(d.path), status: FILE_STATUS[String(d.action)] ?? "modified", additions, deletions, patch: diff, from: d.from as string | undefined };
      s.pendingFiles = [...s.pendingFiles.filter((x) => x.path !== f.path), f];
      return s;
    }
    case "warning":
      s.notices = pushNotice(s.notices, { kind: "warning" as const, text: String(d.message ?? "") });
      return s;
    case "backend":
      s.notices = pushNotice(s.notices, { kind: "info" as const, text: `Backend ${String(d.action ?? "attached")}${d.ref ? ` (${String(d.ref)})` : ""}` });
      return s;
    case "sql":
      s.notices = pushNotice(s.notices, { kind: d.ok === false ? ("warning" as const) : ("info" as const), text: `${d.ok === false ? "SQL failed" : "Database updated"}${d.description ? `: ${String(d.description)}` : ""}${d.error ? ` — ${String(d.error)}` : ""}` });
      return s;
    case "restore":
      s.notices = pushNotice(s.notices, { kind: "info" as const, text: `Restored the last working version${d.reason ? ` — ${String(d.reason)}` : ""}` });
      return s;
    case "step":
      s.steps = upsertStep(s.steps, d as RunStep & { index?: number });
      return s;
    case "delta":
      s.text += String(d.text ?? "");
      return s;
    case "message":
      s.text = String(d.content ?? "");
      return s;
    case "tool_call": {
      const id = String(d.id ?? `${d.name}-${s.tools.length}`);
      s.tools = [...s.tools, { id, name: String(d.name), label: toolLabel(String(d.name), d.args as Record<string, unknown>), done: false }].slice(-30);
      return s;
    }
    case "tool_result": {
      const idx = d.id ? s.tools.findIndex((t) => t.id === d.id) : s.tools.map((t) => t.name).lastIndexOf(String(d.name));
      if (idx >= 0) {
        s.tools = s.tools.slice();
        s.tools[idx] = { ...s.tools[idx]!, ok: Boolean(d.ok), summary: d.summary as string | undefined, done: true };
      }
      return s;
    }
    case "commit": {
      const files = Array.isArray(d.files) && d.files.length ? (d.files as FileChange[]) : s.pendingFiles;
      s.commits = [...s.commits.filter((c) => c.sha !== d.sha), { sha: String(d.sha), message: String(d.message ?? ""), files }];
      s.pendingFiles = [];
      return s;
    }
    case "check": {
      const c = { ...(d as unknown as CheckResult), summary: (d.summary as string | undefined) ?? (d.skipped ? "skipped" : d.iteration ? `attempt ${String(d.iteration)}` : undefined) };
      s.checks = [...s.checks.filter((x) => x.kind !== c.kind), c];
      return s;
    }
    case "provider": {
      const fb = d.fallback as { from?: string; reason?: string } | undefined;
      const p = { ...(d as unknown as ProviderInfo), ...(fb?.from && !d.fallbackFrom ? { fallbackFrom: { provider: fb.from.split("/")[0]!, model: fb.from.split("/").slice(1).join("/") || undefined, reason: fb.reason } } : {}) };
      const last = s.providers[s.providers.length - 1];
      if (!last || last.provider !== p.provider || last.model !== p.model || p.fallbackFrom) s.providers = [...s.providers, p].slice(-12);
      return s;
    }
    case "usage":
      if (d.credits) s.credits = d.credits as RunView["credits"];
      return s;
    case "suggestions":
      s.suggestions = ((d.items as string[]) ?? []).slice(0, 4);
      return s;
    case "error":
      // builder-agents also reports soft errors (one code group failed) — fatal ones end with status FAILED
      s.error = String(d.message ?? "Something went wrong");
      s.notices = pushNotice(s.notices, { kind: "error" as const, text: s.error });
      return s;
    default:
      return s;
  }
}

/** Distinct "provider: X, fell back from Y" chips for a run. */
export function providerChips(p: ProviderInfo[]): { label: string; title: string; fallback: boolean }[] {
  const seen = new Set<string>();
  const out: { label: string; title: string; fallback: boolean }[] = [];
  for (const x of p) {
    const name = x.model ? `${x.provider} · ${x.model}` : x.provider;
    const key = `${name}|${x.fallbackFrom?.provider ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      label: x.fallbackFrom ? `${x.provider}, fell back from ${x.fallbackFrom.provider}` : x.provider,
      title: `${x.role ? `${x.role}: ` : ""}${name}${x.fallbackFrom ? ` (fell back from ${x.fallbackFrom.provider}${x.fallbackFrom.model ? ` · ${x.fallbackFrom.model}` : ""}${x.fallbackFrom.reason ? ` — ${x.fallbackFrom.reason}` : ""})` : ""}`,
      fallback: !!x.fallbackFrom,
    });
  }
  return out;
}
