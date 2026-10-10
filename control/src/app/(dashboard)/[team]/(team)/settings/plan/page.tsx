import Link from "next/link";
import { Database, Box } from "lucide-react";
import { db } from "@/lib/db";
import { getTeamContext } from "@/lib/auth/context";
import { hasRole } from "@/lib/auth/roles";
import { usageReport, listPlans, parseLimits, type UsageItem } from "@/lib/plans";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { UsageBar } from "@/components/plans/usage-bar";
import { fmtLimit } from "@/components/plans/format";
import { UpgradeRequest } from "@/components/plans/upgrade-request";

export const metadata = { title: "Plan & Usage" };
export const dynamic = "force-dynamic";

const HINTS: Record<string, string> = {
  "deploy.deploymentsPerDay": "Rolling 24 hours",
  "deploy.concurrentBuilds": "Running now — extra builds wait in the queue",
  "deploy.buildMinutesMonth": "This month",
  "deploy.bandwidthGbMonth": "This month · container egress",
  "deploy.members": "Members + pending invites",
  "base.projects": "Paused backends don't count",
  "base.egressGbMonth": "This month · all backends",
  "base.functionInvocationsMonth": "This month · all backends",
};

function Grid({ items }: { items: UsageItem[] }) {
  return (
    <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
      {items.map((i) => (
        <UsageBar key={`${i.resource}:${i.scope?.id ?? ""}`} item={i} hint={HINTS[i.resource]} />
      ))}
    </div>
  );
}

