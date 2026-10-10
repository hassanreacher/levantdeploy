"use client";

import { useEffect, useState } from "react";
import { Card, CardBody, CardHeader, Tabs } from "@/components/ui";
import { LineChart } from "@/components/runtime/line-chart";
import { api } from "@/lib/client/api";
import { formatBytes } from "@/lib/utils";
import type { MetricPoint } from "@/lib/runtime/metrics";

type Series = { from: number; to: number; step: number; points: MetricPoint[]; totals: { requests: number; errors: number; s4xx: number } };
type Range = "1h" | "6h" | "24h" | "7d";

const ACCENT = "rgb(var(--accent))";
const MUTED = "rgb(var(--muted))";
const DANGER = "rgb(var(--danger))";
const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);

export function Observability({ projectId, initial }: { projectId: string; initial: Series }) {
  const [range, setRange] = useState<Range>("1h");
  const [data, setData] = useState(initial);
  useEffect(() => {
    let stop = false;
    const load = () =>
      api<Series>(`/api/v1/projects/${projectId}/metrics?range=${range}`)
        .then((d) => !stop && setData(d))
        .catch(() => {});
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [projectId, range]);

  const pts = data.points as unknown as Array<{ t: number } & Record<string, number | null>>;
  const withLat = data.points.filter((p) => p.requests > 0);
  const p95 = withLat.length ? Math.max(...withLat.map((p) => p.p95 ?? 0)) : 0;
  const p50 = withLat.reduce((a, p) => a + (p.p50 ?? 0) * p.requests, 0) / Math.max(1, withLat.reduce((a, p) => a + p.requests, 0));
  const cpuPts = data.points.filter((p) => p.cpu !== null || p.mem !== null);
  const lastMem = cpuPts.at(-1)?.mem ?? 0;
  const errRate = data.totals.requests ? (data.totals.errors / data.totals.requests) * 100 : 0;
  const stepLabel = data.step >= 3600_000 ? "per hour" : data.step >= 60_000 * 15 ? "per 15 min" : data.step >= 300_000 ? "per 5 min" : "per minute";

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs<Range>
          tabs={[
            { value: "1h", label: "1 hour" },
            { value: "6h", label: "6 hours" },
            { value: "24h", label: "24 hours" },
            { value: "7d", label: "7 days" },
          ]}
          value={range}
          onValueChange={setRange}
        />
        <span className="text-[13px] text-muted">Refreshes every 30 s · {stepLabel}</span>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Requests" value={data.totals.requests.toLocaleString()} />
        <Stat label="5xx error rate" value={`${errRate.toFixed(errRate && errRate < 1 ? 2 : 1)}%`} hint={`${data.totals.errors.toLocaleString()} errors · ${data.totals.s4xx.toLocaleString()} 4xx`} />
        <Stat label="Latency p50" value={withLat.length ? ms(p50) : "—"} />
        <Stat label="Latency p95 (max)" value={withLat.length ? ms(p95) : "—"} />
        <Stat label="Memory (now)" value={lastMem ? formatBytes(lastMem) : "—"} hint={cpuPts.length ? `CPU ${(cpuPts.at(-1)!.cpu ?? 0).toFixed(1)}%` : undefined} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Requests" description={`Requests ${stepLabel}; 5xx responses in red`}>
          <LineChart
            points={pts}
            stepMs={data.step}
            series={[
              { key: "requests", label: "Requests", color: ACCENT, kind: "bar" },
              { key: "errors", label: "5xx errors", color: DANGER, kind: "bar" },
            ]}
          />
        </ChartCard>
        <ChartCard title="Latency" description="Median and 95th percentile response time at the edge">
          <LineChart
            points={pts}
            stepMs={data.step}
            format={ms}
            series={[
              { key: "p95", label: "p95", color: ACCENT },
              { key: "p50", label: "p50", color: MUTED },
            ]}
          />
        </ChartCard>
        <ChartCard title="CPU" description="Sum over all replicas (100% = one core)">
          <LineChart points={pts} stepMs={data.step} format={(v) => `${v.toFixed(v < 10 ? 1 : 0)}%`} series={[{ key: "cpu", label: "CPU", color: ACCENT }]} />
        </ChartCard>
        <ChartCard title="Memory" description="Peak resident memory over all replicas">
          <LineChart points={pts} stepMs={data.step} format={(v) => formatBytes(v)} series={[{ key: "mem", label: "Memory", color: ACCENT }]} />
        </ChartCard>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <div className="text-[13px] text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight">{value}</div>
      {hint && <div className="mt-0.5 text-[12px] text-subtle">{hint}</div>}
    </Card>
  );
}

function ChartCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <Card className="min-w-0">
      <CardHeader title={title} description={description} />
      <CardBody>{children}</CardBody>
    </Card>
  );
}
