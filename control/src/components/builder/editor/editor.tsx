"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Code2,
  Database,
  History,
  Keyboard,
  Loader2,
  MessageSquare,
  Monitor,
  MoreHorizontal,
  MousePointerClick,
  Rocket,
  Settings2,
  Share2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dropdown, DropdownItem, DropdownSeparator } from "@/components/ui/dropdown";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { builderApi } from "@/lib/builder-ui/api";
import type { BuilderProject } from "@/lib/builder-ui/types";
import { EditorProvider, errMessage, useEditor, type EditorView } from "./context";
import { ChatPanel } from "./chat-panel";
import { PreviewPanel } from "./preview-panel";
import { Inspector } from "./inspector";
import { CodeView } from "./code-view";
import { HistoryView } from "./history-view";
import { BackendPanel } from "./backend-panel";
import { PublishDialog } from "./publish-dialog";
import { SettingsDialog } from "./settings-dialog";
import { ShareDialog } from "./share-dialog";
import { isEditableTarget, SHORTCUTS, modKey } from "./shortcuts";

export function BuilderEditor({ team, role, project }: { team: string; role: string; project: BuilderProject }) {
  return (
    <EditorProvider team={team} role={role} initial={project}>
      <EditorLayout />
    </EditorProvider>
  );
}

const CHAT_W_KEY = "ld-builder-chat-w";