export default async function PlanUsagePage({ params }: { params: Promise<{ team: string }> }) {
  const { team } = await params;
  const ctx = await getTeamContext(team);
  const [u, plans, openRequest] = await Promise.all([
    usageReport(ctx.team.id),
    listPlans({ includeInternal: false }),
    db.planUpgradeRequest.findFirst({ where: { teamId: ctx.team.id, status: "OPEN" }, orderBy: { createdAt: "desc" }, include: { plan: { select: { name: true } } } }),
  ]);
  const canRequest = hasRole(ctx.role, "ADMIN");
  const withBackend = u.projects.filter((p) => p.backend);
  const withDomains = u.projects.filter((p) => !p.backend && p.domains.used > 0);
  const others = u.projects.length - withBackend.length - withDomains.length;
  const sourceLabel = u.source === "assigned" ? "Assigned by the platform owner" : u.source === "owner" ? "Platform owner's team" : "Default plan";
  const options = plans.filter((p) => p.slug !== u.plan.slug).map((p) => ({ slug: p.slug, name: p.name, priceMonthly: p.priceMonthly }));
  const compare = plans.map((p) => ({ ...p, l: parseLimits(p.limits) }));

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Plan"
          description="Limits for Deploy projects and Backends in this team. There is no billing yet — upgrades are granted by the platform owner."
        />
        <CardBody className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-2xl font-semibold tracking-tight" data-testid="plan-name">
                {u.plan.name}
              </span>
              {u.plan.isInternal ? <Badge tone="accent">Internal</Badge> : <Badge tone="outline">{u.plan.priceMonthly ? `$${u.plan.priceMonthly}/mo` : "Free"}</Badge>}
            </div>
            <p className="mt-0.5 text-[13px] text-muted">{sourceLabel}</p>
          </div>
          {u.overQuota.length > 0 && (
            <Badge tone="danger">
              {u.overQuota.length} limit{u.overQuota.length === 1 ? "" : "s"} reached
            </Badge>
          )}
        </CardBody>
        <CardFooter
          hint={
            openRequest
              ? `Upgrade requested${openRequest.plan ? ` (${openRequest.plan.name})` : ""} — waiting for the platform owner.`
              : canRequest
                ? "Need more? Ask the platform owner for a bigger plan."
                : "Only team admins can request an upgrade."
          }
        >
          {canRequest && !u.plan.isInternal && <UpgradeRequest team={ctx.team.slug} options={options} pending={!!openRequest} />}
        </CardFooter>
      </Card>

      <Card>
        <CardHeader title="Deploy" description={`Usage for ${u.period.month}. Day and concurrency limits reset continuously.`} />
        <CardBody>
          <Grid items={u.deploy} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Backends" description="Database, auth, storage and functions for your projects. Counted separately from Deploy projects." />
        <CardBody>
          <Grid items={u.base} />
        </CardBody>
      </Card>

      <section className="space-y-3">
        <h2 className="text-[15px] font-semibold">By project</h2>
        {withBackend.length === 0 && withDomains.length === 0 && (
          <p className="rounded-xl border border-dashed border-border p-6 text-center text-[13px] text-muted">
            No backends or custom domains yet. Per-project limits show up here once a project has a backend attached or a custom domain.
          </p>
        )}
        {withBackend.map((p) => (
          <Card key={p.id}>
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
              <Box className="h-4 w-4 text-muted" />
              <Link href={`/${ctx.team.slug}/${p.slug}`} className="font-medium hover:underline">
                {p.name}
              </Link>
              <span className="text-subtle">·</span>
              <Database className="h-3.5 w-3.5 text-muted" />
              <span className="text-[13px] text-muted">Backend {p.backend!.name}</span>
              <Badge tone={p.backend!.active ? "success" : "neutral"} className="ml-auto">
                {p.backend!.status.toLowerCase()}
              </Badge>
            </div>
            <CardBody>
              <Grid items={[p.domains, ...p.backend!.items]} />
            </CardBody>
          </Card>
        ))}
        {withDomains.length > 0 && (
          <Card>
            <CardBody className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
              {withDomains.map((p) => (
                <UsageBar key={p.id} item={{ ...p.domains, label: `${p.name} · custom domains` }} />
              ))}
            </CardBody>
          </Card>
        )}
        {u.standaloneBackends.map((b) => (
          <Card key={b.id}>
            <div className="flex items-center gap-2 border-b border-border px-5 py-3">
              <Database className="h-4 w-4 text-muted" />
              <span className="font-medium">{b.name}</span>
              <span className="text-[13px] text-muted">Backend (not attached to a project)</span>
              <Badge tone={b.active ? "success" : "neutral"} className="ml-auto">
                {b.status.toLowerCase()}
              </Badge>
            </div>
            <CardBody>
              <Grid items={b.items} />
            </CardBody>
          </Card>
        ))}
        {others > 0 && (withBackend.length > 0 || withDomains.length > 0) && (
          <p className="text-[13px] text-muted">
            {others} other project{others === 1 ? "" : "s"} without a backend or custom domains.
          </p>
        )}
      </section>

      <Card>
        <CardHeader title="Compare plans" />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-[13px]">
            <thead>
              <tr className="border-b border-border text-left text-muted">
                <th className="px-5 py-2 font-medium" />
                {compare.map((p) => (
                  <th key={p.slug} className={`px-3 py-2 font-medium ${p.slug === u.plan.slug ? "text-fg" : ""}`}>
                    {p.name}
                    {p.slug === u.plan.slug && <span className="ml-1 text-accent">•</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ["Projects", (l) => fmtLimit(l.deploy.projects, "count")],
                  ["Deployments / day", (l) => fmtLimit(l.deploy.deploymentsPerDay, "count")],
                  ["Concurrent builds", (l) => fmtLimit(l.deploy.concurrentBuilds, "count")],
                  ["Bandwidth / month", (l) => fmtLimit(l.deploy.bandwidthGbMonth, "GB")],
                  ["Team members", (l) => fmtLimit(l.deploy.members, "count")],
                  ["Active backends", (l) => fmtLimit(l.base.projects, "count")],
                  ["Database / backend", (l) => fmtLimit(l.base.dbSizeMb, "MB")],
                  ["File storage / backend", (l) => fmtLimit(l.base.storageMb, "MB")],
                  ["Monthly active users", (l) => fmtLimit(l.base.mau, "count")],
                  ["Paused when inactive", (l) => (l.base.pauseAfterDays === null ? "Never" : `After ${l.base.pauseAfterDays} days`)],
                  ["Daily backups kept", (l) => (l.base.backupsKept ? String(l.base.backupsKept) : "Manual only")],
                ] as [string, (l: (typeof compare)[number]["l"]) => string][]
              ).map(([label, f]) => (
                <tr key={label} className="border-b border-border last:border-0">
                  <td className="px-5 py-2 text-muted">{label}</td>
                  {compare.map((p) => (
                    <td key={p.slug} className="px-3 py-2 tabular-nums">
                      {f(p.l)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
