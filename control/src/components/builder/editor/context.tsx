"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useToast } from "@/components/ui/toast";
import { errMessage } from "@/lib/builder-ui/errors";
import { builderApi, isMock, streamRun, type StartRunInput } from "@/lib/builder-ui/api";
import { emptyRun, isTerminal, reduceRun, type RunView } from "@/lib/builder-ui/run-state";
import { originOf, postToBridge, type EditorMessage, type ElementInfo } from "@/lib/builder-ui/bridge";
import type { Attachment, BuilderMessage, BuilderProject, Credits, PreviewState, RuntimeError, VisualEditOp } from "@/lib/builder-ui/types";

export type EditorView = "preview" | "code" | "history";
export type Device = "desktop" | "tablet" | "mobile";
export type Panel = null | "backend" | "publish" | "settings" | "share";

type Ctx = {
  team: string;
  role: string;
  project: BuilderProject;
  setProject: (p: BuilderProject) => void;
  refreshProject: () => Promise<void>;
  // chat
  messages: BuilderMessage[];
  runs: Record<string, RunView>;
  activeRunId: string | null;
  sending: boolean;
  send: (prompt: string, attachments?: Attachment[], opts?: { kind?: StartRunInput["kind"]; context?: Record<string, unknown> }) => Promise<boolean>;
  stop: () => Promise<void>;
  draft: { text: string; nonce: number; attachments?: Attachment[] };
  prefill: (text: string, attachments?: Attachment[]) => void;
  credits: Credits | null;
  // preview
  preview: PreviewState;
  startPreview: (restart?: boolean) => Promise<void>;
  previewKey: number;
  reloadPreview: () => void;
  /** current iframe src (SSO URL from builder-core, refreshed on reload / navigation) */
  frameSrc: string | null;
  /** load `path` in the preview (in-app navigation through the bridge when possible) */
  navigatePreview: (path: string) => Promise<void>;
  /** fresh SSO URL for "open in new tab" */
  openPreviewTab: () => Promise<void>;
  previewPath: string;
  setPreviewPath: (p: string) => void;
  device: Device;
  setDevice: (d: Device) => void;
  runtimeErrors: RuntimeError[];
  pushRuntimeError: (e: RuntimeError) => void;
  clearRuntimeErrors: () => void;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  bridgeReady: boolean;
  setBridgeReady: (v: boolean) => void;
  toBridge: (m: EditorMessage) => void;
  previewOrigin: string | null;
  // views
  view: EditorView;
  setView: (v: EditorView) => void;
  panel: Panel;
  setPanel: (p: Panel) => void;
  mobileTab: "chat" | "preview";
  setMobileTab: (t: "chat" | "preview") => void;
  // visual edit
  visual: boolean;
  setVisual: (v: boolean) => void;
  selection: ElementInfo | null;
  setSelection: (e: ElementInfo | null) => void;
  applyOps: (ops: VisualEditOp[], label?: string) => Promise<boolean>;
  editing: boolean;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
  restore: (sha: string, label?: string) => Promise<boolean>;
  headVersion: number;
};

const EditorCtx = createContext<Ctx | null>(null);
export function useEditor(): Ctx {
  const c = useContext(EditorCtx);
  if (!c) throw new Error("useEditor outside <EditorProvider>");
  return c;
}

export { errMessage } from "@/lib/builder-ui/errors";

const DEVICE_KEY = "ld-builder-device";

