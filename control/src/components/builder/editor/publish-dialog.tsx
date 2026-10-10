"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ExternalLink, Globe, Loader2, Rocket, X } from "lucide-react";
import { Button, LinkButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { LogViewer } from "@/components/ui/log-viewer";
import { StatusDot, type DeploymentStatusName } from "@/components/ui/status-dot";
import { CopyButton } from "@/components/ui/copy-button";
import { TimeAgo } from "@/components/dashboard/time-ago";
import { useDeploymentEvents } from "@/components/dashboard/live";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/client/api";
import { builderApi, isMock } from "@/lib/builder-ui/api";
import type { PublishState } from "@/lib/builder-ui/types";
import { cn } from "@/lib/utils";
import { errMessage, useEditor } from "./context";

const STEPS = ["QUEUED", "BUILDING", "DEPLOYING", "READY"] as const;
const ACTIVE = ["QUEUED", "BUILDING", "DEPLOYING"];

type DeploymentInfo = { id: string; status: string; url?: string | null; createdAt?: string; errorMessage?: string | null };

export function PublishDialog() {
  const ed = useEditor();
  const toast = useToast();
  const open = ed.panel === "publish";
  const B = useMemo(() => builderApi(), []);
  const [state, setState] = useState<PublishState | null>(null);
  const [dep, setDep] = useState<DeploymentInfo | null>(null);
  const [aliases, setAliases] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [showLogs, setShowLogs] = useState(false);

  const loadDeployment = useCallback(async (id: string) => {
    if (isMock()) return;
    try {
      const r = await api<{ deployment: DeploymentInfo & { url?: string }; aliases: string[] }>(`/api/v1/deployments/${id}`);
      setDep(r.deployment);
      setAliases(r.aliases);
    } catch {}
  }, []);

  const load = useCallback(async () => {
    try {
      const s = await B.publishState(ed.project.id);
      setState(s);
      if (s.deployment) {
        setDep(s.deployment);
        void loadDeployment(s.deployment.id);
      }
    } catch (e) {
      toast.error("Could not load publish status", errMessage(e));
    }
  }, [B, ed.project.id, loadDeployment, toast]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // live status (team SSE) + polling fallback while active
  useDeploymentEvents((ev) => {
    if (dep && (ev.deploymentId === dep.id || ev.deploymentId === "*")) void loadDeployment(dep.id);
  });
  useEffect(() => {
    if (!open || !dep || !ACTIVE.includes(dep.status)) return;
    const t = setInterval(() => void loadDeployment(dep.id), 3000);
    return () => clearInterval(t);
  }, [open, dep, loadDeployment]);
  useEffect(() => {
    if (dep?.status === "READY") void ed.refreshProject();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep?.status]);

  const publish = async () => {
    setBusy(true);
    try {
      const s = await B.publish(ed.project.id);
      setState((cur) => ({ ...cur, ...s }));
      if (s.deployment) {
        setDep(s.deployment);
        setShowLogs(true);
        void loadDeployment(s.deployment.id);
      }
    } catch (e) {
      toast.error("Could not publish", errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const status = dep?.status;
  const active = !!status && ACTIVE.includes(status);
  const url = state?.url ?? (aliases[0] ? `https://${aliases[0]}` : null) ?? dep?.url ?? null;
  const unpublishedChanges = !!state?.lastPublishedCommit && !!ed.project.lastCommit && state.lastPublishedCommit !== ed.project.lastCommit;
  const projectSlug = state?.project?.slug ?? ed.project.project?.slug;

  return (
    <Dialog open={open} onClose={() => ed.setPanel(null)} title={ed.project.lastPublishedAt ? "Publish changes" : "Publish your app"} description="Build the current version and deploy it to production with HTTPS." size="lg">
      <div className="space-y-5" data-testid="publish-dialog">
        {url && (
          <div className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3">
            <Globe className="h-4 w-4 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <a href={url} target="_blank" rel="noreferrer" className="block truncate font-mono text-[13px] text-fg hover:underline">
                {url.replace(/^https?:\/\//, "")}
              </a>
              <p className="text-[12px] text-muted">
                {state?.lastPublishedAt || ed.project.lastPublishedAt ? (
                  <>
                    Last published <TimeAgo date={state?.lastPublishedAt ?? ed.project.lastPublishedAt} />
                    {state?.lastPublishedCommit && <span className="font-mono"> · {state.lastPublishedCommit.slice(0, 7)}</span>}
                  </>
                ) : (
                  "Not published yet"
                )}
              </p>
            </div>
            <CopyButton value={url} />
            <a href={url} target="_blank" rel="noreferrer" className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-fg" aria-label="Open the app">
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        )}
        {unpublishedChanges && !active && <p className="text-[13px] text-warning">You have changes that are not published yet.</p>}

        {dep && (
          <div className="space-y-3">
            <ol className="flex items-center gap-1" aria-label="Deployment progress">
              {STEPS.map((s, i) => {
                const idx = status === "ERROR" || status === "CANCELED" ? -1 : STEPS.indexOf((status as (typeof STEPS)[number]) ?? "QUEUED");
                const done = idx > i || status === "READY";
                const cur = idx === i && status !== "READY";
                return (
                  <li key={s} className="flex flex-1 items-center gap-1.5">
                    <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px]", done ? "border-success bg-success/15 text-success" : cur ? "border-accent text-accent" : "border-border text-subtle")}>
                      {done ? <Check className="h-3 w-3" /> : cur ? <Loader2 className="h-3 w-3 animate-spin" /> : i + 1}
                    </span>
                    <span className={cn("text-[12px]", done || cur ? "text-fg" : "text-subtle")}>{s === "QUEUED" ? "Queued" : s === "BUILDING" ? "Building" : s === "DEPLOYING" ? "Deploying" : "Live"}</span>
                    {i < STEPS.length - 1 && <span className={cn("h-px flex-1", done ? "bg-success/50" : "bg-border")} />}
                  </li>
                );
              })}
            </ol>
            {(status === "ERROR" || status === "CANCELED") && (
              <div className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/10 p-3 text-[13px] text-danger" role="alert">
                <X className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{status === "ERROR" ? "The deployment failed" : "The deployment was canceled"}</p>
                  {dep.errorMessage && <p className="mt-0.5 break-words text-[12.5px]">{dep.errorMessage}</p>}
                </div>
                {status === "ERROR" && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!!ed.activeRunId}
                    onClick={() => {
                      ed.setPanel(null);
                      void ed.send(`Publishing failed${dep.errorMessage ? `: ${dep.errorMessage}` : ""}. Read the build log and fix the app so that \`next build\` succeeds.`, [], { kind: "fix", context: { deploymentId: dep.id } });
                    }}
                  >
                    Ask AI to fix
                  </Button>
                )}
              </div>
            )}
            <div className="flex items-center gap-2 text-[12.5px] text-muted">
              <StatusDot status={(status ?? "QUEUED") as DeploymentStatusName} withLabel />
              {dep.createdAt && (
                <span>
                  · started <TimeAgo date={dep.createdAt} />
                </span>
              )}
              <button className="ml-auto text-[12px] text-muted underline-offset-4 hover:text-fg hover:underline" onClick={() => setShowLogs((v) => !v)}>
                {showLogs ? "Hide build logs" : "Show build logs"}
              </button>
            </div>
            {showLogs && !isMock() && <LogViewer deploymentId={dep.id} stream="BUILD" height={240} />}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
          {projectSlug && (
            <>
              <LinkButton href={`/${ed.team}/${projectSlug}/domains`} variant="ghost" size="sm" leftIcon={<Globe className="h-3.5 w-3.5" />}>
                Custom domain
              </LinkButton>
              <LinkButton href={`/${ed.team}/${projectSlug}`} variant="ghost" size="sm">
                Project dashboard
              </LinkButton>
            </>
          )}
          <Button className="ml-auto" variant="primary" loading={busy} disabled={active} onClick={() => void publish()} leftIcon={<Rocket className="h-4 w-4" />} data-testid="publish-submit">
            {active ? "Publishing…" : ed.project.lastPublishedAt || state?.deployment ? "Publish update" : "Publish"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
