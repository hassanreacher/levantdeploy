"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpCircle, Ban, Copy, ExternalLink, MoreHorizontal, RefreshCw, RotateCcw, Search, Power, PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Dropdown, DropdownItem, DropdownSeparator } from "@/components/ui/dropdown";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { api, ApiClientError } from "@/lib/client/api";

export type ActionDeployment = {
  id: string;
  number: number;
  shortId: string;
  status: string;
  target: "PRODUCTION" | "PREVIEW";
  url: string;
  fullUrl?: string;
  isCurrentProduction: boolean;
  branch?: string | null;
};

export type DeploymentActionKind = "promote" | "rollback" | "redeploy" | "cancel" | "restart" | "stop";

const ACTIVE = ["QUEUED", "BUILDING", "DEPLOYING"];

/** What can be done with a deployment (UI gating; the API re-checks everything). */
export function availableActions(d: ActionDeployment, canWrite: boolean) {
  const finished = !ACTIVE.includes(d.status);
  const ran = d.status === "READY" || d.status === "SUPERSEDED";
  return {
    visit: d.status === "READY" || d.isCurrentProduction,
    promote: canWrite && ran && d.target === "PREVIEW",
    rollback: canWrite && ran && d.target === "PRODUCTION" && !d.isCurrentProduction,
    redeploy: canWrite && finished,
    cancel: canWrite && !finished,
    restart: canWrite && d.status === "READY",
    stop: canWrite && d.status === "READY" && !d.isCurrentProduction,
  };
}

