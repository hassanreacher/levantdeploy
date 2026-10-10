import Link from "next/link";
import { ArrowRight, ExternalLink, FileText, Github, Globe, ScrollText, TriangleAlert } from "lucide-react";
import { db } from "@/lib/db";
import { getProjectContext } from "@/lib/auth/context";
import { hasRole } from "@/lib/auth/roles";
import { hostUrl, projectHost, branchHost } from "@/lib/deployments";
import { createdBySelect, toDTO } from "@/lib/dashboard/deployments";
import { envChangedSinceDeploy } from "@/lib/dashboard/env-api";
import { readProtection } from "@/lib/dashboard/protection";
import { Card } from "@/components/ui/card";
import { LinkButton } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusDot, type DeploymentStatusName } from "@/components/ui/status-dot";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { DeploymentPreview } from "@/components/dashboard/deployment-preview";
import { Field, SourceInfo, StatusLine } from "@/components/dashboard/deployment-fields";
import { DeployButton, ProductionActions } from "@/components/dashboard/project-actions";
import { LiveRefresh } from "@/components/dashboard/live";
import { TimeAgo } from "@/components/dashboard/time-ago";
import { frameworkLabel } from "@/components/dashboard/framework-icon";
import { BackendCard } from "@/components/base/backend-card";
import { baseInclude, toBaseDTO } from "@/lib/base-ui/dto";

export const metadata = { title: "Overview" };

