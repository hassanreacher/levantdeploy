import Link from "next/link";
import { Card } from "@/components/ui/card";
import { BarChart } from "@/components/dashboard/sparkline";
import { formatBytes, cn } from "@/lib/utils";
import { usagePct, type UsageDTO, type UsageMetric } from "@/lib/base-ui/shared";

const fmt = (m: Pick<UsageMetric, "unit">, n: number) => (m.unit === "bytes" ? formatBytes(n) : n.toLocaleString());

/** Plan usage bar (used vs limit) — server-safe. */
export function UsageBar({ m, compact }: { m: UsageMetric; compact?: boolean }) {
  const pct = usagePct(m.used, m.limit);
  const tone = pct === null ? "bg-accent" : pct >= 100 ? "bg-danger" : pct >= 80 ? "bg-warning" : "bg-accent";
  return (
    <div className={cn(!compact && "py-3")}>
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className={cn(compact ? "text-muted" : "font-medium")}>{m.label}</span>
        <span className="shrink-0 font-mono text-[12px] text-muted">
          {fmt(m, m.used)} <span className="text-subtle">/ {m.limit === null ? "unlimited" : fmt(m, m.limit)}</span>
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={pct ?? 0} aria-valuemin={0} aria-valuemax={100} aria-label={m.label}>
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${pct === null ? Math.min(100, m.used ? 4 : 0) : Math.max(m.used ? 2 : 0, pct)}%` }} />
      </div>
    </div>
  );
}

export function UsageView({ usage, teamSlug }: { usage: UsageDTO & { planName: string }; teamSlug: string }) {
  const series = usage.series ?? [];
  const charts = [
    { label: "Database size", data: series.map((d) => ({ label: d.ts, value: d.dbBytes })), f: formatBytes },
    { label: "File storage", data: series.map((d) => ({ label: d.ts, value: d.storageBytes })), f: formatBytes },
    { label: "Egress", data: series.map((d) => ({ label: d.ts, value: d.egressBytes })), f: formatBytes },
    { label: "Function invocations", data: series.map((d) => ({ label: d.ts, value: d.invocations })), f: (n: number) => n.toLocaleString() },
  ];
  const over = usage.metrics.filter((m) => (usagePct(m.used, m.limit) ?? 0) >= 80);
  return (
    <div className="space-y-6">
      {over.length > 0 && (
        <div className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-[13px]" role="status">
          {over.map((m) => m.label).join(", ")} {over.length === 1 ? "is" : "are"} above 80 % of the {usage.planName} plan.{" "}
          <Link href={`/${teamSlug}/settings/plan`} className="font-medium underline underline-offset-2">
            Review the plan
          </Link>
        </div>
      )}
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-3 p-5 pb-2">
          <div>
            <h3 className="text-base font-semibold tracking-tight">Plan usage</h3>
            <p className="mt-1 text-[13px] text-muted">
              {usage.planName} plan · billing period since {new Date(usage.periodStart).toLocaleDateString(undefined, { month: "short", day: "numeric" })}. Egress and invocations are monthly totals for the team.
            </p>
          </div>
          <Link href={`/${teamSlug}/settings/plan`} className="text-[13px] text-muted hover:text-fg">
            Plan & limits →
          </Link>
        </div>
        <div className="divide-y divide-border px-5 pb-2">
          {usage.metrics.map((m) => (
            <UsageBar key={m.key} m={m} />
          ))}
        </div>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        {charts.map((c) => (
          <Card key={c.label} className="p-5">
            <div className="mb-3 flex items-baseline justify-between">
              <h4 className="text-[13px] font-medium">{c.label}</h4>
              <span className="text-[12px] text-muted">last 30 days</span>
            </div>
            {c.data.length ? <BarChart data={c.data} height={96} format={c.f} /> : <div className="flex h-24 items-center justify-center text-[12px] text-subtle">No samples yet</div>}
          </Card>
        ))}
      </div>
    </div>
  );
}
