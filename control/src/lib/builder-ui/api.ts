"use client";

/**
 * builder-ui: typed client for the Builder APIs (builder-core: projects/files/history/preview/visual-edit/publish;
 * builder-agents: runs + SSE events). All paths live here so the UI never hardcodes them.
 *
 * Mock mode (early UI work / screenshots without a stack): `localStorage["ld-builder-mock"] = "1"` or `?mock=1` once.
 * It is never enabled by default — real APIs are always used unless explicitly turned on.
 */
import { api, ApiClientError } from "@/lib/client/api";
import type {
  Attachment,
  BuilderMessage,
  BuilderProject,
  BuilderRun,
  BuilderSettings,
  Commit,
  Credits,
  FileChange,
  FileEntry,
  PreviewState,
  PublishState,
  RunEvent,
  Template,
  VisualEditOp,
} from "./types";
import { mockApi } from "./mock";

const MOCK_KEY = "ld-builder-mock";

export function isMock(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const q = new URLSearchParams(window.location.search).get("mock");
    if (q === "1") localStorage.setItem(MOCK_KEY, "1");
    if (q === "0") localStorage.removeItem(MOCK_KEY);
    return localStorage.getItem(MOCK_KEY) === "1";
  } catch {
    return false;
  }
}

const P = "/api/v1/builder";
const enc = encodeURIComponent;

/** builder-core POST /projects: `starter` = gallery starter id (blank, saas-landing, …), `template` = workspace template (next15). */
export type CreateProjectInput = { team: string; prompt?: string; name?: string; starter?: string; template?: string; visibility?: "public" | "private"; attachments?: { url: string; name?: string; type?: string }[]; run?: boolean; remixOf?: string };
export type StartRunInput = { prompt: string; attachments?: Attachment[]; kind?: "build" | "edit" | "fix" | "chat"; context?: Record<string, unknown> };

export type BuilderApi = typeof realApi;

/** builder-agents RunDTO (mode instead of kind, steps as StepItem[]) → BuilderRun */
type RawRun = Omit<BuilderRun, "kind" | "steps"> & { mode?: string; kind?: string; steps?: unknown; lastSeq?: number; phase?: string | null };
function toRun(r: RawRun): BuilderRun & { lastSeq?: number; phase?: string | null } {
  const steps = Array.isArray(r.steps) ? (r.steps as BuilderRun["steps"]) : [];
  return { ...r, kind: r.kind ?? r.mode ?? "build", steps, plan: (r.plan as BuilderRun["plan"]) ?? null };
}