export default async function ProjectOverview({ params }: { params: Promise<{ team: string; project: string }> }) {
  const { team, project: pslug } = await params;
  const { project, role, team: t } = await getProjectContext(team, pslug);
  const canWrite = hasRole(role, "MEMBER");
  const base = `/${t.slug}/${project.slug}`;

  const [current, latest, recent, domains, envPending, prevProd, previews, backend] = await Promise.all([
    db.deployment.findFirst({ where: { projectId: project.id, isCurrentProduction: true }, include: { createdBy: createdBySelect } }),
    db.deployment.findFirst({ where: { projectId: project.id, target: "PRODUCTION" }, orderBy: { createdAt: "desc" }, include: { createdBy: createdBySelect } }),
    db.deployment.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "desc" }, take: 5, include: { createdBy: createdBySelect } }),
    db.domain.findMany({ where: { projectId: project.id }, orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] }),
    envChangedSinceDeploy(project.id),
    db.deployment.findMany({
      where: { projectId: project.id, target: "PRODUCTION", status: { in: ["READY", "SUPERSEDED"] }, isCurrentProduction: false },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    db.deployment.findMany({
      where: { projectId: project.id, target: "PREVIEW", branch: { not: null } },
      orderBy: { createdAt: "desc" },
      distinct: ["branch"],
      take: 6,
      include: { createdBy: createdBySelect },
    }),
    db.baseProject.findUnique({ where: { projectId: project.id }, include: baseInclude }), // base-dashboard: Backend card
  ]);
  const shown = current ?? latest;
  const d = shown ? toDTO(shown) : null;
  const protection = readProtection(project.protection);
  const prodDomains = [...new Set([projectHost(project.slug), ...domains.filter((x) => !x.gitBranch && !x.redirectTo && !x.hostname.startsWith("*.")).map((x) => x.hostname)])];
  const primary = domains.find((x) => x.isPrimary && !x.gitBranch)?.hostname ?? prodDomains[0]!;
  const repo = project.githubRepoFullName;
  const running = latest && ["QUEUED", "BUILDING", "DEPLOYING"].includes(latest.status) && latest.id !== shown?.id ? toDTO(latest) : null;

  return (
    <>
      <LiveRefresh projectId={project.id} />
      <PageHeader
        title={project.name}
        description={project.description ?? `${frameworkLabel(project.framework)} · ${project.kind.toLowerCase()} project`}
        actions={
          <>
            {repo && (
              <LinkButton href={`https://github.com/${repo}`} target="_blank" rel="noreferrer" size="sm" variant="secondary" leftIcon={<Github className="h-3.5 w-3.5" />}>
                Repository
              </LinkButton>
            )}
            <LinkButton href={`${base}/domains`} size="sm" variant="secondary" leftIcon={<Globe className="h-3.5 w-3.5" />}>
              Domains
            </LinkButton>
            {current ? (
              <LinkButton href={hostUrl(primary)} target="_blank" rel="noreferrer" size="sm" variant="primary" rightIcon={<ExternalLink className="h-3.5 w-3.5" />}>
                Visit
              </LinkButton>
            ) : (
              canWrite && <DeployButton projectId={project.id} teamSlug={t.slug} projectSlug={project.slug} branch={project.productionBranch} />
            )}
          </>
        }
      />
      <PageBody className="space-y-8">
        {envPending.changed && (
          <div className="flex flex-col gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 sm:flex-row sm:items-center" role="status">
            <TriangleAlert className="h-4 w-4 shrink-0 text-warning" />
            <p className="flex-1 text-[13px] text-fg">
              Environment variables changed <TimeAgo date={envPending.changedAt} className="text-muted" />. Redeploy production to apply them.
            </p>
            <LinkButton href={`${base}/environment`} size="sm" variant="secondary">
              Review
            </LinkButton>
          </div>
        )}

        {running && (
          <Link href={`${base}/deployments/${running.id}`} className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 transition-colors hover:border-border-strong">
            <StatusDot status={running.status as DeploymentStatusName} withLabel />
            <span className="min-w-0 flex-1 truncate text-[13px] text-muted">
              Production deployment #{running.number} · {running.commitMessage?.split("\n")[0] ?? running.branch}
            </span>
            <span className="hidden items-center gap-1 text-[12px] text-muted sm:inline-flex">
              View build <ArrowRight className="h-3 w-3" />
            </span>
          </Link>
        )}

        <section>
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Production Deployment</h2>
              <p className="text-[13px] text-muted">The deployment that is available to your visitors.</p>
            </div>
            {d && (
              <div className="flex flex-wrap items-center gap-2">
                <LinkButton href={`${base}/deployments/${d.id}#logs`} size="sm" variant="secondary" leftIcon={<FileText className="h-3.5 w-3.5" />}>
                  Build Logs
                </LinkButton>
                <LinkButton href={`${base}/logs?deploymentId=${d.id}`} size="sm" variant="secondary" leftIcon={<ScrollText className="h-3.5 w-3.5" />}>
                  Runtime Logs
                </LinkButton>
                <ProductionActions teamSlug={t.slug} projectSlug={project.slug} canWrite={canWrite} current={d} candidates={prevProd.map(toDTO)} />
              </div>
            )}
          </div>
          {d ? (
            <Card className="overflow-hidden">
              <div className="grid gap-6 p-5 md:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
                <DeploymentPreview
                  url={hostUrl(current ? primary : d.url)}
                  host={current ? primary : d.url}
                  status={d.status as DeploymentStatusName}
                  framework={project.framework}
                  screenshotUrl={typeof d.meta.screenshot === "string" ? d.meta.screenshot : null}
                  protectedPreview={protection.mode !== "none" && protection.scope === "all"}
                />
                <div className="grid min-w-0 content-start gap-5 sm:grid-cols-2">
                  <Field label="Deployment" className="sm:col-span-2">
                    <Link href={`${base}/deployments/${d.id}`} className="block truncate font-mono text-[13px] hover:underline">
                      {d.url}
                    </Link>
                  </Field>
                  <Field label="Domains" className="sm:col-span-2">
                    <div className="flex min-w-0 flex-col gap-1">
                      {prodDomains.slice(0, 4).map((h) => (
                        <a key={h} href={hostUrl(h)} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1.5 hover:underline">
                          <span className="truncate">{h}</span>
                          <ExternalLink className="h-3 w-3 shrink-0 text-subtle" />
                        </a>
                      ))}
                      {prodDomains.length > 4 && (
                        <Link href={`${base}/domains`} className="text-[12px] text-muted hover:text-fg">
                          +{prodDomains.length - 4} more
                        </Link>
                      )}
                    </div>
                  </Field>
                  <Field label="Status">
                    <StatusLine d={d} />
                  </Field>
                  <Field label="Created">
                    <span className="text-muted">
                      <TimeAgo date={d.createdAt} /> · {d.trigger.replace("_", " ").toLowerCase()}
                    </span>
                  </Field>
                  <Field label="Source" className="sm:col-span-2">
                    <SourceInfo d={d} repo={repo} />
                  </Field>
                </div>
              </div>
              {!current && (
                <div className="border-t border-border bg-bg-subtle px-5 py-2.5 text-[13px] text-muted">No deployment is serving production yet — showing the latest production deployment.</div>
              )}
            </Card>
          ) : (
            <EmptyState
              icon={<Globe className="h-5 w-5" />}
              title="No production deployment yet"
              description={`Push to ${project.productionBranch} or deploy now. Every deployment gets its own URL; production also gets ${projectHost(project.slug)}.`}
              action={canWrite ? <DeployButton projectId={project.id} teamSlug={t.slug} projectSlug={project.slug} branch={project.productionBranch} /> : undefined}
            />
          )}
        </section>

        <BackendCard teamSlug={t.slug} projectSlug={project.slug} base={backend ? toBaseDTO(backend) : null} canAdd={canWrite} />

        <div className="grid gap-8 lg:grid-cols-2">
          <section className="min-w-0">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[15px] font-semibold">Active branches</h2>
              <Badge tone="outline">Preview</Badge>
            </div>
            <Card>
              {previews.length ? (
                <ul className="divide-y divide-border">
                  {previews.map((p) => (
                    <li key={p.id}>
                      <Link href={`${base}/deployments/${p.id}`} className="flex min-w-0 items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2/60">
                        <StatusDot status={p.status as DeploymentStatusName} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-mono text-[13px] text-fg">{p.branch}</p>
                          <p className="truncate text-[12px] text-muted">{p.status === "READY" ? branchHost(project.slug, p.branch!) : (p.commitMessage?.split("\n")[0] ?? p.url)}</p>
                        </div>
                        <TimeAgo date={p.createdAt} className="shrink-0 text-[12px] text-subtle" />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-4 py-8 text-center text-[13px] text-muted">
                  {project.previewDeployments ? "Push a branch or open a pull request to get a preview URL." : "Preview deployments are disabled for this project."}
                </p>
              )}
            </Card>
          </section>
          <section className="min-w-0">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[15px] font-semibold">Recent deployments</h2>
              <Link href={`${base}/deployments`} className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-fg">
                View all <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
            <Card>
              {recent.length ? (
                <ul className="divide-y divide-border">
                  {recent.map((r) => (
                    <li key={r.id}>
                      <Link href={`${base}/deployments/${r.id}`} className="flex min-w-0 items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2/60">
                        <StatusDot status={r.status as DeploymentStatusName} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] text-fg">{r.commitMessage?.split("\n")[0] ?? `Deployment #${r.number}`}</p>
                          <p className="truncate font-mono text-[12px] text-muted">
                            #{r.number} · {r.target === "PRODUCTION" ? "production" : (r.branch ?? "preview")}
                            {r.isCurrentProduction ? " · current" : ""}
                          </p>
                        </div>
                        <TimeAgo date={r.createdAt} className="shrink-0 text-[12px] text-subtle" />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-4 py-8 text-center text-[13px] text-muted">No deployments yet.</p>
              )}
            </Card>
          </section>
        </div>
      </PageBody>
    </>
  );
}
