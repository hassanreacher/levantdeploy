"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowUpCircle, Ban, ExternalLink, RefreshCw, RotateCcw, ScrollText } from "lucide-react";
import { Button, LinkButton } from "@/components/ui/button";
import { LogViewer } from "@/components/ui/log-viewer";
import { Tabs } from "@/components/ui/tabs";
import { availableActions, DeploymentActionsMenu, useDeploymentActions, type ActionDeployment } from "./deployment-actions";
import { LiveRefresh, LiveBadge } from "./live";

/** Header action buttons of the deployment detail page. */
export function DeploymentHeaderActions({ d, teamSlug, projectSlug, canWrite }: { d: ActionDeployment; teamSlug: string; projectSlug: string; canWrite: boolean }) {
  const { ask, dialogs } = useDeploymentActions({ teamSlug, projectSlug });
  const a = availableActions(d, canWrite);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {a.cancel && (
        <Button size="sm" variant="secondary" leftIcon={<Ban className="h-3.5 w-3.5" />} onClick={() => ask("cancel", d)}>
          Cancel
        </Button>
      )}
      {a.rollback && (
        <Button size="sm" variant="secondary" leftIcon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => ask("rollback", d)}>
          Instant Rollback
        </Button>
      )}
      {a.promote && (
        <Button size="sm" variant="secondary" leftIcon={<ArrowUpCircle className="h-3.5 w-3.5" />} onClick={() => ask("promote", d)}>
          Promote
        </Button>
      )}
      {a.redeploy && (
        <Button size="sm" variant="secondary" leftIcon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => ask("redeploy", d)}>
          Redeploy
        </Button>
      )}
      <DeploymentActionsMenu d={d} teamSlug={teamSlug} projectSlug={projectSlug} canWrite={canWrite} ask={ask} inspect={false} />
      {a.visit && (
        <LinkButton href={d.fullUrl ?? `http://${d.url}`} target="_blank" rel="noreferrer" size="sm" variant="primary" rightIcon={<ExternalLink className="h-3.5 w-3.5" />}>
          Visit
        </LinkButton>
      )}
      {dialogs}
    </div>
  );
}

/** Build / runtime log tabs with live streaming; refreshes the page when the build log ends. */
export function DeploymentLogs({ deploymentId, logsHref, active, hasRuntime }: { deploymentId: string; logsHref: string; active: boolean; hasRuntime: boolean }) {
  const [tab, setTab] = useState<"BUILD" | "RUNTIME">("BUILD");
  const router = useRouter();
  return (
    <div id="logs" className="scroll-mt-20">
      <LiveRefresh deploymentId={deploymentId} />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Tabs
            value={tab}
            onValueChange={setTab}
            tabs={[
              { value: "BUILD", label: "Build Logs" },
              { value: "RUNTIME", label: "Runtime Logs" },
            ]}
          />
          {active && <LiveBadge />}
        </div>
        <Link href={logsHref} className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-fg">
          <ScrollText className="h-3.5 w-3.5" /> Open in Logs
        </Link>
      </div>
      {tab === "BUILD" ? (
        <LogViewer key="build" deploymentId={deploymentId} stream="BUILD" height={460} onEnd={() => active && setTimeout(() => router.refresh(), 500)} emptyText={active ? "Waiting for the build to start…" : "No build logs were recorded."} />
      ) : (
        <LogViewer key="runtime" deploymentId={deploymentId} stream="RUNTIME" height={460} emptyText={hasRuntime ? "Waiting for runtime output…" : "This deployment has no runtime logs (yet)."} />
      )}
    </div>
  );
}
