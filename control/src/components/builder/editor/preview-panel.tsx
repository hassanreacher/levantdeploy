"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ExternalLink, Hammer, Loader2, Monitor, MousePointerClick, Play, RefreshCw, Smartphone, Tablet, Wrench, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isBridgeMessage } from "@/lib/builder-ui/bridge";
import { mockPreviewHtml } from "@/lib/builder-ui/mock";
import { useEditor, type Device } from "./context";
import { AddSectionDrawer } from "./add-section";

const DEVICES: { id: Device; label: string; icon: React.ReactNode; w?: number; h?: number }[] = [
  { id: "desktop", label: "Desktop", icon: <Monitor className="h-3.5 w-3.5" /> },
  { id: "tablet", label: "Tablet", icon: <Tablet className="h-3.5 w-3.5" />, w: 768, h: 1024 },
  { id: "mobile", label: "Mobile", icon: <Smartphone className="h-3.5 w-3.5" />, w: 390, h: 844 },
];

export function PreviewPanel() {
  const ed = useEditor();
  const { preview, previewPath, setPreviewPath, iframeRef, previewOrigin } = ed;
  const [pathInput, setPathInput] = useState(previewPath);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [sectionDrawer, setSectionDrawer] = useState(false);
  useEffect(() => setPathInput(previewPath), [previewPath]);

  const mock = !!ed.frameSrc?.startsWith("mock:");
  const src = mock ? null : ed.frameSrc;
  const frameKey = `${ed.previewKey}-${src ?? "mock"}`;
  const loaded = loadedKey === frameKey;

  // ── bridge messages ──────────────────────────────────────────────────────
  const { setBridgeReady, setSelection, applyOps, pushRuntimeError, toBridge, visual, selection } = ed;
  const onMessage = useCallback(
    (e: MessageEvent) => {
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      if (previewOrigin && previewOrigin !== "*" && e.origin !== previewOrigin) return;
      const m = e.data;
      if (!isBridgeMessage(m)) return;
      switch (m.type) {
        case "ready":
          setBridgeReady(true);
          if (m.route?.startsWith("/")) setPreviewPath(m.route);
          if (visual && selection) setTimeout(() => toBridge({ type: "select", src: selection.src }), 50);
          break;
        case "navigate":
          setPreviewPath(m.path);
          break;
        case "select":
          setSelection(m.el);
          break;
        case "deselect":
          setSelection(null);
          break;
        case "text":
          void applyOps([{ op: "setText", src: m.src, text: m.text }], "Edit text");
          break;
        case "move":
          void applyOps([{ op: "move", src: m.src, target: m.target, position: m.position }], "Reorder");
          break;
        case "error":
          pushRuntimeError({ message: m.message, stack: m.stack, source: m.source, route: m.route, at: new Date().toISOString() });
          break;
      }
    },
    [iframeRef, previewOrigin, setBridgeReady, setPreviewPath, setSelection, applyOps, pushRuntimeError, toBridge, visual, selection],
  );
  useEffect(() => {
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onMessage]);

  const navigate = (p: string) => {
    const path = p.trim() ? (p.trim().startsWith("/") ? p.trim() : `/${p.trim()}`) : "/";
    void ed.navigatePreview(path);
  };

  const dev = DEVICES.find((d) => d.id === ed.device)!;
  const running = preview.status === "RUNNING" && (!!src || mock);
  const building = !ed.project.lastCommit || (ed.project.status === "GENERATING" && !running);
  const err = ed.runtimeErrors[ed.runtimeErrors.length - 1];

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg-subtle">
      {/* toolbar */}
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border bg-bg px-2">
        <div className="hidden items-center rounded-md border border-border p-0.5 sm:flex" role="radiogroup" aria-label="Device">
          {DEVICES.map((d) => (
            <button
              key={d.id}
              role="radio"
              aria-checked={ed.device === d.id}
              aria-label={d.label}
              title={d.label}
              onClick={() => ed.setDevice(d.id)}
              className={cn("flex h-6 w-7 items-center justify-center rounded text-muted transition-colors", ed.device === d.id ? "bg-surface-2 text-fg" : "hover:text-fg")}
            >
              {d.icon}
            </button>
          ))}
        </div>
        <form
          className="flex min-w-0 flex-1 items-center"
          onSubmit={(e) => {
            e.preventDefault();
            navigate(pathInput);
          }}
        >
          <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border bg-bg-subtle px-2 focus-within:border-border-strong">
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", preview.status === "RUNNING" ? "bg-success" : preview.status === "STARTING" ? "animate-pulse2 bg-warning" : preview.status === "ERROR" ? "bg-danger" : "bg-subtle")} title={`Preview ${String(preview.status).toLowerCase()}`} />
            <input value={pathInput} onChange={(e) => setPathInput(e.target.value)} aria-label="Route path" spellCheck={false} className="min-w-0 flex-1 bg-transparent font-mono text-[12px] outline-none" data-testid="route-input" />
          </div>
        </form>
        <Button size="icon-sm" variant="ghost" aria-label="Refresh preview" title="Refresh" onClick={ed.reloadPreview} disabled={!running}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Open preview in a new tab" title="Open in new tab" onClick={() => void ed.openPreviewTab()} disabled={!running || mock}>
          <ExternalLink className="h-3.5 w-3.5" />
        </Button>
      </div>
      {ed.visual && running && (
        <div className="flex shrink-0 items-center gap-2 border-b border-accent/30 bg-accent/10 px-3 py-1.5 text-[12px] text-accent">
          <MousePointerClick className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Click an element to edit it · double-click text to type · drag ☰ to reorder</span>
          {ed.editing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          <Button size="sm" variant="ghost" className="h-6 px-2 text-accent hover:text-accent" onClick={() => setSectionDrawer(true)} disabled={!selection}>
            + Add section
          </Button>
        </div>
      )}
      {/* stage */}
      <div className="relative min-h-0 flex-1 overflow-auto">
        {running ? (
          <div className={cn("flex h-full min-h-full justify-center", dev.w && "p-4 sm:p-6")}>
            <div
              className={cn("relative h-full w-full overflow-hidden bg-white", dev.w && "rounded-[18px] border-[6px] border-surface-2 shadow-pop")}
              style={dev.w ? { width: dev.w + 12, maxWidth: "100%", height: Math.min(dev.h! + 12, 2000), maxHeight: "100%" } : undefined}
            >
              {!loaded && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-bg-subtle">
                  <Loader2 className="h-5 w-5 animate-spin text-muted" />
                </div>
              )}
              <iframe
                key={frameKey}
                ref={iframeRef}
                src={mock ? undefined : (src ?? undefined)}
                srcDoc={mock ? mockPreviewHtml() : undefined}
                title={`Preview of ${ed.project.name}`}
                onLoad={() => setLoadedKey(frameKey)}
                className="h-full w-full border-0 bg-white"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
                allow="clipboard-write"
                data-testid="preview-iframe"
              />
            </div>
          </div>
        ) : building && preview.status !== "ERROR" ? (
          <BuildingState />
        ) : (
          <PreviewState />
        )}
        {err && running && (
          <div className="absolute inset-x-3 bottom-3 z-20 flex animate-slide-up items-start gap-2.5 rounded-lg border border-danger/30 bg-surface p-3 shadow-pop" role="alert" data-testid="runtime-error">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium">Your app hit an error{err.route ? <span className="font-normal text-muted"> on {err.route}</span> : null}</p>
              <p className="mt-0.5 line-clamp-2 break-words font-mono text-[11.5px] text-muted">{err.message}</p>
            </div>
            <Button
              size="sm"
              variant="primary"
              leftIcon={<Wrench className="h-3.5 w-3.5" />}
              disabled={!!ed.activeRunId}
              onClick={async () => {
                const ok = await ed.send(`Fix this runtime error${err.route ? ` on ${err.route}` : ""}:\n\n${err.message}`, [], { kind: "fix", context: { errors: ed.runtimeErrors } });
                if (ok) ed.clearRuntimeErrors();
              }}
            >
              Try to fix
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label="Dismiss" onClick={ed.clearRuntimeErrors}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>
      <AddSectionDrawer open={sectionDrawer} onClose={() => setSectionDrawer(false)} />
    </div>
  );
}

function BuildingState() {
  const ed = useEditor();
  return (
    <div className="flex h-full flex-col items-center justify-center p-6 text-center" data-testid="preview-building">
      <div className="relative mb-5 h-36 w-56 overflow-hidden rounded-lg border border-border bg-surface">
        <div className="flex h-5 items-center gap-1 border-b border-border px-2">
          {[0, 1, 2].map((i) => (
            <span key={i} className="h-1.5 w-1.5 rounded-full bg-border-strong" />
          ))}
        </div>
        <div className="space-y-2 p-3">
          <div className="h-3 w-2/3 animate-pulse2 rounded bg-surface-2" />
          <div className="h-2 w-full animate-pulse2 rounded bg-surface-2" style={{ animationDelay: ".2s" }} />
          <div className="h-2 w-5/6 animate-pulse2 rounded bg-surface-2" style={{ animationDelay: ".3s" }} />
          <div className="mt-3 grid grid-cols-3 gap-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-10 animate-pulse2 rounded bg-surface-2" style={{ animationDelay: `${0.4 + i * 0.15}s` }} />
            ))}
          </div>
        </div>
      </div>
      <p className="flex items-center gap-2 font-medium">
        <Hammer className="h-4 w-4 text-accent" /> Building your app…
      </p>
      <p className="mt-1 max-w-sm text-[13px] text-muted">The preview appears here as soon as the first version compiles. You can close this tab — the agents keep working.</p>
      {!ed.activeRunId && ed.project.status !== "GENERATING" && (
        <Button className="mt-4" size="sm" onClick={() => ed.prefill(ed.project.prompt ?? "Build the app")}>
          Start building
        </Button>
      )}
    </div>
  );
}

