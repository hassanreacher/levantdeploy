import Link from "next/link";
import { db } from "@/lib/db";
import { getTeamContext } from "@/lib/auth/context";
import { teamActivity } from "@/lib/dashboard/activity";
import { EmptyState } from "@/components/ui/empty-state";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { ActivityFeed } from "@/components/dashboard/activity-feed";
import { LiveRefresh } from "@/components/dashboard/live";
import { cn } from "@/lib/utils";

export const metadata = { title: "Activity" };

export default async function ActivityPage({ params, searchParams }: { params: Promise<{ team: string }>; searchParams: Promise<{ project?: string; before?: string }> }) {
  const { team } = await params;
  const sp = await searchParams;
  const ctx = await getTeamContext(team);
  const projects = await db.project.findMany({ where: { teamId: ctx.team.id }, select: { id: true, name: true, slug: true }, orderBy: { name: "asc" } });
  const filterProject = projects.find((p) => p.slug === sp.project);
  const before = sp.before && !Number.isNaN(Date.parse(sp.before)) ? new Date(sp.before) : undefined;
  const items = await teamActivity(ctx.team.id, { limit: 50, before, projectId: filterProject?.id });
  const t = ctx.team.slug;
  const q = (o: Record<string, string | undefined>) => {
    const p = new URLSearchParams(Object.entries(o).filter(([, v]) => v) as [string, string][]);
    return p.toString() ? `?${p}` : "";
  };
  return (
    <>
      <LiveRefresh />
      <PageHeader title="Activity" description="Deployments and changes across every project in this team." />
      <PageBody>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-8 md:grid-cols-[200px_minmax(0,1fr)]">
          <nav aria-label="Filter by project" className="-mx-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:flex-col md:px-0">
            {[{ slug: undefined, name: "All projects" }, ...projects].map((p) => (
              <Link
                key={p.slug ?? "all"}
                href={`/${t}/activity${q({ project: p.slug })}`}
                className={cn("whitespace-nowrap rounded-md px-3 py-2 text-[13px]", filterProject?.slug === p.slug ? "bg-surface-2 font-medium text-fg" : "text-muted hover:bg-surface-2/60 hover:text-fg")}
              >
                {p.name}
              </Link>
            ))}
          </nav>
          <div className="min-w-0 max-w-3xl">
            {items.length === 0 ? (
              <EmptyState title="No activity yet" description="Deployments, environment changes and team updates will show up here." />
            ) : (
              <>
                <ActivityFeed items={items} team={t} />
                {items.length >= 50 && (
                  <Link href={`/${t}/activity${q({ project: filterProject?.slug, before: items[items.length - 1]!.at })}`} className="text-[13px] text-muted hover:text-fg">
                    Older activity →
                  </Link>
                )}
              </>
            )}
          </div>
        </div>
      </PageBody>
    </>
  );
}