export function EditorProvider({ team, role, initial, children }: { team: string; role: string; initial: BuilderProject; children: ReactNode }) {
  const toast = useToast();
  const B = useMemo(() => builderApi(), []);
  const [project, setProject] = useState<BuilderProject>(initial);
  const [messages, setMessages] = useState<BuilderMessage[]>([]);
  const [runs, setRuns] = useState<Record<string, RunView>>({});
  const [activeRunId, setActiveRunId] = useState<string | null>(initial.activeRunId ?? null);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState<Ctx["draft"]>({ text: "", nonce: 0 });
  const [credits, setCredits] = useState<Credits | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ status: initial.previewStatus, url: initial.previewUrl, error: initial.previewError });
  const [previewKey, setPreviewKey] = useState(0);
  const [previewPath, setPreviewPath] = useState("/");
  const [device, setDeviceState] = useState<Device>("desktop");
  const [runtimeErrors, setRuntimeErrors] = useState<RuntimeError[]>([]);
  const [bridgeReady, setBridgeReady] = useState(false);
  const [view, setView] = useState<EditorView>("preview");
  const [panel, setPanel] = useState<Panel>(null);
  const [mobileTab, setMobileTab] = useState<"chat" | "preview">("chat");
  const [visual, setVisualState] = useState(false);
  const [selection, setSelection] = useState<ElementInfo | null>(null);
  const [editing, setEditing] = useState(false);
  const [undoStack, setUndo] = useState<{ before: string; after: string; label: string }[]>([]);
  const [redoStack, setRedo] = useState<{ before: string; after: string; label: string }[]>([]);
  const [headVersion, setHeadVersion] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const reloadRef = useRef<() => void>(() => {});
  const streams = useRef(new Map<string, () => void>());
  const seenRuns = useRef(new Set<string>());
  const projectRef = useRef(project);
  projectRef.current = project;

  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const previewOrigin = useMemo(() => (frameSrc?.startsWith("mock:") ? "*" : originOf(preview.publicUrl ?? frameSrc)), [frameSrc, preview.publicUrl]);
  const toBridge = useCallback((m: EditorMessage) => postToBridge(iframeRef.current?.contentWindow, previewOrigin ?? "*", m), [previewOrigin]);

  useEffect(() => {
    try {
      const d = localStorage.getItem(DEVICE_KEY) as Device | null;
      if (d === "desktop" || d === "tablet" || d === "mobile") setDeviceState(d);
    } catch {}
  }, []);
  const setDevice = useCallback((d: Device) => {
    setDeviceState(d);
    try {
      localStorage.setItem(DEVICE_KEY, d);
    } catch {}
  }, []);

  const refreshProject = useCallback(async () => {
    try {
      const p = await B.getProject(projectRef.current.id);
      setProject(p);
    } catch {}
  }, [B]);

  const refreshCredits = useCallback(() => {
    B.credits(team).then(setCredits, () => {});
  }, [B, team]);

  // ── run streaming ────────────────────────────────────────────────────────
  const follow = useCallback(
    (runId: string, live = true) => {
      if (streams.current.has(runId)) return;
      seenRuns.current.add(runId);
      setRuns((r) => (r[runId] ? r : { ...r, [runId]: emptyRun(runId) }));
      const close = streamRun(
        projectRef.current.id,
        runId,
        (ev) => {
          setRuns((r) => ({ ...r, [runId]: reduceRun(r[runId] ?? emptyRun(runId), ev) }));
          if (ev.type === "commit" && live) setHeadVersion((v) => v + 1);
          if (ev.type === "status" && isTerminal(String((ev.data as { status: string }).status))) {
            setActiveRunId((cur) => (cur === runId ? null : cur));
          }
        },
        {
          onEnd: () => {
            streams.current.get(runId)?.();
            streams.current.delete(runId);
            setActiveRunId((cur) => (cur === runId ? null : cur));
            if (!live) return; // replay of a finished run: nothing changed
            // final state (assistant message, commit, credits)
            void B.messages(projectRef.current.id).then(setMessages, () => {});
            void refreshProject();
            refreshCredits();
            setHeadVersion((v) => v + 1);
            // next dev hot-reloads on commits; a fresh load also covers a broken HMR socket / new routes
            setTimeout(() => reloadRef.current(), 1500);
          },
        },
      );
      streams.current.set(runId, close);
    },
    [B, refreshProject, refreshCredits],
  );

  useEffect(() => {
    const s = streams.current;
    return () => {
      s.forEach((c) => c());
      s.clear();
    };
  }, []);

  // initial load: messages, last runs (replay the latest one), credits
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [msgs, runList] = await Promise.all([B.messages(project.id), B.runs(project.id).catch(() => [])]);
        if (!alive) return;
        setMessages(msgs);
        const active = runList.find((r) => !isTerminal(r.status));
        // seed views from the stored runs (steps/plan/error), then replay events of the most recent ones
        setRuns((cur) => {
          const next = { ...cur };
          // the 3 most recent runs are replayed from their event stream; older ones are seeded from the stored run
          for (const r of runList.slice(3, 20)) {
            if (next[r.id]) continue;
            const v = emptyRun(r.id, r.status);
            v.steps = Array.isArray(r.steps) ? r.steps : (r.plan?.steps ?? []);
            v.planSummary = r.plan?.summary;
            v.error = r.error;
            next[r.id] = v;
          }
          return next;
        });
        for (const r of runList.slice(0, 3)) follow(r.id, !isTerminal(r.status));
        if (active) setActiveRunId(active.id);
      } catch (e) {
        toast.error("Could not load the conversation", errMessage(e));
      }
    })();
    refreshCredits();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  // runs started elsewhere (another tab, a teammate, the CLI) → pick them up
  useEffect(() => {
    const t = setInterval(() => void refreshProject(), 10_000);
    return () => clearInterval(t);
  }, [refreshProject]);
  useEffect(() => {
    const rid = project.activeRunId;
    if (!rid || streams.current.has(rid) || seenRuns.current.has(rid)) return;
    void B.messages(project.id).then(setMessages, () => {});
    setActiveRunId(rid);
    follow(rid, true);
  }, [project.activeRunId, project.id, B, follow]);

  // ── preview status polling ──────────────────────────────────────────────
  const pollPreview = useCallback(async () => {
    try {
      const p = await B.preview(projectRef.current.id);
      setPreview((cur) => {
        return p;
      });
      if (p.errors?.length) setRuntimeErrors((cur) => (cur.length ? cur : p.errors!.slice(-5)));
    } catch {}
  }, [B]);

  useEffect(() => {
    void pollPreview();
  }, [pollPreview]);

  useEffect(() => {
    const fast = preview.status === "STARTING" || !!activeRunId;
    const t = setInterval(() => void pollPreview(), fast ? 2500 : 20_000);
    return () => clearInterval(t);
  }, [preview.status, activeRunId, pollPreview]);

  // auto-start the preview when the editor opens on a stopped app (idle-stopped after 20 min)
  const autoStarted = useRef(false);
  const startPreview = useCallback(
    async (restart = false) => {
      try {
        setPreview((p) => ({ ...p, status: "STARTING", error: null }));
        const p = await B.startPreview(projectRef.current.id, restart);
        setPreview((cur) => ({ ...cur, ...p }));
        setBridgeReady(false);
      } catch (e) {
        setPreview((p) => ({ ...p, status: "ERROR", error: errMessage(e) }));
      }
    },
    [B],
  );
  useEffect(() => {
    if (autoStarted.current) return;
    if (preview.status === "STOPPED" && project.lastCommit) {
      autoStarted.current = true;
      void startPreview();
    }
  }, [preview.status, project.lastCommit, startPreview]);

  const pathRef = useRef(previewPath);
  pathRef.current = previewPath;
  const loadFrame = useCallback(
    async (path: string) => {
      try {
        const url = await B.previewUrl(projectRef.current.id, path);
        setBridgeReady(false);
        setFrameSrc(url);
        setPreviewKey((k) => k + 1);
      } catch (e) {
        toast.error("Could not open the preview", errMessage(e));
      }
    },
    [B, toast],
  );
  // first load once the preview runs; drop the frame when it stops
  useEffect(() => {
    if (preview.status === "RUNNING" && !frameSrc) void loadFrame(pathRef.current);
    if (preview.status !== "RUNNING" && frameSrc) setFrameSrc(null);
  }, [preview.status, frameSrc, loadFrame]);

  const reloadPreview = useCallback(() => {
    if (isMock()) {
      setBridgeReady(false);
      setPreviewKey((k) => k + 1);
      return;
    }
    void loadFrame(pathRef.current);
  }, [loadFrame]);

  reloadRef.current = reloadPreview;

  const navigatePreview = useCallback(
    async (path: string) => {
      setPreviewPath(path);
      if (bridgeReady && !isMock()) toBridge({ type: "navigate", path });
      else await loadFrame(path);
    },
    [bridgeReady, toBridge, loadFrame],
  );

  const openPreviewTab = useCallback(async () => {
    const w = window.open("about:blank", "_blank");
    try {
      const url = await B.previewUrl(projectRef.current.id, pathRef.current);
      if (w) w.location.href = url;
    } catch (e) {
      w?.close();
      toast.error("Could not open the preview", errMessage(e));
    }
  }, [B, toast]);

  // ── chat ────────────────────────────────────────────────────────────────
  const send = useCallback<Ctx["send"]>(
    async (prompt, attachments = [], opts = {}) => {
      if (!prompt.trim() && !attachments.length) return false;
      setSending(true);
      try {
        const { run, message, credits: c } = await B.startRun(projectRef.current.id, { prompt: prompt.trim(), attachments, kind: opts.kind ?? "build", context: opts.context });
        if (c) setCredits(c);
        if (message) setMessages((m) => [...m, message]);
        else setMessages((m) => [...m, { id: `local-${Date.now()}`, role: "USER", content: prompt.trim(), attachments, createdAt: new Date().toISOString(), agentRunId: run.id }]);
        setRuns((r) => ({ ...r, [run.id]: emptyRun(run.id, run.status) }));
        setActiveRunId(run.id);
        follow(run.id);
        setMobileTab("chat");
        return true;
      } catch (e) {
        toast.error("Could not send the message", errMessage(e));
        return false;
      } finally {
        setSending(false);
      }
    },
    [B, follow, toast],
  );

  const stop = useCallback(async () => {
    if (!activeRunId) return;
    try {
      await B.cancelRun(projectRef.current.id, activeRunId);
      toast.info("Stopping…", "The agent stops after the current step. The app stays at the last good version.");
    } catch (e) {
      toast.error("Could not stop the run", errMessage(e));
    }
  }, [B, activeRunId, toast]);

  const prefill = useCallback((text: string, attachments?: Attachment[]) => {
    setDraft((d) => ({ text, attachments, nonce: d.nonce + 1 }));
    setMobileTab("chat");
  }, []);

  // ── visual edit ────────────────────────────────────────────────────────
  const setVisual = useCallback(
    (v: boolean) => {
      setVisualState(v);
      if (v) setView("preview");
      if (!v) setSelection(null);
      toBridge({ type: "mode", enabled: v });
    },
    [toBridge],
  );

  const applyOps = useCallback(
    async (ops: VisualEditOp[], label?: string) => {
      const before = projectRef.current.lastCommit ?? "";
      setEditing(true);
      try {
        const r = await B.visualEdit(projectRef.current.id, ops, label);
        if (r.commit) {
          setUndo((s) => [...s.slice(-49), { before, after: r.commit!.sha, label: label ?? r.commit!.message }]);
          setRedo([]);
          setProject((p) => ({ ...p, lastCommit: r.commit!.sha }));
          setHeadVersion((v) => v + 1);
        }
        return true;
      } catch (e) {
        toast.error("Could not apply the change", errMessage(e));
        return false;
      } finally {
        setEditing(false);
      }
    },
    [B, toast],
  );

  const restore = useCallback(
    async (sha: string, label?: string) => {
      try {
        const r = await B.restore(projectRef.current.id, sha);
        setProject((p) => ({ ...p, lastCommit: r.commit.sha }));
        setHeadVersion((v) => v + 1);
        void B.messages(projectRef.current.id).then(setMessages, () => {});
        if (label) toast.success(label);
        return true;
      } catch (e) {
        toast.error("Could not restore this version", errMessage(e));
        return false;
      }
    },
    [B, toast],
  );

  const undo = useCallback(async () => {
    const last = undoStack[undoStack.length - 1];
    if (!last || !last.before) return;
    if (await restore(last.before)) {
      setUndo((s) => s.slice(0, -1));
      setRedo((s) => [...s, last]);
      toast.info("Undone", last.label);
    }
  }, [undoStack, restore, toast]);

  const redo = useCallback(async () => {
    const last = redoStack[redoStack.length - 1];
    if (!last) return;
    if (await restore(last.after)) {
      setRedo((s) => s.slice(0, -1));
      setUndo((s) => [...s, last]);
      toast.info("Redone", last.label);
    }
  }, [redoStack, restore, toast]);

  const pushRuntimeError = useCallback((e: RuntimeError) => {
    setRuntimeErrors((cur) => (cur.some((x) => x.message === e.message) ? cur : [...cur.slice(-4), e]));
  }, []);
  const clearRuntimeErrors = useCallback(() => {
    setRuntimeErrors([]);
    if (!isMock()) void B.clearPreviewErrors(projectRef.current.id).catch(() => {});
  }, [B]);

  // keep the bridge in sync after reloads (HMR full reloads re-send "ready")
  useEffect(() => {
    if (bridgeReady) toBridge({ type: "mode", enabled: visual });
  }, [bridgeReady, visual, toBridge]);

  // a run finishing or a commit landing makes next dev reload via HMR; mock mode has no HMR → reload
  useEffect(() => {
    if (headVersion && isMock()) reloadPreview();
  }, [headVersion, reloadPreview]);

  const value: Ctx = {
    team, role, project, setProject, refreshProject,
    messages, runs, activeRunId, sending, send, stop, draft, prefill, credits,
    preview, startPreview, previewKey, reloadPreview, frameSrc, navigatePreview, openPreviewTab, previewPath, setPreviewPath, device, setDevice,
    runtimeErrors, pushRuntimeError, clearRuntimeErrors, iframeRef, bridgeReady, setBridgeReady, toBridge, previewOrigin,
    view, setView, panel, setPanel, mobileTab, setMobileTab,
    visual, setVisual, selection, setSelection, applyOps, editing, undo, redo, canUndo: undoStack.length > 0, canRedo: redoStack.length > 0, restore, headVersion,
  };
  return <EditorCtx.Provider value={value}>{children}</EditorCtx.Provider>;
}