const realApi = {
  // ── projects ───────────────────────────────────────────────────────────────
  listProjects: (team: string) => api<{ items: BuilderProject[] }>(`${P}/projects?team=${enc(team)}`).then((r) => r.items),
  createProject: (input: CreateProjectInput) => api<{ project: BuilderProject; run?: { id: string } | null; runError?: string | null }>(`${P}/projects`, { body: input }),
  getProject: (id: string) => api<{ project: BuilderProject }>(`${P}/projects/${id}`).then((r) => r.project),
  updateProject: (id: string, patch: { name?: string; description?: string; settings?: Partial<BuilderSettings> }) =>
    api<{ project: BuilderProject }>(`${P}/projects/${id}`, { method: "PATCH", body: patch }).then((r) => r.project),
  deleteProject: (id: string, confirm: string) => api<{ ok: true }>(`${P}/projects/${id}?confirm=${enc(confirm)}`, { method: "DELETE" }),
  templates: () => api<{ items: Template[] }>(`${P}/templates`).then((r) => r.items),
  credits: (team: string) => api<unknown>(`${P}/credits?team=${enc(team)}`).then(normalizeCredits),

  // ── chat / runs (builder-agents: docs/requests/builder-agents.md) ────────
  messages: (id: string) => api<{ items: BuilderMessage[] }>(`${P}/projects/${id}/messages`).then((r) => r.items),
  runs: (id: string) => api<{ items: RawRun[] }>(`${P}/projects/${id}/runs`).then((r) => r.items.map(toRun)),
  getRun: (id: string, runId: string) => api<{ run: RawRun }>(`${P}/projects/${id}/runs/${runId}`).then((r) => toRun(r.run)),
  /** POST { message, mode: build|chat|fix, attachments: [{url (https or data:image), name, type}] } → { run, messageId, credits } */
  startRun: async (id: string, input: StartRunInput): Promise<{ run: BuilderRun; message?: BuilderMessage; credits?: Credits }> => {
    const mode = input.kind === "fix" ? "fix" : input.kind === "chat" ? "chat" : "build";
    const attachments = (input.attachments ?? []).filter((a) => a.kind === "image" && a.url).map((a) => ({ url: a.url!, name: a.name, type: a.mime }));
    // element context ("Ask AI about this element") travels inside the message so every agent sees it
    const elements = (input.attachments ?? []).filter((a) => a.kind === "element");
    const message = elements.length
      ? `${input.prompt}\n\n${elements.map((e) => `[Selected element: ${e.name ?? "element"} — source ${e.src ?? "?"}${e.text ? ` — text "${e.text.slice(0, 200)}"` : ""}]`).join("\n")}`
      : input.prompt;
    const r = await api<{ run: RawRun; messageId?: string; credits?: unknown }>(`${P}/projects/${id}/runs`, { body: { message, mode, attachments: attachments.length ? attachments : undefined } });
    return {
      run: toRun(r.run),
      message: r.messageId ? { id: r.messageId, role: "USER", content: message, attachments: input.attachments ?? [], agentRunId: r.run.id, createdAt: new Date().toISOString() } : undefined,
      credits: r.credits ? normalizeCredits(r.credits) : undefined,
    };
  },
  cancelRun: (id: string, runId: string) => api<{ run: RawRun }>(`${P}/projects/${id}/runs/${runId}/cancel`, { method: "POST" }),
  runEventsUrl: (id: string, runId: string) => `${P}/projects/${id}/runs/${runId}/events`,

  // ── files / code ─────────────────────────────────────────────────────────
  files: (id: string, ref?: string) => api<{ items: FileEntry[] }>(`${P}/projects/${id}/files${ref ? `?ref=${enc(ref)}` : ""}`).then((r) => r.items),
  readFile: (id: string, path: string, ref?: string) =>
    api<{ path: string; content: string; binary?: boolean }>(`${P}/projects/${id}/files/content?path=${enc(path)}${ref ? `&ref=${enc(ref)}` : ""}`),
  writeFile: (id: string, path: string, content: string, message?: string) =>
    api<{ commit: Commit | null }>(`${P}/projects/${id}/files/content`, { method: "PUT", body: { path, content, message } }),
  search: (id: string, q: string) => api<{ items: { path: string; line: number; text: string }[] }>(`${P}/projects/${id}/files/search?q=${enc(q)}`).then((r) => r.items),

  // ── history ──────────────────────────────────────────────────────────────
  commits: (id: string) => api<{ items: Commit[] }>(`${P}/projects/${id}/commits`).then((r) => r.items),
  commit: (id: string, sha: string) => api<{ commit: Commit; files: FileChange[] }>(`${P}/projects/${id}/commits/${sha}`),
  restore: (id: string, sha: string) => api<{ commit: Commit }>(`${P}/projects/${id}/restore`, { body: { sha } }),

  // ── preview ──────────────────────────────────────────────────────────────
  /** { status, url (one-time SSO iframe URL), publicUrl, error, errors[] } */
  preview: (id: string) => api<PreviewState>(`${P}/projects/${id}/preview`),
  startPreview: (id: string, restart = false) => api<PreviewState>(`${P}/projects/${id}/preview`, { body: { action: restart ? "restart" : "start" } }),
  /** fresh 2-minute SSO URL that sets the preview cookie and redirects to `next` (iframe src / open in new tab) */
  previewUrl: (id: string, next = "/") => api<{ url: string; expiresIn: number }>(`${P}/projects/${id}/preview/url?next=${enc(next)}`).then((r) => r.url),
  previewErrors: (id: string) => api<{ items: { id: string; at: string; source: string; message: string; stack?: string; route?: string; file?: string }[] }>(`${P}/projects/${id}/preview/errors`).then((r) => r.items),
  clearPreviewErrors: (id: string) => api<{ ok: true }>(`${P}/projects/${id}/preview/errors`, { method: "DELETE" }),

  // ── visual edit ──────────────────────────────────────────────────────────
  visualEdit: (id: string, ops: VisualEditOp[], message?: string) => api<{ commit: Commit | null }>(`${P}/projects/${id}/visual-edit`, { body: { ops, message } }),
  upload: async (id: string, file: File): Promise<{ url: string; path?: string }> => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`${P}/projects/${id}/uploads`, { method: "POST", body: fd, credentials: "same-origin" });
    const data = (await res.json().catch(() => null)) as { url?: string; path?: string; error?: { code: string; message: string } } | null;
    if (!res.ok || !data?.url) throw new ApiClientError(res.status, data?.error?.code ?? `HTTP_${res.status}`, data?.error?.message ?? "Upload failed");
    return { url: data.url, path: data.path };
  },

  // ── publish / export / share ─────────────────────────────────────────────
  publishState: (id: string) => api<PublishState>(`${P}/projects/${id}/publish`),
  publish: (id: string) => api<PublishState>(`${P}/projects/${id}/publish`, { method: "POST", body: {} }),
  exportZipUrl: (id: string) => `${P}/projects/${id}/export.zip`,
  exportGithub: (id: string, input: { repo: string; private: boolean; installationId?: string }) =>
    api<{ url: string; repo: string }>(`${P}/projects/${id}/export/github`, { body: input }),
  share: (id: string, input: { enabled: boolean; ttlHours?: number | null }) => api<{ url: string | null; expiresAt?: string | null }>(`${P}/projects/${id}/share`, { body: input }),
  shareInfo: (id: string) => api<{ enabled: boolean; expiresAt: string | null; createdAt: string | null }>(`${P}/projects/${id}/share`),

  // ── backend ──────────────────────────────────────────────────────────────
  attachBackend: (id: string, input: { ref?: string; create?: boolean }) => api<{ project: BuilderProject }>(`${P}/projects/${id}/backend`, { body: input }),
};

