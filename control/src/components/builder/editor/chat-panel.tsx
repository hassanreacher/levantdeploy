"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDashed,
  FileCode2,
  FilePlus2,
  FileX2,
  ImagePlus,
  Loader2,
  MousePointerClick,
  RotateCcw,
  Sparkles,
  Square,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ai/markdown";
import { TimeAgo } from "@/components/dashboard/time-ago";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { imageToDataUrl } from "@/lib/builder-ui/image";
import { fallbackSuggestions } from "@/lib/builder-ui/prompts";
import { parseUnifiedDiff } from "@/lib/builder-ui/diff";
import { isTerminal, providerChips, type RunView } from "@/lib/builder-ui/run-state";
import type { Attachment, BuilderMessage, CheckResult, FileChange, RunStep } from "@/lib/builder-ui/types";
import { DiffStat, DiffView } from "../diff-view";
import { errMessage, useEditor } from "./context";
import { CreditCounter } from "../credit-counter";

export function ChatPanel() {
  const ed = useEditor();
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // assistant messages by run id → rendered inside the run block
  const { items, orphanRuns } = useMemo(() => {
    const byRun = new Map<string, BuilderMessage>();
    for (const m of ed.messages) if (m.role === "ASSISTANT" && m.agentRunId) byRun.set(m.agentRunId, m);
    const seenRuns = new Set<string>();
    const items: ({ kind: "msg"; m: BuilderMessage } | { kind: "run"; runId: string; m?: BuilderMessage })[] = [];
    for (const m of ed.messages) {
      if (m.role === "ASSISTANT" && m.agentRunId) {
        if (!seenRuns.has(m.agentRunId)) {
          seenRuns.add(m.agentRunId);
          items.push({ kind: "run", runId: m.agentRunId, m });
        }
      } else items.push({ kind: "msg", m });
    }
    const orphanRuns = Object.keys(ed.runs).filter((id) => !seenRuns.has(id) && (id === ed.activeRunId || !isTerminal(ed.runs[id]!.status) || ed.runs[id]!.lastSeq > 0));
    return { items, orphanRuns: orphanRuns.filter((id) => !byRun.has(id)) };
  }, [ed.messages, ed.runs, ed.activeRunId]);

  let lastRunId: string | undefined = orphanRuns[orphanRuns.length - 1];
  for (let i = items.length - 1; !lastRunId && i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === "run") lastRunId = it.runId;
  }

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={listRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-4" aria-live="polite" data-testid="chat-list">
        {items.length === 0 && orphanRuns.length === 0 ? (
          <EmptyChat />
        ) : (
          <div className="space-y-5">
            {items.map((it) =>
              it.kind === "msg" ? (
                <MessageItem key={it.m.id} m={it.m} />
              ) : (
                <RunBlock key={it.runId} runId={it.runId} message={it.m} isLast={it.runId === lastRunId} />
              ),
            )}
            {orphanRuns.map((id) => (
              <RunBlock key={id} runId={id} isLast={id === lastRunId} />
            ))}
          </div>
        )}
      </div>
      <Composer />
    </div>
  );
}

