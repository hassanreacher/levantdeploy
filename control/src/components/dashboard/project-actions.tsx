"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { History, RefreshCw, Rocket, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { StatusDot, type DeploymentStatusName } from "@/components/ui/status-dot";
import { useToast } from "@/components/ui/toast";
import { api, ApiClientError } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import { useDeploymentActions, type ActionDeployment } from "./deployment-actions";
import { TimeAgo } from "./time-ago";

export type RollbackCandidate = ActionDeployment & { commitMessage: string | null; createdAt: string; commitSha: string | null };

/** Redeploy + Instant Rollback buttons for the production deployment card. */
export function ProductionActions({
  teamSlug,
  projectSlug,
  current,
  candidates,
  canWrite,
}: {
  teamSlug: string;
  projectSlug: string;
  current: ActionDeployment | null;
  candidates: RollbackCandidate[];
  canWrite: boolean;
}) {
  const { ask, dialogs } = useDeploymentActions({ teamSlug, projectSlug });
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<string | null>(candidates[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const router = useRouter();
  const rollback = async () => {
    if (!sel) return;
    setBusy(true);
    try {
      await api(`/api/v1/deployments/${sel}/rollback`, { method: "POST", body: {} });
      toast.success("Rolling back production…");
      setOpen(false);
      router.refresh();
    } catch (e) {
      const err = e as ApiClientError;
      if (err.status === 404) toast.error("Rollback not available yet", "The runtime service didn't answer this request.");
      else toast.error("Rollback failed", err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {canWrite && current && (
        <Button size="sm" variant="secondary" leftIcon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => ask("redeploy", current)}>
          Redeploy
        </Button>
      )}
      {canWrite && (
        <Button size="sm" variant="secondary" leftIcon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => setOpen(true)} disabled={!candidates.length} title={candidates.length ? undefined : "No previous production deployment"}>
          Instant Rollback
        </Button>
      )}
      {dialogs}
      <Dialog
        open={open}
        onClose={() => !busy && setOpen(false)}
        title="Instant Rollback"
        description="Point your production domains back to a previous production deployment. No rebuild — it is live in seconds."
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={rollback} loading={busy} disabled={!sel}>
              Roll back
            </Button>
          </>
        }
      >
        <div className="max-h-[320px] space-y-2 overflow-y-auto" role="radiogroup">
          {candidates.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={sel === c.id}
              onClick={() => setSel(c.id)}
              className={cn(
                "flex w-full items-start gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
                sel === c.id ? "border-fg/50 bg-surface-2" : "border-border hover:border-border-strong",
              )}
            >
              <span className={cn("mt-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border", sel === c.id ? "border-fg" : "border-border-strong")}>
                {sel === c.id && <span className="h-1.5 w-1.5 rounded-full bg-fg" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-[13px]">
                  <span className="font-mono text-fg">#{c.number}</span>
                  <span className="font-mono text-muted">{c.shortId}</span>
                  <StatusDot status={c.status as DeploymentStatusName} />
                  <TimeAgo date={c.createdAt} className="ml-auto text-[12px] text-subtle" />
                </span>
                <span className="mt-0.5 block truncate text-[12px] text-muted">
                  {c.commitSha ? `${c.commitSha.slice(0, 7)} · ` : ""}
                  {c.commitMessage?.split("\n")[0] ?? "—"}
                </span>
              </span>
            </button>
          ))}
          {!candidates.length && (
            <p className="flex items-center gap-2 text-[13px] text-muted">
              <History className="h-4 w-4" /> No previous production deployments to roll back to.
            </p>
          )}
        </div>
      </Dialog>
    </>
  );
}

/** "Deploy" button (new deployment from the production branch). */
export function DeployButton({ projectId, teamSlug, projectSlug, branch, variant = "primary" }: { projectId: string; teamSlug: string; projectSlug: string; branch: string; variant?: "primary" | "secondary" }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const router = useRouter();
  return (
    <Button
      size="sm"
      variant={variant}
      leftIcon={<Rocket className="h-3.5 w-3.5" />}
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await api<{ deployment: { id: string; number: number } }>(`/api/v1/projects/${projectId}/deployments`, { method: "POST", body: { target: "PRODUCTION", branch } });
          toast.success(`Deployment #${r.deployment.number} queued`);
          router.push(`/${teamSlug}/${projectSlug}/deployments/${r.deployment.id}`);
        } catch (e) {
          toast.error("Could not deploy", (e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      Deploy
    </Button>
  );
}
