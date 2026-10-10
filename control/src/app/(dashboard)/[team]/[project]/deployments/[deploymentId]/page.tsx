import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CircleAlert, ExternalLink } from "lucide-react";
import { db } from "@/lib/db";
import { getProjectContext } from "@/lib/auth/context";
import { hasRole } from "@/lib/auth/roles";
import { branchHost, hostUrl, projectHost } from "@/lib/deployments";
import { createdBySelect, toDTO } from "@/lib/dashboard/deployments";
import { readProtection } from "@/lib/dashboard/protection";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import type { DeploymentStatusName } from "@/components/ui/status-dot";
import { PageBody } from "@/components/shell/page-header";
import { DeploymentPreview } from "@/components/dashboard/deployment-preview";
import { Field, SourceInfo, StatusLine } from "@/components/dashboard/deployment-fields";
import { StatusTimeline } from "@/components/dashboard/status-timeline";
import { DeploymentHeaderActions, DeploymentLogs } from "@/components/dashboard/deployment-detail";
import { TimeAgo } from "@/components/dashboard/time-ago";
import { frameworkLabel } from "@/components/dashboard/framework-icon";
import { AiDiagnosisBanner } from "@/components/ai/ask-ai";
import { readDiagnosis } from "@/lib/ai/auto-diagnose";

export async function generateMetadata({ params }: { params: Promise<{ deploymentId: string }> }) {
  const { deploymentId } = await params;
  return { title: `Deployment ${deploymentId.slice(0, 9)}` };
}

const TRIGGER: Record<string, string> = {
  GIT_PUSH: "Git push",
  PULL_REQUEST: "Pull request",
  MANUAL: "Manual (dashboard)",
  REDEPLOY: "Redeploy",
  CLI: "CLI (levant deploy)",
  API: "API",
  PROMOTE: "Promote",
  ROLLBACK: "Rollback",
};

