import { getTeamContext } from "@/lib/auth/context";
import { compactNumber, teamUsage } from "@/lib/dashboard/metrics";
import { formatBytes } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { BarChart } from "@/components/dashboard/sparkline";
import { FrameworkIcon } from "@/components/dashboard/framework-icon";

export const metadata = { title: "Usage" };

const minutes = (ms: number) => `${(ms / 60000).toFixed(ms < 600000 ? 1 : 0)} min`;

export default async function UsagePage({ params, searchParams }: { params: Promise<{ team: string }>; searchParams: Promise<{ days?: string }> }) {
  const { team } = await params;
  const sp = await searchParams;
  const days = [7, 30, 90].includes(Number(sp.days)) ? Number(sp.days) : 30;
  const ctx = await getTeamContext(team);
  const u = await teamUsage(ctx.team.id, days);
  const stats = [
    { label: "Deployments", value: compactNumber(u.deployments), sub: u.failed ? `${u.failed} failed` : "no failures", series: u.daily.map((d) => ({ label: d.day, value: d.deployments })), fmt: (n: number) => String(n) },
    { label: "Build minutes", value: minutes(u.buildMs), sub: u.deployments ? `${minutes(u.buildMs / u.deployments)} avg` : "—", series: u.daily.map((d) => ({ label: d.day, value: d.buildMs })), fmt: minutes },
    { label: "Requests", value: u.hasMetrics ? compactNumber(u.requests) : "—", sub: u.hasMetrics ? "edge proxy" : "metrics not collected yet", series: u.daily.map((d) => ({ label: d.day, value: d.requests })), fmt: compactNumber },
    { label: "Bandwidth (egress)", value: u.hasMetrics ? formatBytes(u.bandwidthBytes) : "—", sub: u.hasMetrics ? "container network tx" : "metrics not collected yet", series: u.daily.map((d) => ({ label: d.day, value: d.bandwidthBytes })), fmt: (n: number) => formatBytes(n) },
  ];
  return (
    <>
      <PageHeader
        title="Usage"
        description={`Resources used by ${ctx.team.name} on this server — last ${days} days. Plan limits and quotas are in Team Settings → Plan & Usage.`}
        actions={
          <div className="inline-flex rounded-md border border-border bg-bg-subtle p-0.5">
            {[7, 30, 90].map((d) => (
              <a key={d} href={`?days=${d}`} className={`h-7 rounded px-3 text-[13px] font-medium leading-7 ${d === days ? "bg-surface-2 text-fg" : "text-muted hover:text-fg"}`}>
                {d}d
              </a>
            ))}
          </div>
        }
      />
      <PageBody className="space-y-8">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {stats.map((s) => (
            <Card key={s.label} className="p-5">
              <p className="text-[13px] text-muted">{s.label}</p>
              <p className="mt-1 text-2xl font-semibold tracking-tight">{s.value}</p>
              <p className="text-[12px] text-subtle">{s.sub}</p>
              <BarChart data={s.series} height={56} className="mt-4" format={s.fmt} />
            </Card>
          ))}
        </div>
        <section>
          <h2 className="mb-3 text-[15px] font-semibold">By project</h2>
          <Table>
            <THead>
              <tr>
                <TH>Project</TH>
                <TH className="text-right">Deployments</TH>
                <TH className="text-right">Build time</TH>
                <TH className="text-right">Requests</TH>
                <TH className="text-right">Bandwidth</TH>
              </tr>
            </THead>
            <TBody>
              {u.perProject.map((p) => (
                <TR key={p.id}>
                  <TD>
                    <a href={`/${ctx.team.slug}/${p.slug}`} className="inline-flex items-center gap-2 whitespace-nowrap hover:underline">
                      <FrameworkIcon framework={p.framework} size={22} />
                      {p.name}
                    </a>
                  </TD>
                  <TD className="text-right font-mono text-[13px]">{p.deployments}</TD>
                  <TD className="whitespace-nowrap text-right font-mono text-[13px]">{minutes(p.buildMs)}</TD>
                  <TD className="text-right font-mono text-[13px]">{u.hasMetrics ? compactNumber(p.requests) : "—"}</TD>
                  <TD className="whitespace-nowrap text-right font-mono text-[13px]">{u.hasMetrics ? formatBytes(p.bandwidthBytes) : "—"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </section>
      </PageBody>
    </>
  );
}