function scheme() {
  return typeof window !== "undefined" && window.location.protocol === "https:" ? "https" : "http";
}
export const hostToUrl = (host: string) => (/^https?:\/\//.test(host) ? host : `${scheme()}://${host}`);

const COPY: Record<Exclude<DeploymentActionKind, "redeploy">, { title: string; desc: (d: ActionDeployment) => ReactNode; cta: string; danger?: boolean; ok: string }> = {
  promote: {
    title: "Promote to Production",
    desc: (d) => (
      <>
        Deployment <span className="font-mono text-fg">{d.shortId}</span> will start serving all production domains. The current production deployment is kept stopped for instant rollback.
      </>
    ),
    cta: "Promote",
    ok: "Promoting to production…",
  },
  rollback: {
    title: "Instant Rollback",
    desc: (d) => (
      <>
        Production domains will point back to deployment <span className="font-mono text-fg">#{d.number}</span> immediately (no rebuild). Auto-assigning of production domains for new pushes continues.
      </>
    ),
    cta: "Roll back",
    ok: "Rolling back…",
  },
  cancel: { title: "Cancel deployment", desc: (d) => <>Stop building deployment #{d.number}? This can't be resumed.</>, cta: "Cancel deployment", danger: true, ok: "Deployment canceled" },
  restart: { title: "Restart deployment", desc: () => <>Restarts the running container(s) of this deployment. Requests may briefly fail.</>, cta: "Restart", ok: "Restarting…" },
  stop: { title: "Stop deployment", desc: (d) => <>Stops the container(s) of deployment #{d.number}. Its URL will stop responding until it is promoted or redeployed.</>, cta: "Stop", danger: true, ok: "Stopping…" },
};

/** Runs deployment actions with confirmation dialogs + toasts. Render `dialogs` once; call `ask(kind, deployment)`. */
export function useDeploymentActions(opts: { teamSlug: string; projectSlug: string; onDone?: (kind: DeploymentActionKind, result: unknown) => void }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState<{ kind: DeploymentActionKind; d: ActionDeployment } | null>(null);
  const [busy, setBusy] = useState(false);
  const [useCache, setUseCache] = useState(true);
  const [target, setTarget] = useState<"PRODUCTION" | "PREVIEW">("PREVIEW");

  const run = async () => {
    if (!pending) return;
    const { kind, d } = pending;
    setBusy(true);
    try {
      const path = `/api/v1/deployments/${d.id}/${kind}`;
      const res = await api<{ deployment?: { id: string; number: number } }>(path, { method: "POST", body: kind === "redeploy" ? { useCache, target } : {} });
      setPending(null);
      if (kind === "redeploy" && res.deployment) {
        toast.success(`Redeploying as #${res.deployment.number}`, useCache ? undefined : "Building without cache");
        router.push(`/${opts.teamSlug}/${opts.projectSlug}/deployments/${res.deployment.id}`);
      } else {
        toast.success(COPY[kind as Exclude<DeploymentActionKind, "redeploy">].ok);
        router.refresh();
      }
      opts.onDone?.(kind, res);
    } catch (e) {
      const err = e as ApiClientError;
      if (err.status === 404 && ["promote", "rollback", "restart", "stop"].includes(kind)) {
        toast.error("Action not available yet", "The runtime service didn't answer this request. Try again after the runtime update is installed.");
      } else toast.error("Action failed", err.message);
    } finally {
      setBusy(false);
    }
  };

  const ask = (kind: DeploymentActionKind, d: ActionDeployment) => {
    setUseCache(true);
    setTarget(d.target);
    setPending({ kind, d });
  };

  const dialogs = pending ? (
    pending.kind === "redeploy" ? (
      <Dialog
        open
        onClose={() => !busy && setPending(null)}
        title="Redeploy"
        description={
          <>
            Create a new deployment from the same source as <span className="font-mono text-fg">#{pending.d.number}</span>
            {pending.d.branch ? (
              <>
                {" "}
                (<span className="font-mono">{pending.d.branch}</span>)
              </>
            ) : null}
            . Current environment variables and settings are used.
          </>
        }
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setPending(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" loading={busy} onClick={run} data-autofocus>
              Redeploy
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4 rounded-md border border-border bg-bg-subtle px-3 py-2.5">
            <div>
              <p className="text-[13px] font-medium text-fg">Use existing build cache</p>
              <p className="text-[12px] text-muted">Turn off to rebuild every layer from scratch.</p>
            </div>
            <Switch checked={useCache} onCheckedChange={setUseCache} label="Use existing build cache" />
          </div>
          <div>
            <p className="mb-1.5 text-[13px] font-medium text-muted">Environment</p>
            <Select value={target} onChange={(e) => setTarget(e.target.value as "PRODUCTION" | "PREVIEW")} options={[{ value: "PRODUCTION", label: "Production" }, { value: "PREVIEW", label: "Preview" }]} />
          </div>
        </div>
      </Dialog>
    ) : (
      <Dialog
        open
        onClose={() => !busy && setPending(null)}
        title={COPY[pending.kind].title}
        description={COPY[pending.kind].desc(pending.d)}
        size="sm"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setPending(null)} disabled={busy}>
              Back
            </Button>
            <Button variant={COPY[pending.kind].danger ? "danger" : "primary"} size="sm" loading={busy} onClick={run} data-autofocus>
              {COPY[pending.kind].cta}
            </Button>
          </>
        }
      />
    )
  ) : null;

  return { ask, dialogs };
}

/** "…" menu for a deployment row / header. */
export function DeploymentActionsMenu({
  d,
  teamSlug,
  projectSlug,
  canWrite,
  ask,
  trigger,
  inspect = true,
}: {
  d: ActionDeployment;
  teamSlug: string;
  projectSlug: string;
  canWrite: boolean;
  ask: (kind: DeploymentActionKind, d: ActionDeployment) => void;
  trigger?: (open: boolean) => ReactNode;
  inspect?: boolean;
}) {
  const toast = useToast();
  const a = availableActions(d, canWrite);
  const url = d.fullUrl ?? hostToUrl(d.url);
  return (
    <Dropdown
      align="end"
      width={230}
      trigger={
        trigger ??
        (() => (
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for deployment ${d.shortId}`} data-testid="deployment-actions">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        ))
      }
    >
      {(close) => (
        <>
          {inspect && (
            <DropdownItem href={`/${teamSlug}/${projectSlug}/deployments/${d.id}`} icon={<Search className="h-3.5 w-3.5" />} onClick={close}>
              Inspect deployment
            </DropdownItem>
          )}
          {a.visit && (
            <DropdownItem
              icon={<ExternalLink className="h-3.5 w-3.5" />}
              onClick={() => {
                close();
                window.open(url, "_blank", "noopener");
              }}
            >
              Visit
            </DropdownItem>
          )}
          <DropdownItem
            icon={<Copy className="h-3.5 w-3.5" />}
            onClick={async () => {
              close();
              try {
                await navigator.clipboard.writeText(url);
                toast.success("URL copied", url);
              } catch {
                toast.info(url);
              }
            }}
          >
            Copy URL
          </DropdownItem>
          {(a.promote || a.rollback || a.redeploy || a.cancel || a.restart || a.stop) && <DropdownSeparator />}
          {a.promote && (
            <DropdownItem icon={<ArrowUpCircle className="h-3.5 w-3.5" />} onClick={() => (close(), ask("promote", d))}>
              Promote to Production
            </DropdownItem>
          )}
          {a.rollback && (
            <DropdownItem icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => (close(), ask("rollback", d))}>
              Instant Rollback
            </DropdownItem>
          )}
          {a.redeploy && (
            <DropdownItem icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => (close(), ask("redeploy", d))}>
              Redeploy
            </DropdownItem>
          )}
          {a.restart && (
            <DropdownItem icon={<PlayCircle className="h-3.5 w-3.5" />} onClick={() => (close(), ask("restart", d))}>
              Restart
            </DropdownItem>
          )}
          {a.stop && (
            <DropdownItem icon={<Power className="h-3.5 w-3.5" />} onClick={() => (close(), ask("stop", d))} danger>
              Stop
            </DropdownItem>
          )}
          {a.cancel && (
            <DropdownItem icon={<Ban className="h-3.5 w-3.5" />} onClick={() => (close(), ask("cancel", d))} danger>
              Cancel deployment
            </DropdownItem>
          )}
        </>
      )}
    </Dropdown>
  );
}