function PreviewState() {
  const ed = useEditor();
  const s = ed.preview.status;
  return (
    <div className="flex h-full flex-col items-center justify-center p-6 text-center" data-testid={`preview-${String(s).toLowerCase()}`}>
      {s === "STARTING" ? (
        <>
          <Loader2 className="mb-3 h-6 w-6 animate-spin text-muted" />
          <p className="font-medium">Starting the preview…</p>
          <p className="mt-1 max-w-sm text-[13px] text-muted">Booting the dev server with hot reload. This takes a few seconds.</p>
        </>
      ) : s === "ERROR" ? (
        <>
          <AlertTriangle className="mb-3 h-6 w-6 text-danger" />
          <p className="font-medium">The preview could not start</p>
          {ed.preview.error && <pre className="mt-2 max-h-40 max-w-lg overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface p-2 text-left font-mono text-[11.5px] text-muted">{ed.preview.error}</pre>}
          <div className="mt-4 flex gap-2">
            <Button size="sm" onClick={() => void ed.startPreview(true)} leftIcon={<RefreshCw className="h-3.5 w-3.5" />}>
              Restart
            </Button>
            <Button size="sm" variant="primary" disabled={!!ed.activeRunId} leftIcon={<Wrench className="h-3.5 w-3.5" />} onClick={() => void ed.send(`The preview fails to start:\n\n${ed.preview.error ?? "unknown error"}\n\nPlease fix it.`, [], { kind: "fix" })}>
              Try to fix
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface">
            <Play className="h-4 w-4 text-muted" />
          </div>
          <p className="font-medium">The preview is asleep</p>
          <p className="mt-1 max-w-sm text-[13px] text-muted">Previews stop after 20 minutes without activity to save resources.</p>
          <Button className="mt-4" size="sm" variant="primary" onClick={() => void ed.startPreview()} leftIcon={<Play className="h-3.5 w-3.5" />} data-testid="preview-start">
            Start preview
          </Button>
        </>
      )}
    </div>
  );
}
