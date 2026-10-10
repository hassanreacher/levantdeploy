import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

/** Hourly request counts for the last `hours` hours (zero-filled, oldest first) per project. */
export async function requestSeries(projectIds: string[], hours = 24): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (!projectIds.length) return out;
  const H = 3600_000;
  const end = Math.floor(Date.now() / H) * H; // start of the current hour
  const start = end - (hours - 1) * H;
  const rows = await db.$queryRaw<{ projectId: string; h: Date; req: bigint | number | null }[]>`
    SELECT "projectId", date_trunc('hour', "bucket") AS h, SUM(COALESCE("requests", 0)) AS req
    FROM "MetricSample"
    WHERE "projectId" IN (${Prisma.join(projectIds)}) AND "bucket" >= ${new Date(start)}
    GROUP BY 1, 2`;
  for (const r of rows) {
    const arr = out.get(r.projectId) ?? new Array<number>(hours).fill(0);
    const idx = Math.round((new Date(r.h).getTime() - start) / H);
    if (idx >= 0 && idx < hours) arr[idx] = Number(r.req ?? 0);
    out.set(r.projectId, arr);
  }
  return out;
}

export type UsageSummary = {
  from: Date;
  to: Date;
  deployments: number;
  buildMs: number;
  requests: number;
  bandwidthBytes: number;
  failed: number;
  hasMetrics: boolean;
  daily: { day: string; deployments: number; buildMs: number; requests: number; bandwidthBytes: number }[];
  perProject: { id: string; name: string; slug: string; framework: string | null; deployments: number; buildMs: number; requests: number; bandwidthBytes: number }[];
};

/** Team usage for the last `days` days: deployments, build minutes (buildStartedAt→buildFinishedAt), requests + egress (metrics). */
export async function teamUsage(teamId: string, days = 30): Promise<UsageSummary> {
  const D = 86400_000;
  const to = new Date();
  const from = new Date(Math.floor((to.getTime() - (days - 1) * D) / D) * D);
  const projects = await db.project.findMany({ where: { teamId }, select: { id: true, name: true, slug: true, framework: true } });
  const ids = projects.map((p) => p.id);
  const empty: UsageSummary = { from, to, deployments: 0, buildMs: 0, requests: 0, bandwidthBytes: 0, failed: 0, hasMetrics: false, daily: [], perProject: [] };
  const dayKeys = Array.from({ length: days }, (_, i) => new Date(from.getTime() + i * D).toISOString().slice(0, 10));
  if (!ids.length) return { ...empty, daily: dayKeys.map((day) => ({ day, deployments: 0, buildMs: 0, requests: 0, bandwidthBytes: 0 })) };

  const [deps, metrics] = await Promise.all([
    db.$queryRaw<{ projectId: string; d: Date; n: bigint; failed: bigint; ms: number | null }[]>`
      SELECT "projectId", date_trunc('day', "createdAt") AS d, COUNT(*) AS n,
             COUNT(*) FILTER (WHERE "status" = 'ERROR') AS failed,
             SUM(EXTRACT(EPOCH FROM (COALESCE("buildFinishedAt", "finishedAt") - "buildStartedAt")) * 1000) AS ms
      FROM "Deployment"
      WHERE "projectId" IN (${Prisma.join(ids)}) AND "createdAt" >= ${from}
      GROUP BY 1, 2`,
    db.$queryRaw<{ projectId: string; d: Date; req: bigint | number | null; tx: number | null }[]>`
      SELECT "projectId", date_trunc('day', "bucket") AS d, SUM(COALESCE("requests", 0)) AS req, SUM("netTxBytes") AS tx
      FROM "MetricSample"
      WHERE "projectId" IN (${Prisma.join(ids)}) AND "bucket" >= ${from}
      GROUP BY 1, 2`,
  ]);
  const daily = new Map(dayKeys.map((day) => [day, { day, deployments: 0, buildMs: 0, requests: 0, bandwidthBytes: 0 }]));
  const per = new Map(projects.map((p) => [p.id, { ...p, deployments: 0, buildMs: 0, requests: 0, bandwidthBytes: 0 }]));
  let failed = 0;
  for (const r of deps) {
    const k = new Date(r.d).toISOString().slice(0, 10);
    const ms = Math.max(0, Number(r.ms ?? 0));
    const n = Number(r.n);
    failed += Number(r.failed);
    const dd = daily.get(k);
    if (dd) {
      dd.deployments += n;
      dd.buildMs += ms;
    }
    const pp = per.get(r.projectId)!;
    pp.deployments += n;
    pp.buildMs += ms;
  }
  for (const r of metrics) {
    const k = new Date(r.d).toISOString().slice(0, 10);
    const req = Number(r.req ?? 0);
    const tx = Number(r.tx ?? 0);
    const dd = daily.get(k);
    if (dd) {
      dd.requests += req;
      dd.bandwidthBytes += tx;
    }
    const pp = per.get(r.projectId)!;
    pp.requests += req;
    pp.bandwidthBytes += tx;
  }
  const perProject = [...per.values()].sort((a, b) => b.bandwidthBytes - a.bandwidthBytes || b.deployments - a.deployments);
  const sum = (k: "deployments" | "buildMs" | "requests" | "bandwidthBytes") => perProject.reduce((a, p) => a + p[k], 0);
  return { from, to, deployments: sum("deployments"), buildMs: sum("buildMs"), requests: sum("requests"), bandwidthBytes: sum("bandwidthBytes"), failed, hasMetrics: metrics.length > 0, daily: [...daily.values()], perProject };
}

export function compactNumber(n: number) {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}