/** Accepts the plans lib `BuilderCredits` shape ({ usedToday, usedMonth, limits, remainingToday, allowed, plan }) or a flat one. */
export function normalizeCredits(raw: unknown): Credits {
  const r = ((raw as { credits?: unknown })?.credits ?? raw) as Record<string, unknown>;
  const limits = (r.limits ?? {}) as { messagesPerDay?: number | null; messagesPerMonth?: number | null; dailyBonus?: number | null };
  const plan = r.plan as { name?: string } | string | undefined;
  const perDay = (r.perDay as number | null | undefined) ?? limits.messagesPerDay ?? null;
  const perMonth = (r.perMonth as number | null | undefined) ?? limits.messagesPerMonth ?? null;
  const remaining = r.allowed === false ? 0 : ((r.remaining ?? r.remainingToday ?? null) as number | null);
  return {
    usedToday: Number(r.usedToday ?? 0),
    usedMonth: Number(r.usedMonth ?? 0),
    perDay,
    perMonth,
    plan: typeof plan === "string" ? plan : plan?.name,
    remaining,
  };
}

/** The client used by the UI (real API unless mock mode is on). */
export function builderApi(): BuilderApi {
  return isMock() ? (mockApi as unknown as BuilderApi) : realApi;
}

/**
 * Subscribe to a run's SSE stream (builder-agents: `id: <seq>`, `event: <type>`, `data: {seq, type, data, at}`; the
 * server replays stored events after `?after=` and closes once the run is final). Uses fetch streaming (not EventSource)
 * so a closed stream is not blindly re-opened: on disconnect we reconnect from the last seq only while the run is active.
 * Returns a close function.
 */
export function streamRun(projectId: string, runId: string, onEvent: (e: RunEvent) => void, opts: { from?: number; onEnd?: () => void; onError?: (e: unknown) => void } = {}): () => void {
  if (isMock()) return mockApi.streamRun(runId, onEvent, opts);
  const ctrl = new AbortController();
  let last = opts.from ?? 0;
  let final = false;
  let stopped = false;
  const FINAL = new Set(["SUCCEEDED", "FAILED", "CANCELED"]);
  const handle = (raw: string) => {
    const data = raw
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    try {
      const j = JSON.parse(data) as { seq?: number; type?: string; data?: Record<string, unknown> };
      const ev = { seq: Number(j.seq ?? 0), type: String(j.type ?? "message"), data: j.data ?? {} } as RunEvent;
      if (ev.seq && ev.seq <= last) return;
      if (ev.seq) last = ev.seq;
      if (ev.type === "status" && FINAL.has(String((ev.data as { status?: string }).status))) final = true;
      onEvent(ev);
    } catch (e) {
      opts.onError?.(e);
    }
  };
  const loop = async () => {
    let failures = 0;
    while (!stopped) {
      try {
        const res = await fetch(`${realApi.runEventsUrl(projectId, runId)}?after=${last}`, { credentials: "same-origin", signal: ctrl.signal, headers: { accept: "text/event-stream" } });
        if (!res.ok || !res.body) throw new ApiClientError(res.status, `HTTP_${res.status}`, `Run stream failed (${res.status})`);
        failures = 0;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            handle(buf.slice(0, i));
            buf = buf.slice(i + 2);
          }
        }
        if (final) break;
        // stream closed without a final status (proxy timeout / deploy) → is the run still going?
        const run = await realApi.getRun(projectId, runId).catch(() => null);
        if (!run || FINAL.has(run.status)) break;
      } catch (e) {
        if (stopped || ctrl.signal.aborted) return;
        if (e instanceof ApiClientError && (e.status === 404 || e.status === 401 || e.status === 403)) {
          opts.onError?.(e);
          break;
        }
        if (++failures > 8) {
          opts.onError?.(e);
          break;
        }
      }
      await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** failures, 10_000)));
    }
    if (!stopped) opts.onEnd?.();
  };
  void loop();
  return () => {
    stopped = true;
    ctrl.abort();
  };
}
