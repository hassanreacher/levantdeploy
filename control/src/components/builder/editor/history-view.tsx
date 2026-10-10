"use client";

import { useEffect, useMemo, useState } from "react";
import { Bot, ChevronRight, Code2, GitCommitHorizontal, Loader2, MousePointerClick, RotateCcw, Rocket, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { TimeAgo } from "@/components/dashboard/time-ago";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { builderApi } from "@/lib/builder-ui/api";
import { parseUnifiedDiff } from "@/lib/builder-ui/diff";
import type { Commit, FileChange } from "@/lib/builder-ui/types";
import { DiffStat, DiffView } from "../diff-view";
import { errMessage, useEditor } from "./context";

const ROLE: Record<string, string> = { planner: "Planner", designer: "Designer", coder: "Coder", backend: "Backend agent", reviewer: "Reviewer", fixer: "Fixer", judge: "Judge" };

export function authorLabel(c: Commit): string {
  if (c.author.kind === "agent") return c.author.role ? (ROLE[c.author.role] ?? c.author.role) : "AI agent";
  if (c.author.kind === "visual") return c.author.name ? `${c.author.name} · visual edit` : "Visual edit";
  if (c.author.kind === "system") return "LevantDeploy";
  return c.author.name ?? "You";
}

function AuthorIcon({ c }: { c: Commit }) {
  const cls = "h-3.5 w-3.5";
  if (c.author.kind === "agent") return <Bot className={cn(cls, "text-accent")} />;
  if (c.author.kind === "visual") return <MousePointerClick className={cls} />;
  if (c.author.kind === "system") return <GitCommitHorizontal className={cls} />;
  if (/^Edit /.test(c.message)) return <Code2 className={cls} />;
  return <User className={cls} />;
}

export function HistoryView() {
  const ed = useEditor();
  const toast = useToast();
  const B = useMemo(() => builderApi(), []);
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [files, setFiles] = useState<FileChange[] | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Commit | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [mobileDetail, setMobileDetail] = useState(false);

  useEffect(() => {
    B.commits(ed.project.id).then(
      (c) => {
        setCommits(c);
        setSel((s) => s ?? c[0]?.sha ?? null);
      },
      (e) => {
        toast.error("Could not load history", errMessage(e));
        setCommits([]);
      },
    );
  }, [B, ed.project.id, ed.headVersion, toast]);

  useEffect(() => {
    if (!sel) return;
    setFiles(null);
    setOpenFile(null);
    B.commit(ed.project.id, sel).then(
      (r) => {
        setFiles(r.files);
        if (r.files.length === 1) setOpenFile(r.files[0]!.path);
      },
      () => setFiles([]),
    );
  }, [B, ed.project.id, sel]);

  const current = commits?.find((c) => c.sha === sel);
  const head = ed.project.lastCommit ?? commits?.[0]?.sha;

  const doRestore = async () => {
    if (!confirm) return;
    setRestoring(true);
    const ok = await ed.restore(confirm.sha, `Restored “${confirm.message.split("\n")[0]}”`);
    setRestoring(false);
    if (ok) setConfirm(null);
  };

  if (commits === null)
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-12" />
        ))}
      </div>
    );
  if (!commits.length) return <EmptyState className="m-6" icon={<GitCommitHorizontal className="h-5 w-5" />} title="No versions yet" description="Every agent turn and every visual edit creates a version you can restore." />;

  return (
    <div className="flex min-h-0 flex-1" data-testid="history-view">
      <ol className={cn("w-full shrink-0 overflow-y-auto border-r border-border bg-bg py-2 sm:block sm:w-80", mobileDetail ? "hidden" : "block")} aria-label="Versions">
        {commits.map((c, i) => (
          <li key={c.sha} className="relative">
            {i < commits.length - 1 && <span className="absolute bottom-0 left-[23px] top-8 w-px bg-border" aria-hidden />}
            <button
              onClick={() => {
                setSel(c.sha);
                setMobileDetail(true);
              }}
              className={cn("relative flex w-full items-start gap-3 px-3 py-2 text-left transition-colors hover:bg-surface-2", sel === c.sha && "bg-surface-2")}
              aria-current={sel === c.sha}
            >
              <span className="z-[1] mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-muted">
                <AuthorIcon c={c} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{c.title ?? c.message.split("\n")[0]}</span>
                <span className="flex items-center gap-1.5 text-[11.5px] text-subtle">
                  {authorLabel(c)} · <TimeAgo date={c.date} />
                </span>
                <span className="mt-1 flex flex-wrap gap-1">
                  {c.sha === head && <span className="rounded-full border border-border px-1.5 text-[10.5px] text-muted">current</span>}
                  {c.published && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-1.5 text-[10.5px] text-success">
                      <Rocket className="h-2.5 w-2.5" /> published
                    </span>
                  )}
                </span>
              </span>
              <span className="shrink-0 font-mono text-[10.5px] text-subtle">{c.sha.slice(0, 7)}</span>
            </button>
          </li>
        ))}
      </ol>
      <div className={cn("min-w-0 flex-1 flex-col overflow-hidden sm:flex", mobileDetail ? "flex" : "hidden")}>
        {current && (
          <>
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-3">
              <button className="text-[12px] text-muted hover:text-fg sm:hidden" onClick={() => setMobileDetail(false)}>
                ← Versions
              </button>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{current.title ?? current.message.split("\n")[0]}</p>
                <p className="text-[12px] text-muted">
                  {authorLabel(current)} · <TimeAgo date={current.date} /> · <span className="font-mono">{current.sha.slice(0, 7)}</span>
                </p>
              </div>
              <Button size="sm" variant={current.sha === head ? "secondary" : "primary"} leftIcon={<RotateCcw className="h-3.5 w-3.5" />} disabled={current.sha === head || !!ed.activeRunId} onClick={() => setConfirm(current)} data-testid="history-restore">
                {current.sha === head ? "Current version" : "Restore"}
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {files === null ? (
                <Loader2 className="mx-auto mt-8 h-5 w-5 animate-spin text-muted" />
              ) : !files.length ? (
                <p className="text-[13px] text-muted">No file changes in this version.</p>
              ) : (
                <ul className="space-y-2">
                  {files.map((f) => {
                    const parsed = f.patch ? parseUnifiedDiff(f.patch, f.path)[0] : null;
                    const add = f.additions ?? parsed?.additions;
                    const del = f.deletions ?? parsed?.deletions;
                    return (
                      <li key={f.path} className="overflow-hidden rounded-lg border border-border bg-surface">
                        <button onClick={() => setOpenFile((o) => (o === f.path ? null : f.path))} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-2" aria-expanded={openFile === f.path}>
                          <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-subtle transition-transform", openFile === f.path && "rotate-90")} />
                          <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{f.path}</span>
                          <span className={cn("shrink-0 text-[11px]", f.status === "added" ? "text-success" : f.status === "deleted" ? "text-danger" : "text-subtle")}>{f.status}</span>
                          <DiffStat additions={add} deletions={del} />
                        </button>
                        {openFile === f.path && <div className="border-t border-border bg-bg-subtle">{parsed ? <DiffView lines={parsed.lines} /> : <p className="px-3 py-2 text-[12px] text-subtle">No diff available.</p>}</div>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title="Restore this version?"
        description="A new version is created with the files exactly as they were. Nothing is lost — you can restore the current version again from History."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button variant="primary" loading={restoring} onClick={() => void doRestore()} data-autofocus>
              Restore
            </Button>
          </>
        }
      >
        {confirm && (
          <p className="text-[13px]">
            <span className="font-mono text-muted">{confirm.sha.slice(0, 7)}</span> · {confirm.message.split("\n")[0]}
          </p>
        )}
      </Dialog>
    </div>
  );
}
