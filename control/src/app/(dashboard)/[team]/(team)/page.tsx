import Link from "next/link";
import { ArrowRight, GitBranch, Github, Plus, Rocket, UploadCloud } from "lucide-react";
import { db } from "@/lib/db";
import { getTeamContext } from "@/lib/auth/context";
import { hasRole } from "@/lib/auth/roles";
import { projectHost } from "@/lib/deployments";
import { teamActivity } from "@/lib/dashboard/activity";
import { compactNumber, requestSeries } from "@/lib/dashboard/metrics";
import { LinkButton } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusDot, STATUS_STYLE, type DeploymentStatusName } from "@/components/ui/status-dot";
import { PageBody } from "@/components/shell/page-header";
import { SearchField } from "@/components/shell/command-palette";
import { FrameworkIcon } from "@/components/dashboard/framework-icon";
import { Sparkline } from "@/components/dashboard/sparkline";
import { TimeAgo } from "@/components/dashboard/time-ago";
import { ActivityFeed } from "@/components/dashboard/activity-feed";
import { LiveRefresh } from "@/components/dashboard/live";
import { BuilderOverviewPrompt } from "@/components/builder/overview-prompt";

export const metadata = { title: "Overview" };

/** Team overview — projects grid (latest deployment, framework, domain, last commit, 24h request sparkline) + recent activity. */
export default async function TeamOverview({ params }: { params: Promise<{ team: string }> }) {
  const { team: slug } = await params;
  const ctx = await getTeamContext(slug);
  const projects = await db.project.findMany({
    where: { teamId: ctx.team.id },
    orderBy: [{ lastDeployedAt: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }],
    include: {
      deployments: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true, status: true, createdAt: true, branch: true, commitMessage: true, commitSha: true, target: true },
      },
      domains: { where: { isPrimary: true }, take: 1, select: { hostname: true } },
    },
  });
  const prod = await db.deployment.findMany({
    where: { projectId: { in: projects.map((p) => p.id) }, isCurrentProduction: true },
    select: { projectId: true, status: true },
  });
  const prodByProject = new Map(prod.map((p) => [p.projectId, p.status]));
  const [series, activity] = await Promise.all([requestSeries(projects.map((p) => p.id), 24), teamActivity(ctx.team.id, { limit: 8 })]);
  const canCreate = hasRole(ctx.role, "MEMBER");
  const t = ctx.team.slug;

  return (
    <PageBody>
      <LiveRefresh />
      {canCreate && <BuilderOverviewPrompt team={t} />} {/* builder-ui: "What do you want to build?" entry point */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchField placeholder="Search projects and deployments…" className="flex-1" />
        {canCreate && (
          <LinkButton href={`/${t}/new`} variant="primary" leftIcon={<Plus className="h-4 w-4" />}>
            Add New…
          </LinkButton>
        )}
      </div>
      {projects.length === 0 ? (
        <EmptyState
          icon={<Rocket className="h-5 w-5" />}
          title="Deploy your first project"
          description="Import a Git repository or upload a folder from your machine. Any framework, any language — it runs as a container on your server."
          action={
            canCreate ? (
              <LinkButton href={`/${t}/new`} variant="primary">
                New project
              </LinkButton>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
          <section aria-label="Projects" className="min-w-0">
            <div className="grid gap-4 md:grid-cols-2" data-testid="projects-grid">
              {projects.map((p) => {
                const last = p.deployments[0];
                const host = p.domains[0]?.hostname ?? projectHost(p.slug);
                const s = series.get(p.id);
                const total = s?.reduce((a, b) => a + b, 0) ?? 0;
                const prodStatus = prodByProject.get(p.id);
                return (
                  <Link
                    key={p.id}
                    href={`/${t}/${p.slug}`}
                    className="group flex min-w-0 flex-col gap-4 rounded-lg border border-border bg-surface p-5 transition-colors hover:border-border-strong"
                    data-testid="project-card"
                  >
                    <div className="flex items-start gap-3">
                      <FrameworkIcon framework={p.framework} size={34} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-fg">{p.name}</p>
                        <p className="truncate text-[13px] text-muted">{host}</p>
                      </div>
                      {s && total > 0 ? (
                        <div className="flex shrink-0 flex-col items-end text-success" title="Requests, last 24 hours">
                          <Sparkline data={s} width={72} height={24} label="Requests in the last 24 hours" />
                          <span className="mt-0.5 font-mono text-[11px] text-subtle">{compactNumber(total)} req</span>
                        </div>
                      ) : prodStatus ? (
                        <StatusDot status={prodStatus as DeploymentStatusName} />
                      ) : null}
                    </div>
                    {p.githubRepoFullName || p.gitUrl ? (
                      <span className="inline-flex w-fit max-w-full items-center gap-1.5 truncate rounded-full border border-border bg-bg-subtle px-2.5 py-1 font-mono text-[12px] text-muted">
                        <Github className="h-3 w-3 shrink-0" />
                        <span className="truncate">{p.githubRepoFullName ?? p.gitUrl?.replace(/^https?:\/\//, "").replace(/\.git$/, "")}</span>
                      </span>
                    ) : (
                      <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border bg-bg-subtle px-2.5 py-1 text-[12px] text-muted">
                        <UploadCloud className="h-3 w-3" />
                        {p.sourceType === "UPLOAD" ? "Uploaded with the CLI" : p.sourceType.toLowerCase()}
                      </span>
                    )}
                    <div className="mt-auto min-w-0 space-y-1 text-[13px]">
                      {last ? (
                        <>
                          <p className="flex min-w-0 items-center gap-2 text-fg">
                            <StatusDot status={last.status as DeploymentStatusName} />
                            <span className="truncate">{last.commitMessage?.split("\n")[0] ?? `${STATUS_STYLE[last.status as DeploymentStatusName].label} ${last.target.toLowerCase()} deployment`}</span>
                          </p>
                          <p className="flex min-w-0 items-center gap-1.5 text-muted">
                            <TimeAgo date={last.createdAt} />
                            {last.branch && (
                              <>
                                <span>on</span>
                                <GitBranch className="h-3 w-3 shrink-0" />
                                <span className="truncate font-mono text-[12px]">{last.branch}</span>
                              </>
                            )}
                          </p>
                        </>
                      ) : (
                        <p className="text-muted">
                          No deployments yet · created <TimeAgo date={p.createdAt} />
                        </p>
                      )}
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>
          <aside className="min-w-0 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-[13px] font-semibold text-fg">Recent activity</h2>
              <Link href={`/${t}/activity`} className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-fg">
                View all <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
            {activity.length ? <ActivityFeed items={activity} team={t} compact /> : <p className="text-[13px] text-subtle">Nothing yet.</p>}
          </aside>
        </div>
      )}
    </PageBody>
  );
}