export default async function DeploymentPage({ params }: { params: Promise<{ team: string; project: string; deploymentId: string }> }) {
  const { team, project: pslug, deploymentId } = await params;
  const { project, role, team: t } = await getProjectContext(team, pslug);
  const row = await db.deployment.findFirst({ where: { projectId: project.id, OR: [{ id: deploymentId }, { shortId: deploymentId }] }, include: { createdBy: createdBySelect } });
  if (!row) notFound();
  const d = toDTO(row);
  const base = `/${t.slug}/${project.slug}`;
  const [events, domains, newerBranch, source, runtimeArchive] = await Promise.all([
    db.deploymentEvent.findMany({ where: { deploymentId: d.id }, orderBy: { createdAt: "asc" } }),
    d.isCurrentProduction ? db.domain.findMany({ where: { projectId: project.id, gitBranch: null, redirectTo: null }, select: { hostname: true } }) : Promise.resolve([]),
    d.target === "PREVIEW" && d.branch && d.status === "READY"
      ? db.deployment.findFirst({ where: { projectId: project.id, branch: d.branch, target: "PREVIEW", status: "READY", createdAt: { gt: row.createdAt } }, select: { id: true } })
      : Promise.resolve(null),
    d.sourceDeploymentId ? db.deployment.findUnique({ where: { id: d.sourceDeploymentId }, select: { id: true, number: true, shortId: true } }) : Promise.resolve(null),
    db.logArchive.findUnique({ where: { deploymentId_stream: { deploymentId: d.id, stream: "RUNTIME" } }, select: { id: true } }),
  ]);
  const aliases = d.isCurrentProduction
    ? [projectHost(project.slug), ...domains.map((x) => x.hostname)]
    : d.target === "PREVIEW" && d.branch && d.status === "READY" && !newerBranch
      ? [branchHost(project.slug, d.branch)]
      : [];
  const protection = readProtection(project.protection);
  const isProtected = protection.mode !== "none" && (protection.scope === "all" || d.target === "PREVIEW");
  const active = ["QUEUED", "BUILDING", "DEPLOYING"].includes(d.status);
  const canWrite = hasRole(role, "MEMBER");
  const primary = aliases[aliases.length > 1 ? 1 : 0];

  return (
    <>
      <div className="border-b border-border">
        <div className="container-page py-8">
          <Link href={`${base}/deployments`} className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-fg">
            <ArrowLeft className="h-3.5 w-3.5" /> Deployments
          </Link>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <h1 className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[28px] font-semibold tracking-tight sm:text-[32px]">
                <span>Deployment</span>
                <span className="font-mono text-[22px] text-muted sm:text-[24px]">{d.shortId}</span>
              </h1>
              <p className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-muted">
                <span>#{d.number}</span>
                <span>·</span>
                <Badge tone={d.target === "PRODUCTION" ? "neutral" : "outline"}>{d.target === "PRODUCTION" ? "Production" : "Preview"}</Badge>
                {d.isCurrentProduction && <Badge tone="accent">Current</Badge>}
                {isProtected && <Badge tone="warning">Protected</Badge>}
                <span className="hidden sm:inline">·</span>
                <span>{frameworkLabel(d.framework ?? project.framework)}</span>
              </p>
            </div>
            <DeploymentHeaderActions d={d} teamSlug={t.slug} projectSlug={project.slug} canWrite={canWrite} />
          </div>
        </div>
      </div>
      <PageBody className="space-y-6">
        <Card className="overflow-hidden">
          <div className="grid gap-6 p-5 md:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
            <DeploymentPreview
              url={d.fullUrl}
              host={d.url}
              status={d.status as DeploymentStatusName}
              framework={d.framework ?? project.framework}
              screenshotUrl={typeof d.meta.screenshot === "string" ? d.meta.screenshot : null}
              protectedPreview={isProtected}
            />
            <div className="grid min-w-0 content-start gap-5 sm:grid-cols-2">
              <Field label="Created">
                <span className="text-muted">
                  <TimeAgo date={d.createdAt} />
                  {(d.createdBy?.name ?? d.commitAuthor) && <> by {d.createdBy?.name ?? d.commitAuthor}</>}
                </span>
              </Field>
              <Field label="Status">
                <StatusLine d={{ ...d, createdBy: null, commitAuthor: null }} />
              </Field>
              <Field label="Domains" className="sm:col-span-2">
                <div className="space-y-1">
                  <p className="flex min-w-0 items-center gap-1">
                    <a href={d.fullUrl} target="_blank" rel="noreferrer" className="truncate font-mono text-[13px] hover:underline">
                      {d.url}
                    </a>
                    <CopyButton value={d.fullUrl} className="h-6 w-6 shrink-0" label="Copy deployment URL" />
                  </p>
                  {aliases.map((h) => (
                    <a key={h} href={hostUrl(h)} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-1.5 text-[13px] hover:underline">
                      <span className="truncate">{h}</span>
                      <ExternalLink className="h-3 w-3 shrink-0 text-subtle" />
                    </a>
                  ))}
                </div>
              </Field>
              <Field label="Source" className="sm:col-span-2">
                <SourceInfo d={d} repo={project.githubRepoFullName} />
              </Field>
              <Field label="Trigger">
                <span className="text-muted">
                  {TRIGGER[d.trigger] ?? d.trigger}
                  {source && (
                    <>
                      {" "}
                      of{" "}
                      <Link href={`${base}/deployments/${source.id}`} className="font-mono text-fg hover:underline">
                        #{source.number}
                      </Link>
                    </>
                  )}
                  {d.meta.noCache === true && " · no cache"}
                </span>
              </Field>
              <Field label="Image">
                <span className="block truncate font-mono text-[12px] text-muted">{d.imageTag ?? "—"}</span>
              </Field>
            </div>
          </div>
          {d.status === "ERROR" && d.errorMessage && (
            <div className="flex gap-3 border-t border-danger/30 bg-danger/5 px-5 py-3">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-danger">{d.errorStep ? `${d.errorStep.charAt(0)}${d.errorStep.slice(1).toLowerCase()} failed` : "Deployment failed"}</p>
                <p className="mt-0.5 break-words font-mono text-[12px] text-fg">{d.errorMessage}</p>
              </div>
            </div>
          )}
        </Card>

        {d.status === "ERROR" && <AiDiagnosisBanner deploymentId={d.id} deployment={{ number: d.number, errorStep: d.errorStep, errorMessage: d.errorMessage }} initial={readDiagnosis(row.meta)} /> /* ai area */}

        <Card className="p-5">
          <StatusTimeline status={d.status} createdAt={d.createdAt} events={events.map((e) => ({ status: e.status, createdAt: e.createdAt.toISOString(), message: e.message }))} />
        </Card>

        <DeploymentLogs deploymentId={d.id} logsHref={`${base}/logs?deploymentId=${d.id}`} active={active} hasRuntime={!!runtimeArchive || d.status === "READY"} />
      </PageBody>
    </>
  );
}
