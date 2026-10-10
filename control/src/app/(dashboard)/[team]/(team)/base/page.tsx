import Link from "next/link";
import { ArrowUpRight, Database, Plus, Server } from "lucide-react";
import { getTeamContext } from "@/lib/auth/context";
import { hasRole } from "@/lib/auth/roles";
import { backendsUsage } from "@/lib/plans";
import { basePathFor } from "@/lib/base-ui/access";
import { baseLimits } from "@/lib/base-ui/adapters";
import { listTeamBases } from "@/lib/base-ui/dto";
import { Card } from "@/components/ui/card";
import { LinkButton } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { BaseStatusBadge } from "@/components/base/common";
import { UsageBar } from "@/components/base/usage-view";
import { formatBytes, timeAgo } from "@/lib/utils";

export const metadata = { title: "Base" };
export const dynamic = "force-dynamic";

/** Team overview of every backend (LevantBase). Attached backends link to their project's Backend tab. */
export default async function BasePage({ params }: { params: Promise<{ team: string }> }) {
  const { team } = await params;
  const ctx = await getTeamContext(team);
  const [items, limits, usage] = await Promise.all([listTeamBases(ctx.team.id), baseLimits(ctx.team.id), backendsUsage(ctx.team.id).catch(() => [])]);
  const u = new Map(usage.map((x) => [x.id, x]));
  const active = items.filter((b) => !["PAUSED", "PAUSING", "DELETING"].includes(b.status)).length;
  const canCreate = hasRole(ctx.role, "MEMBER");
  const t = ctx.team.slug;
  return (
    <>
      <PageHeader
        title="Base"
        description="Backend projects: Postgres, Auth, REST, Realtime, Storage and Edge Functions — on this server."
        actions={
          canCreate ? (
            <LinkButton href={`/${t}/base/new`} variant="primary" leftIcon={<Plus className="h-4 w-4" />}>
              New project
            </LinkButton>
          ) : undefined
        }
      />
      <PageBody className="space-y-6">
        <Card className="grid gap-5 p-5 md:grid-cols-[220px_minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            <div className="text-[12px] text-muted">Plan</div>
            <div className="mt-0.5 text-[15px] font-semibold tracking-tight">{limits.planName}</div>
            <Link href={`/${t}/settings/plan`} className="mt-1 inline-block text-[12px] text-muted hover:text-fg">
              Plan & usage →
            </Link>
          </div>
          <UsageBar compact m={{ key: "functions", label: "Active projects", used: active, limit: limits.projects, unit: "count" }} />
          <UsageBar compact m={{ key: "db", label: "Largest database", used: Math.max(0, ...usage.map((x) => x.dbSizeBytes)), limit: limits.dbBytes, unit: "bytes" }} />
        </Card>

        {items.length ? (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-[13px]">
                <thead className="bg-bg-subtle text-left text-[12px] text-muted">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Project</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 font-medium">Used by</th>
                    <th className="px-4 py-2.5 font-medium">Region</th>
                    <th className="px-4 py-2.5 text-right font-medium">Database</th>
                    <th className="px-4 py-2.5 text-right font-medium">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((b) => {
                    const href = basePathFor(t, b);
                    const x = u.get(b.id);
                    return (
                      <tr key={b.id} className="border-t border-border transition-colors hover:bg-surface-2/40">
                        <td className="px-4 py-3">
                          <Link href={href} className="group flex min-w-0 items-center gap-3">
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-bg-subtle text-muted">
                              <Database className="h-4 w-4" />
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate font-medium group-hover:underline">{b.name}</span>
                              <span className="block truncate font-mono text-[12px] text-muted">{new URL(b.apiUrl).host}</span>
                            </span>
                          </Link>
                        </td>
                        <td className="px-4 py-3">
                          <BaseStatusBadge status={b.status} />
                        </td>
                        <td className="px-4 py-3">
                          {b.project ? (
                            <Link href={`/${t}/${b.project.slug}`} className="inline-flex items-center gap-1 hover:underline">
                              {b.project.name} <ArrowUpRight className="h-3 w-3 text-subtle" />
                            </Link>
                          ) : (
                            <span className="text-muted">Standalone</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-muted">
                          <span className="inline-flex items-center gap-1.5">
                            <Server className="h-3.5 w-3.5" /> {b.region}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-[12px]">{x?.sampledAt ? formatBytes(x.dbSizeBytes) : "—"}</td>
                        <td className="px-4 py-3 text-right text-muted">{timeAgo(b.createdAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        ) : (
          <EmptyState
            icon={<Database className="h-5 w-5" />}
            title="No backend projects yet"
            description="Create a Postgres database with Auth, an instant REST API, Realtime, Storage and Edge Functions. Attach it to a Deploy project from its Backend tab, or use it standalone (e.g. for a mobile app)."
            action={
              canCreate ? (
                <LinkButton href={`/${t}/base/new`} variant="primary" size="sm" leftIcon={<Plus className="h-3.5 w-3.5" />}>
                  New project
                </LinkButton>
              ) : undefined
            }
          />
        )}
      </PageBody>
    </>
  );
}