function EditorLayout() {
  const ed = useEditor();
  const [chatW, setChatW] = useState(420);
  const [help, setHelp] = useState(false);
  const dragging = useRef(false);

  useEffect(() => {
    try {
      const w = Number(localStorage.getItem(CHAT_W_KEY));
      if (w >= 320 && w <= 720) setChatW(w);
    } catch {}
  }, []);

  const onResizeStart = (e: React.PointerEvent) => {
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onResizeMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    setChatW(Math.max(320, Math.min(720, e.clientX)));
  };
  const onResizeEnd = () => {
    dragging.current = false;
    try {
      localStorage.setItem(CHAT_W_KEY, String(chatW));
    } catch {}
  };

  // ── keyboard shortcuts ───────────────────────────────────────────────────
  const { setVisual, visual, setView, undo, redo, setSelection, selection, toBridge, setPanel } = ed;
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const typing = isEditableTarget(e.target);
      if (mod && !e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setVisual(!visual);
      } else if (e.altKey && !mod && /^Digit[123]$/.test(e.code)) {
        e.preventDefault();
        const v: EditorView[] = ["preview", "code", "history"];
        setView(v[Number(e.code.slice(5)) - 1]!);
      } else if (visual && mod && e.key.toLowerCase() === "z" && !typing) {
        e.preventDefault();
        void (e.shiftKey ? redo() : undo());
      } else if (visual && mod && e.key.toLowerCase() === "y" && !typing) {
        e.preventDefault();
        void redo();
      } else if (e.key === "Escape" && !typing) {
        if (selection) {
          setSelection(null);
          toBridge({ type: "select", src: null });
        } else if (visual) setVisual(false);
      } else if (e.key === "?" && !typing && !mod) {
        setHelp(true);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setPanel("publish");
      }
    },
    [setVisual, visual, setView, undo, redo, selection, setSelection, toBridge, setPanel],
  );
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  const leftIsInspector = ed.visual && !!ed.selection;

  return (
    <div className="fixed inset-0 flex flex-col bg-bg" data-testid="builder-editor">
      <TopBar onHelp={() => setHelp(true)} />
      {/* mobile tabs */}
      <div className="flex shrink-0 border-b border-border md:hidden" role="tablist" aria-label="Editor panes">
        {(["chat", "preview"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={ed.mobileTab === t}
            onClick={() => ed.setMobileTab(t)}
            className={cn("flex h-10 flex-1 items-center justify-center gap-1.5 text-[13px] font-medium transition-colors", ed.mobileTab === t ? "border-b-2 border-fg text-fg" : "text-muted")}
          >
            {t === "chat" ? <MessageSquare className="h-3.5 w-3.5" /> : <Monitor className="h-3.5 w-3.5" />}
            {t === "chat" ? (leftIsInspector ? "Edit" : "Chat") : ed.view === "code" ? "Code" : ed.view === "history" ? "History" : "Preview"}
            {t === "chat" && ed.activeRunId && <Loader2 className="h-3 w-3 animate-spin text-accent" />}
          </button>
        ))}
      </div>
      <div className="relative flex min-h-0 flex-1">
        <aside
          className={cn("min-h-0 shrink-0 flex-col border-r border-border bg-bg md:flex", ed.mobileTab === "chat" ? "flex w-full md:w-auto" : "hidden")}
          style={{ ["--chat-w" as string]: `${chatW}px` }}
          aria-label={leftIsInspector ? "Element editor" : "Chat"}
        >
          <div className="flex min-h-0 w-full flex-1 flex-col md:w-[var(--chat-w)]">{leftIsInspector ? <Inspector /> : <ChatPanel />}</div>
        </aside>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat panel"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") setChatW((w) => Math.max(320, w - 20));
            if (e.key === "ArrowRight") setChatW((w) => Math.min(720, w + 20));
          }}
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          className="absolute bottom-0 top-0 z-10 hidden w-1.5 -translate-x-1/2 cursor-col-resize transition-colors hover:bg-accent/40 md:block"
          style={{ left: chatW }}
        />
        <section className={cn("min-h-0 min-w-0 flex-1 flex-col md:flex", ed.mobileTab === "preview" ? "flex" : "hidden")} aria-label="Workspace">
          {ed.view === "code" ? <CodeView /> : ed.view === "history" ? <HistoryView /> : <PreviewPanel />}
        </section>
      </div>
      <BackendPanel />
      <PublishDialog />
      <SettingsDialog />
      <ShareDialog />
      <Dialog open={help} onClose={() => setHelp(false)} title="Keyboard shortcuts" size="sm">
        <ul className="space-y-2 text-[13px]">
          {SHORTCUTS.map((s) => (
            <li key={s.label} className="flex items-center justify-between gap-4">
              <span className="text-muted">{s.label}</span>
              <span className="flex gap-1">
                {s.keys.map((k) => (
                  <kbd key={k} className="kbd">
                    {k === "Mod" ? modKey() : k}
                  </kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </Dialog>
    </div>
  );
}

function TopBar({ onHelp }: { onHelp: () => void }) {
  const ed = useEditor();
  const toast = useToast();
  const { project } = ed;
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(project.name);
  useEffect(() => setName(project.name), [project.name]);

  const saveName = async () => {
    setRenaming(false);
    const n = name.trim();
    if (!n || n === project.name) return setName(project.name);
    try {
      ed.setProject(await builderApi().updateProject(project.id, { name: n }));
    } catch (e) {
      setName(project.name);
      toast.error("Could not rename", errMessage(e));
    }
  };

  const running = !!ed.activeRunId || project.status === "GENERATING";
  const viewBtn = (v: EditorView, icon: React.ReactNode, label: string, shortcut: string) => (
    <Button
      size="sm"
      variant={ed.view === v ? "secondary" : "ghost"}
      leftIcon={icon}
      onClick={() => {
        ed.setView(ed.view === v ? "preview" : v);
        ed.setMobileTab("preview");
        if (v !== "preview" && ed.visual) ed.setVisual(false);
      }}
      aria-pressed={ed.view === v}
      title={`${label} (${shortcut})`}
      className="hidden lg:inline-flex"
    >
      {label}
    </Button>
  );

  return (
    <header className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border px-2 sm:px-3">
      <Link href={`/${ed.team}/build`} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg" aria-label="Back to your apps" title="Back to your apps">
        <ArrowLeft className="h-4 w-4" />
      </Link>
      <div className="flex min-w-0 items-center gap-2">
        {renaming ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void saveName()}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                setName(project.name);
                setRenaming(false);
              }
            }}
            maxLength={60}
            aria-label="Project name"
            className="h-8 w-[min(220px,40vw)] rounded-md border border-border-strong bg-bg px-2 text-[14px] font-medium outline-none focus:border-accent"
          />
        ) : (
          <button onClick={() => setRenaming(true)} className="truncate rounded-md px-1.5 py-1 text-[14px] font-medium text-fg hover:bg-surface-2" title="Rename">
            {project.name}
          </button>
        )}
        {running ? (
          <span className="hidden items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[11.5px] font-medium text-accent sm:inline-flex">
            <Loader2 className="h-3 w-3 animate-spin" /> Building
          </span>
        ) : project.lastPublishedAt ? (
          <span className="hidden items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11.5px] text-muted sm:inline-flex">
            <span className="h-1.5 w-1.5 rounded-full bg-success" /> Published
          </span>
        ) : null}
      </div>
      <div className="ml-auto flex items-center gap-1">
        <Button
          size="sm"
          variant={ed.visual ? "accent" : "ghost"}
          leftIcon={<MousePointerClick className="h-3.5 w-3.5" />}
          onClick={() => {
            ed.setVisual(!ed.visual);
            ed.setMobileTab("preview");
          }}
          aria-pressed={ed.visual}
          title={`Visual edit (${modKey()}E)`}
          data-testid="visual-toggle"
          disabled={ed.preview.status !== "RUNNING"}
        >
          <span className="hidden sm:inline">Visual edit</span>
        </Button>
        {viewBtn("code", <Code2 className="h-3.5 w-3.5" />, "Code", "Alt+2")}
        {viewBtn("history", <History className="h-3.5 w-3.5" />, "History", "Alt+3")}
        <Button size="sm" variant="ghost" leftIcon={<Database className="h-3.5 w-3.5" />} onClick={() => ed.setPanel("backend")} className="hidden lg:inline-flex">
          Backend
        </Button>
        <Dropdown
          align="end"
          width={220}
          trigger={() => (
            <Button size="icon-sm" variant="ghost" aria-label="More">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          )}
        >
          {(close) => (
            <>
              <div className="lg:hidden">
                <DropdownItem icon={<Code2 className="h-3.5 w-3.5" />} onClick={() => (close(), ed.setView("code"), ed.setMobileTab("preview"))}>
                  Code
                </DropdownItem>
                <DropdownItem icon={<History className="h-3.5 w-3.5" />} onClick={() => (close(), ed.setView("history"), ed.setMobileTab("preview"))}>
                  History
                </DropdownItem>
                <DropdownItem icon={<Database className="h-3.5 w-3.5" />} onClick={() => (close(), ed.setPanel("backend"))}>
                  Backend
                </DropdownItem>
                <DropdownSeparator />
              </div>
              <DropdownItem icon={<Settings2 className="h-3.5 w-3.5" />} onClick={() => (close(), ed.setPanel("settings"))}>
                Settings
              </DropdownItem>
              <DropdownItem icon={<Share2 className="h-3.5 w-3.5" />} onClick={() => (close(), ed.setPanel("share"))}>
                Share preview
              </DropdownItem>
              <DropdownItem icon={<Keyboard className="h-3.5 w-3.5" />} onClick={() => (close(), onHelp())}>
                Keyboard shortcuts
              </DropdownItem>
            </>
          )}
        </Dropdown>
        <Button size="sm" variant="outline" leftIcon={<Share2 className="h-3.5 w-3.5" />} onClick={() => ed.setPanel("share")} className="hidden xl:inline-flex">
          Share
        </Button>
        <Button size="sm" variant="primary" leftIcon={<Rocket className="h-3.5 w-3.5" />} onClick={() => ed.setPanel("publish")} data-testid="publish-open">
          {project.lastPublishedAt ? "Update" : "Publish"}
        </Button>
      </div>
    </header>
  );
}