function EmptyChat() {
  const ed = useEditor();
  const ideas = ["Add a pricing section", "Add user sign-up and login", "Make the design more playful", "Add a contact form that saves to the database"];
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 text-center">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface">
        <Sparkles className="h-4 w-4 text-accent" />
      </div>
      <p className="font-medium">{ed.project.prompt ? "Ready to build" : "What should we build next?"}</p>
      <p className="mt-1 max-w-xs text-[13px] text-muted">Describe a change in plain language. The agents plan it, write the code, check it and update the preview.</p>
      {ed.project.prompt && (
        <Button className="mt-4" size="sm" variant="primary" leftIcon={<Sparkles className="h-3.5 w-3.5" />} disabled={!!ed.activeRunId || ed.sending} onClick={() => void ed.send(ed.project.prompt!, [], { kind: "build" })}>
          Build “{ed.project.prompt.length > 48 ? `${ed.project.prompt.slice(0, 48)}…` : ed.project.prompt}”
        </Button>
      )}
      <div className="mt-4 flex flex-wrap justify-center gap-1.5">
        {ideas.map((s) => (
          <button key={s} onClick={() => ed.prefill(s)} className="rounded-full border border-border px-3 py-1 text-[12px] text-muted transition-colors hover:border-border-strong hover:text-fg">
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function AttachmentChips({ items, onRemove }: { items: Attachment[]; onRemove?: (i: number) => void }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((a, i) =>
        a.kind === "image" && a.url ? (
          <span key={i} className="group relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={a.url} alt={a.name ?? "attachment"} className="h-14 w-14 rounded-md border border-border object-cover" />
            {onRemove && (
              <button onClick={() => onRemove(i)} className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-surface p-0.5 text-muted hover:text-fg" aria-label="Remove attachment">
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        ) : (
          <span key={i} className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-accent/30 bg-accent/10 px-2 py-1 text-[12px] text-accent">
            <MousePointerClick className="h-3 w-3 shrink-0" />
            <span className="truncate">{a.name ?? a.src ?? "element"}</span>
            {onRemove && (
              <button onClick={() => onRemove(i)} aria-label="Remove element context" className="hover:text-fg">
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        ),
      )}
    </div>
  );
}

function MessageItem({ m }: { m: BuilderMessage }) {
  if (m.role === "USER")
    return (
      <div className="flex flex-col items-end gap-1.5" data-testid="chat-user">
        <AttachmentChips items={m.attachments ?? []} />
        {m.content && <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-surface-2 px-3.5 py-2 text-[13.5px] leading-relaxed">{m.content}</div>}
      </div>
    );
  if (m.role === "SYSTEM")
    return (
      <p className="flex items-center justify-center gap-1.5 text-center text-[12px] text-subtle">
        <RotateCcw className="h-3 w-3" /> {m.content}
      </p>
    );
  return (
    <AssistantShell>
      <Markdown text={m.content} className="text-[13.5px]" />
      {m.commitSha && <RestoreButton sha={m.commitSha} at={m.createdAt} />}
    </AssistantShell>
  );
}

function AssistantShell({ children, busy }: { children: React.ReactNode; busy?: boolean }) {
  return (
    <div className="flex gap-2.5" data-testid="chat-assistant">
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-surface">
        {busy ? <Loader2 className="h-3 w-3 animate-spin text-accent" /> : <Sparkles className="h-3 w-3 text-accent" />}
      </div>
      <div className="min-w-0 flex-1 space-y-2.5">{children}</div>
    </div>
  );
}

function RunBlock({ runId, message, isLast }: { runId: string; message?: BuilderMessage; isLast: boolean }) {
  const ed = useEditor();
  const run: RunView | undefined = ed.runs[runId];
  const active = !!run && !isTerminal(run.status);
  const text = message?.content || run?.text || "";
  const chips = providerChips(run?.providers ?? []);
  const commitSha = message?.commitSha ?? run?.commits[run.commits.length - 1]?.sha;
  const suggestions = !run || active ? [] : run.suggestions.length ? run.suggestions : run.status === "CANCELED" ? [] : fallbackSuggestions({ hasBackend: !!ed.project.baseRef, published: !!ed.project.lastPublishedAt, failed: run.status === "FAILED" });
  return (
    <AssistantShell busy={active}>
      {run && run.steps.length > 0 && <PlanCard run={run} />}
      {run && active && <ToolTicker run={run} />}
      {text ? <Markdown text={text} className="text-[13.5px]" /> : active && !run?.steps.length ? <ThinkingDots /> : null}
      {run?.commits.map((c) => <CommitCard key={c.sha} sha={c.sha} message={c.message} files={c.files} />)}
      {run && run.pendingFiles.length > 0 && <CommitCard sha="" message={active ? "Changes in progress…" : "Uncommitted changes"} files={run.pendingFiles} />}
      {run && run.checks.length > 0 && <Checks checks={run.checks} />}
      {run && run.thoughts.length > 0 && <Thoughts items={run.thoughts} />}
      {run && run.notices.length > 0 && <Notices items={run.notices} hideErrors={run.status === "FAILED"} />}
      {run?.error && run.status === "FAILED" && (
        <div className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-[12.5px] text-danger" role="alert">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{run.error}</span>
        </div>
      )}
      {run?.status === "CANCELED" && !run.error && <p className="text-[12px] text-subtle">Stopped. The app stays at the last good version.</p>}
      {(chips.length > 0 || (!active && commitSha)) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((c) => (
            <span
              key={c.label + c.title}
              title={c.title}
              className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]", c.fallback ? "border-warning/30 bg-warning/10 text-warning" : "border-border text-subtle")}
            >
              <Zap className="h-2.5 w-2.5" />
              provider: {c.label}
            </span>
          ))}
          {!active && commitSha && <RestoreButton sha={commitSha} at={message?.createdAt} inline />}
        </div>
      )}
      {isLast && !active && run && suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1" aria-label="Suggestions">
          {suggestions.map((s) => (
            <button key={s} onClick={() => void ed.send(s)} disabled={!!ed.activeRunId} className="rounded-full border border-border bg-surface px-3 py-1 text-left text-[12px] text-muted transition-colors hover:border-border-strong hover:text-fg disabled:opacity-50">
              {s}
            </button>
          ))}
        </div>
      )}
    </AssistantShell>
  );
}

function Thoughts({ items }: { items: RunView["thoughts"] }) {
  const [open, setOpen] = useState(false);
  const last = items[items.length - 1]!;
  return (
    <div className="text-[12px] text-subtle">
      <button onClick={() => setOpen((o) => !o)} className="flex max-w-full items-center gap-1 hover:text-muted" aria-expanded={open}>
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="truncate">{open ? "Reasoning" : `${last.role ? `${ROLE_LABEL[last.role] ?? last.role}: ` : ""}${last.text}`}</span>
      </button>
      {open && (
        <ul className="mt-1 space-y-1 border-l border-border pl-3">
          {items.map((t, i) => (
            <li key={i} className="whitespace-pre-wrap break-words">
              {t.role && <span className="text-muted">{ROLE_LABEL[t.role] ?? t.role}: </span>}
              {t.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Notices({ items, hideErrors }: { items: RunView["notices"]; hideErrors?: boolean }) {
  const [all, setAll] = useState(false);
  const relevant = items.filter((n) => !(hideErrors && n.kind === "error"));
  if (!relevant.length) return null;
  const shown = all ? relevant : relevant.slice(-2);
  return (
    <ul className="space-y-1">
      {relevant.length > shown.length && (
        <li>
          <button onClick={() => setAll(true)} className="text-[11.5px] text-subtle hover:text-fg">
            Show {relevant.length - shown.length} earlier notice{relevant.length - shown.length === 1 ? "" : "s"}
          </button>
        </li>
      )}
      {shown.map((n, i) => (
        <li key={i} className={cn("flex items-start gap-1.5 text-[12px]", n.kind === "info" ? "text-muted" : n.kind === "warning" ? "text-warning" : "text-danger")}>
          {n.kind === "info" ? <Check className="mt-0.5 h-3 w-3 shrink-0" /> : <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />}
          <span className={cn("min-w-0 break-words", !all && "line-clamp-2")} title={n.text}>
            {n.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ThinkingDots() {
  return (
    <p className="flex items-center gap-1 text-[13px] text-muted">
      Thinking
      <span className="inline-flex gap-0.5">
        {[0, 1, 2].map((i) => (
          <span key={i} className="h-1 w-1 animate-pulse2 rounded-full bg-muted" style={{ animationDelay: `${i * 0.2}s` }} />
        ))}
      </span>
    </p>
  );
}

const ROLE_LABEL: Record<string, string> = { planner: "Planner", designer: "Designer", coder: "Coder", backend: "Backend", reviewer: "Reviewer", fixer: "Fixer", judge: "Judge" };

function StepIcon({ s }: { s: RunStep["status"] }) {
  if (s === "done") return <Check className="h-3 w-3 text-success" />;
  if (s === "running") return <Loader2 className="h-3 w-3 animate-spin text-accent" />;
  if (s === "failed") return <X className="h-3 w-3 text-danger" />;
  if (s === "skipped") return <CircleDashed className="h-3 w-3 text-subtle" />;
  return <Circle className="h-3 w-3 text-subtle" />;
}

function PlanCard({ run }: { run: RunView }) {
  const done = run.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  const [open, setOpen] = useState(true);
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface" data-testid="plan-card">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2 text-left" aria-expanded={open}>
        <span className="text-[12.5px] font-medium">Plan</span>
        {run.planSummary && <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{run.planSummary}</span>}
        <span className="ml-auto shrink-0 font-mono text-[11px] text-subtle">
          {done}/{run.steps.length}
        </span>
        <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-subtle transition-transform", !open && "-rotate-90")} />
      </button>
      <div className="h-0.5 bg-surface-2">
        <div className="h-full bg-accent transition-all duration-500" style={{ width: `${run.steps.length ? (done / run.steps.length) * 100 : 0}%` }} />
      </div>
      {open && (
        <ol className="space-y-1 px-3 py-2">
          {run.steps.map((s, i) => (
            <li key={s.id ?? i} className="flex items-start gap-2 text-[12.5px]">
              <span className="mt-[3px]">
                <StepIcon s={s.status} />
              </span>
              <span className={cn("min-w-0 flex-1", s.status === "done" ? "text-muted" : s.status === "running" ? "text-fg" : "text-subtle")}>{s.title}</span>
              {s.role && <span className="shrink-0 text-[11px] text-subtle">{ROLE_LABEL[s.role] ?? s.role}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function ToolTicker({ run }: { run: RunView }) {
  const current = [...run.tools].reverse().find((t) => !t.done);
  const recent = run.tools.slice(-4);
  if (!run.tools.length) return null;
  return (
    <div className="space-y-0.5 text-[12px]">
      {recent.map((t) => (
        <p key={t.id} className={cn("flex items-center gap-1.5 truncate", t === current ? "text-fg" : "text-subtle")}>
          {t.done ? t.ok === false ? <X className="h-3 w-3 shrink-0 text-danger" /> : <Check className="h-3 w-3 shrink-0 text-success" /> : <Wrench className="h-3 w-3 shrink-0 animate-pulse2 text-accent" />}
          <span className="truncate font-mono text-[11.5px]">{t.label}</span>
        </p>
      ))}
    </div>
  );
}

function fileIcon(status: FileChange["status"]) {
  if (status === "added") return <FilePlus2 className="h-3.5 w-3.5 shrink-0 text-success" />;
  if (status === "deleted") return <FileX2 className="h-3.5 w-3.5 shrink-0 text-danger" />;
  return <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted" />;
}

export function CommitCard({ sha, message, files }: { sha: string; message: string; files: FileChange[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface" data-testid="file-changes">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{message}</span>
        {sha ? <span className="shrink-0 font-mono text-[11px] text-subtle">{sha.slice(0, 7)}</span> : <Loader2 className="h-3 w-3 shrink-0 animate-spin text-subtle" />}
      </div>
      <ul className="divide-y divide-border">
        {files.slice(0, 12).map((f) => {
          const lines = open === f.path && f.patch ? parseUnifiedDiff(f.patch, f.path)[0]?.lines ?? [] : [];
          return (
            <li key={f.path}>
              <button
                onClick={() => setOpen((o) => (o === f.path ? null : f.path))}
                disabled={!f.patch}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors enabled:hover:bg-surface-2"
                aria-expanded={open === f.path}
              >
                {fileIcon(f.status)}
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{f.path}</span>
                {(f.additions != null || f.deletions != null) && <DiffStat additions={f.additions} deletions={f.deletions} />}
                {f.patch && <ChevronRight className={cn("h-3 w-3 shrink-0 text-subtle transition-transform", open === f.path && "rotate-90")} />}
              </button>
              {open === f.path && <DiffView lines={lines} compact maxLines={60} className="max-h-64 border-t border-border bg-bg-subtle" />}
            </li>
          );
        })}
        {files.length > 12 && <li className="px-3 py-1.5 text-[11.5px] text-subtle">+ {files.length - 12} more files</li>}
      </ul>
    </div>
  );
}

const CHECK_LABEL: Record<string, string> = { typecheck: "Type check", lint: "Lint", build: "Build" };
function Checks({ checks }: { checks: CheckResult[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const cur = checks.find((c) => c.kind === open);
  return (
    <div className="space-y-1.5" data-testid="checks">
      <div className="flex flex-wrap gap-1.5">
        {checks.map((c) => (
          <button
            key={c.kind}
            onClick={() => setOpen((o) => (o === c.kind ? null : c.kind))}
            title={c.summary}
            className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px]", c.ok ? "border-success/30 bg-success/10 text-success" : "border-danger/30 bg-danger/10 text-danger")}
          >
            {c.ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
            {CHECK_LABEL[c.kind] ?? c.kind}
            {c.durationMs != null && <span className="opacity-70">· {(c.durationMs / 1000).toFixed(1)}s</span>}
          </button>
        ))}
      </div>
      {cur && (cur.output || cur.summary) && <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-bg-subtle p-2 font-mono text-[11px] text-muted">{cur.output || cur.summary}</pre>}
    </div>
  );
}

function RestoreButton({ sha, at, inline }: { sha: string; at?: string; inline?: boolean }) {
  const ed = useEditor();
  const [busy, setBusy] = useState(false);
  const isHead = ed.project.lastCommit === sha;
  if (isHead && !inline) return null;
  return (
    <span className={cn("inline-flex items-center gap-2 text-[11.5px] text-subtle", !inline && "pt-0.5")}>
      {isHead ? (
        <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5">
          <Check className="h-3 w-3" /> Current version
        </span>
      ) : (
        <button
          onClick={async () => {
            setBusy(true);
            await ed.restore(sha, "Restored this version");
            setBusy(false);
          }}
          disabled={busy || !!ed.activeRunId}
          className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 transition-colors hover:border-border-strong hover:text-fg disabled:opacity-50"
          title={`Restore the app to ${sha.slice(0, 7)}`}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />} Restore to this version
        </button>
      )}
      {at && !inline && <TimeAgo date={at} />}
    </span>
  );
}

function Composer() {
  const ed = useEditor();
  const toast = useToast();
  const [text, setText] = useState("");
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!ed.draft.nonce) return;
    setText(ed.draft.text);
    if (ed.draft.attachments) setAtts(ed.draft.attachments);
    setTimeout(() => {
      ta.current?.focus();
      ta.current?.setSelectionRange(ed.draft.text.length, ed.draft.text.length);
    }, 0);
  }, [ed.draft]);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const addFiles = async (files: FileList | File[]) => {
    const imgs = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return;
    for (const f of imgs.slice(0, 4)) {
      if (f.size > 5 * 1024 * 1024) {
        toast.error("Image too large", `${f.name} is over 5 MB`);
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const url = await imageToDataUrl(f);
        setAtts((a) => [...a, { kind: "image", url, name: f.name, mime: url.slice(5, url.indexOf(";")) }]);
      } catch (e) {
        toast.error("Could not attach the image", errMessage(e));
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const submit = async () => {
    if (ed.activeRunId || uploading) return;
    const ok = await ed.send(text, atts, { context: atts.some((a) => a.kind === "element") ? { elements: atts.filter((a) => a.kind === "element") } : undefined });
    if (ok) {
      setText("");
      setAtts([]);
    }
  };

  const busy = !!ed.activeRunId;
  const outOfCredits = ed.credits?.remaining === 0;

  return (
    <div className="shrink-0 border-t border-border p-3">
      <div
        className={cn("rounded-xl border bg-surface transition-colors focus-within:border-border-strong", dragOver ? "border-accent" : "border-border")}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void addFiles(e.dataTransfer.files);
        }}
      >
        {(atts.length > 0 || uploading > 0) && (
          <div className="flex items-center gap-2 px-3 pt-3">
            <AttachmentChips items={atts} onRemove={(i) => setAtts((a) => a.filter((_, j) => j !== i))} />
            {uploading > 0 && <Loader2 className="h-4 w-4 animate-spin text-muted" />}
          </div>
        )}
        <textarea
          ref={ta}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            if (e.clipboardData.files.length) {
              e.preventDefault();
              void addFiles(e.clipboardData.files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={2}
          placeholder={busy ? "The agents are working…" : "Ask for a change…"}
          aria-label="Message"
          className="block max-h-[220px] w-full resize-none bg-transparent px-3 py-2.5 text-[13.5px] outline-none placeholder:text-subtle"
          data-testid="chat-input"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => e.target.files && void addFiles(e.target.files)} />
          <Button size="icon-sm" variant="ghost" onClick={() => fileRef.current?.click()} aria-label="Attach images" title="Attach images (or paste / drop)">
            <ImagePlus className="h-4 w-4" />
          </Button>
          <CreditCounter credits={ed.credits} className="ml-1" />
          <div className="ml-auto">
            {busy ? (
              <Button size="sm" variant="secondary" onClick={() => void ed.stop()} leftIcon={<Square className="h-3 w-3 fill-current" />} data-testid="chat-stop">
                Stop
              </Button>
            ) : (
              <Button
                size="icon-sm"
                variant="primary"
                onClick={() => void submit()}
                disabled={(!text.trim() && !atts.length) || ed.sending || uploading > 0 || outOfCredits}
                loading={ed.sending}
                aria-label="Send"
                className="rounded-full"
                data-testid="chat-send"
              >
                {!ed.sending && <ArrowUp className="h-4 w-4" />}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
