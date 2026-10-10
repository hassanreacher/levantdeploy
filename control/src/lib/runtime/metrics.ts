import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { docker, LABELS } from "@/lib/docker";
import { env } from "@/lib/env";
import { redis } from "@/lib/redis";
import { hostMap } from "@/lib/proxy/sync";
import type { HostInfo } from "@/lib/proxy/config";

/**
 * Metrics (worker):
 *  - sampleContainers(): `docker stats` (one-shot) of every running LevantDeploy app container every 30 s,
 *    accumulated per container per minute → MetricSample(kind "container"): avg cpu %, max memory, net rx/tx bytes in
 *    that minute, restart count.
 *  - access log tailer: Caddy JSON access log → per deployment per minute → MetricSample(kind "http"): requests,
 *    errors (5xx), status4xx, p50Ms, p95Ms.
 */

const minute = (ms: number) => Math.floor(ms / 60_000) * 60_000;

// ───────────────────────────── docker stats ─────────────────────────────

type StatsJson = {
  cpu_stats: { cpu_usage: { total_usage: number; percpu_usage?: number[] }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number };
  memory_stats: { usage?: number; limit?: number; stats?: Record<string, number> };
  networks?: Record<string, { rx_bytes: number; tx_bytes: number }>;
  blkio_stats?: { io_service_bytes_recursive?: Array<{ op: string; value: number }> | null };
};

/** CPU % like `docker stats` (pure, tested). */
export function cpuPercent(s: StatsJson): number {
  const cpuDelta = s.cpu_stats.cpu_usage.total_usage - (s.precpu_stats.cpu_usage?.total_usage ?? 0);
  const sysDelta = (s.cpu_stats.system_cpu_usage ?? 0) - (s.precpu_stats.system_cpu_usage ?? 0);
  const cpus = s.cpu_stats.online_cpus || s.cpu_stats.cpu_usage.percpu_usage?.length || 1;
  if (cpuDelta <= 0 || sysDelta <= 0) return 0;
  return (cpuDelta / sysDelta) * cpus * 100;
}

export function memoryUsed(s: StatsJson): number {
  const st = s.memory_stats.stats ?? {};
  const cache = st.inactive_file ?? st.total_inactive_file ?? st.cache ?? 0;
  return Math.max(0, (s.memory_stats.usage ?? 0) - cache);
}

type Acc = {
  projectId: string | null;
  deploymentId: string | null;
  containerId: string;
  bucket: number;
  cpuSum: number;
  n: number;
  memMax: number;
  memLimit: number;
  rx: number;
  tx: number;
  blkR: number;
  blkW: number;
  restarts: number;
};

const g = globalThis as unknown as {
  __ldMetricAcc?: Map<string, Acc>;
  __ldMetricPrev?: Map<string, { rx: number; tx: number; r: number; w: number }>;
  __ldServerId?: string | null;
};
const acc = (g.__ldMetricAcc ??= new Map());
const prev = (g.__ldMetricPrev ??= new Map());

async function localServerId(): Promise<string | null> {
  if (g.__ldServerId !== undefined) return g.__ldServerId;
  g.__ldServerId = (await db.server.findFirst({ where: { isLocal: true }, select: { id: true } }))?.id ?? null;
  return g.__ldServerId;
}

export async function sampleContainers(now = Date.now()) {
  const list = await docker().listContainers({ filters: { label: [`${LABELS.managed}=true`, LABELS.deployment] } });
  const bucket = minute(now);
  const work = list.map(async (c) => {
    try {
      const ct = docker().getContainer(c.Id);
      const [stats, info] = await Promise.all([ct.stats({ stream: false }) as unknown as Promise<StatsJson>, ct.inspect()]);
      let rx = 0,
        tx = 0;
      for (const n of Object.values(stats.networks ?? {})) {
        rx += n.rx_bytes;
        tx += n.tx_bytes;
      }
      let br = 0,
        bw = 0;
      for (const e of stats.blkio_stats?.io_service_bytes_recursive ?? []) {
        if (e.op.toLowerCase() === "read") br += e.value;
        if (e.op.toLowerCase() === "write") bw += e.value;
      }
      const p = prev.get(c.Id);
      const d = (cur: number, before?: number) => (before === undefined ? 0 : cur >= before ? cur - before : cur);
      prev.set(c.Id, { rx, tx, r: br, w: bw });
      const key = `${c.Id}:${bucket}`;
      const a: Acc = acc.get(key) ?? {
        projectId: c.Labels[LABELS.project] ?? null,
        deploymentId: c.Labels[LABELS.deployment] ?? null,
        containerId: c.Id,
        bucket,
        cpuSum: 0,
        n: 0,
        memMax: 0,
        memLimit: 0,
        rx: 0,
        tx: 0,
        blkR: 0,
        blkW: 0,
        restarts: 0,
      };
      a.cpuSum += cpuPercent(stats);
      a.n += 1;
      a.memMax = Math.max(a.memMax, memoryUsed(stats));
      a.memLimit = stats.memory_stats.limit ?? 0;
      a.rx += d(rx, p?.rx);
      a.tx += d(tx, p?.tx);
      a.blkR += d(br, p?.r);
      a.blkW += d(bw, p?.w);
      a.restarts = info.RestartCount ?? 0;
      acc.set(key, a);
    } catch {
      /* container vanished mid-sample */
    }
  });
  await Promise.all(work);
  return flushContainerBuckets(now);
}

/** Write finished minutes (bucket < current minute) to MetricSample. */
export async function flushContainerBuckets(now = Date.now(), force = false) {
  const cur = minute(now);
  const serverId = await localServerId();
  const done = [...acc.values()].filter((a) => force || a.bucket < cur);
  if (!done.length) return { written: 0 };
  // deployments may have been deleted meanwhile
  const depIds = [...new Set(done.map((a) => a.deploymentId).filter(Boolean))] as string[];
  const existing = new Set((await db.deployment.findMany({ where: { id: { in: depIds } }, select: { id: true } })).map((d) => d.id));
  const rows = done
    .filter((a) => !a.deploymentId || existing.has(a.deploymentId))
    .map((a) => ({
      kind: "container",
      projectId: a.projectId && a.deploymentId && existing.has(a.deploymentId) ? a.projectId : null,
      deploymentId: a.deploymentId,
      serverId,
      containerId: a.containerId,
      bucket: new Date(a.bucket),
      cpuPercent: a.n ? a.cpuSum / a.n : 0,
      memoryBytes: a.memMax,
      memoryLimitBytes: a.memLimit || null,
      netRxBytes: a.rx,
      netTxBytes: a.tx,
      blockReadBytes: a.blkR,
      blockWriteBytes: a.blkW,
      restarts: a.restarts,
    }));
  if (rows.length) await db.metricSample.createMany({ data: rows });
  for (const a of done) acc.delete(`${a.containerId}:${a.bucket}`);
  return { written: rows.length };
}

// ───────────────────────────── Caddy access log ─────────────────────────────

export type AccessLine = { ts?: number; status?: number; duration?: number; request?: { host?: string } };

type HttpAcc = { projectId: string; deploymentId: string | null; bucket: number; count: number; e5: number; e4: number; durations: number[] };

/** Percentile of a sorted array (nearest-rank). */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

/** Pure aggregation (tested): access-log JSON lines → per (deployment, minute) accumulators. */
export function aggregateAccess(lines: string[], map: Record<string, HostInfo>, into = new Map<string, HttpAcc>()) {
  for (const raw of lines) {
    if (!raw.trim()) continue;
    let j: AccessLine;
    try {
      j = JSON.parse(raw);
    } catch {
      continue;
    }
    const host = (j.request?.host ?? "").replace(/:\d+$/, "").toLowerCase();
    const dot = host.indexOf(".");
    const info = map[host] ?? (dot > 0 ? map[`*.${host.slice(dot + 1)}`] : undefined);
    if (!info) continue;
    const b = minute((j.ts ?? Date.now() / 1000) * 1000);
    const key = `${info.deploymentId ?? info.projectId}:${b}`;
    const a = into.get(key) ?? { projectId: info.projectId, deploymentId: info.deploymentId, bucket: b, count: 0, e5: 0, e4: 0, durations: [] };
    a.count++;
    const s = j.status ?? 0;
    if (s >= 500 || s === 0) a.e5++;
    else if (s >= 400) a.e4++;
    const ms = (j.duration ?? 0) * 1000;
    // reservoir sampling keeps memory bounded
    if (a.durations.length < 4000) a.durations.push(ms);
    else {
      const k = Math.floor(Math.random() * a.count);
      if (k < 4000) a.durations[k] = ms;
    }
    into.set(key, a);
  }
  return into;
}

const tg = globalThis as unknown as {
  __ldAccess?: { timer: NodeJS.Timeout | null; acc: Map<string, HttpAcc>; offset: number; ino: number; partial: string; map: Record<string, HostInfo>; mapAt: number };
};

export function accessLogPath() {
  return env.CADDY_ACCESS_LOG || path.resolve(env.STORAGE_DIR, "caddy", "access.log");
}

async function flushHttp(nowMs: number, force = false) {
  const t = tg.__ldAccess!;
  const cutoff = minute(nowMs) - 60_000; // allow one minute of lateness
  const done = [...t.acc.entries()].filter(([, a]) => force || a.bucket < cutoff);
  if (!done.length) return 0;
  const depIds = [...new Set(done.map(([, a]) => a.deploymentId).filter(Boolean))] as string[];
  const okDeps = new Set((await db.deployment.findMany({ where: { id: { in: depIds } }, select: { id: true } })).map((d) => d.id));
  const okProjects = new Set(
    (await db.project.findMany({ where: { id: { in: [...new Set(done.map(([, a]) => a.projectId))] } }, select: { id: true } })).map((p) => p.id),
  );
  const rows = done
    .filter(([, a]) => okProjects.has(a.projectId))
    .map(([, a]) => {
      const sorted = [...a.durations].sort((x, y) => x - y);
      return {
        kind: "http",
        projectId: a.projectId,
        deploymentId: a.deploymentId && okDeps.has(a.deploymentId) ? a.deploymentId : null,
        bucket: new Date(a.bucket),
        requests: a.count,
        errors: a.e5,
        status4xx: a.e4,
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
      };
    });
  if (rows.length) await db.metricSample.createMany({ data: rows });
  for (const [k] of done) t.acc.delete(k);
  return rows.length;
}

/** One tail step: read new bytes, aggregate, flush finished minutes. */
export async function tailAccessLogOnce(nowMs = Date.now()) {
  const t = (tg.__ldAccess ??= { timer: null, acc: new Map(), offset: -1, ino: 0, partial: "", map: {}, mapAt: 0 });
  const file = accessLogPath();
  if (Date.now() - t.mapAt > 10_000) {
    t.map = await hostMap();
    t.mapAt = Date.now();
  }
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(file);
  } catch {
    return { read: 0, flushed: await flushHttp(nowMs) };
  }
  if (t.offset < 0) {
    // first run: resume from the saved offset (same inode), else start at the end
    const saved = await redis()
      .get("ld:metrics:access:pos")
      .catch(() => null);
    const [ino, off] = (saved ?? "").split(":").map(Number);
    t.offset = ino === st.ino && off! <= st.size ? off! : st.size;
    t.ino = st.ino;
  }
  if (st.ino !== t.ino || st.size < t.offset) {
    t.offset = 0; // rotated / truncated
    t.ino = st.ino;
    t.partial = "";
  }
  let read = 0;
  if (st.size > t.offset) {
    const len = Math.min(st.size - t.offset, 8 * 1024 * 1024);
    const fh = await fs.promises.open(file, "r");
    try {
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, t.offset);
      t.offset += len;
      read = len;
      const text = t.partial + buf.toString("utf8");
      const lines = text.split("\n");
      t.partial = lines.pop() ?? "";
      aggregateAccess(lines, t.map, t.acc);
    } finally {
      await fh.close();
    }
    await redis()
      .set("ld:metrics:access:pos", `${t.ino}:${t.offset}`)
      .catch(() => {});
  }
  return { read, flushed: await flushHttp(nowMs) };
}

export function startAccessLogTailer(intervalMs = 2000) {
  const t = (tg.__ldAccess ??= { timer: null, acc: new Map(), offset: -1, ino: 0, partial: "", map: {}, mapAt: 0 });
  if (t.timer) return;
  let busy = false;
  t.timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void tailAccessLogOnce()
      .catch((e) => console.warn("[metrics] access log:", (e as Error).message))
      .finally(() => (busy = false));
  }, intervalMs);
}

export async function stopAccessLogTailer() {
  const t = tg.__ldAccess;
  if (t?.timer) clearInterval(t.timer);
  if (t) t.timer = null;
  if (t) await flushHttp(Date.now(), true).catch(() => {});
}

// ───────────────────────────── query (API) ─────────────────────────────

export type MetricPoint = {
  t: number;
  requests: number;
  errors: number;
  s4xx: number;
  /** null = no sample in this step (rendered as a gap) */
  p50: number | null;
  p95: number | null;
  cpu: number | null;
  mem: number | null;
  memLimit: number;
  rx: number;
  tx: number;
  restarts: number;
};

export const RANGES = { "1h": [3600_000, 60_000], "6h": [6 * 3600_000, 5 * 60_000], "24h": [86400_000, 15 * 60_000], "7d": [7 * 86400_000, 3600_000] } as const;
export type RangeKey = keyof typeof RANGES;

/** Series for the Observability tab: per step, summed over replicas (cpu/mem summed, latency weighted by requests). */
export async function querySeries(projectId: string, range: RangeKey, deploymentId?: string | null, now = Date.now()) {
  const [span, step] = RANGES[range];
  const to = minute(now) + 60_000;
  const from = to - span;
  const rows = await db.metricSample.findMany({
    where: { projectId, bucket: { gte: new Date(from), lt: new Date(to) }, ...(deploymentId ? { deploymentId } : {}) },
    select: {
      kind: true,
      bucket: true,
      containerId: true,
      cpuPercent: true,
      memoryBytes: true,
      memoryLimitBytes: true,
      netRxBytes: true,
      netTxBytes: true,
      requests: true,
      errors: true,
      status4xx: true,
      p50Ms: true,
      p95Ms: true,
      restarts: true,
    },
    orderBy: { bucket: "asc" },
  });
  const n = Math.ceil(span / step);
  const pts: MetricPoint[] = Array.from({ length: n }, (_, i) => ({
    t: from + i * step,
    requests: 0,
    errors: 0,
    s4xx: 0,
    p50: null,
    p95: null,
    cpu: null,
    mem: null,
    memLimit: 0,
    rx: 0,
    tx: 0,
    restarts: 0,
  }));
  // per step: container rows → average per minute then sum over containers
  const cpuMin = new Map<number, Map<number, number>>(); // step → minute → cpu sum
  const memMin = new Map<number, Map<number, number>>();
  const latW = new Map<number, { w: number; p50: number; p95: number }>();
  const restartsMax = new Map<string, number>();
  for (const r of rows) {
    const i = Math.floor((r.bucket.getTime() - from) / step);
    const p = pts[i];
    if (!p) continue;
    const b = r.bucket.getTime();
    if (r.kind === "http") {
      const req = r.requests ?? 0;
      p.requests += req;
      p.errors += r.errors ?? 0;
      p.s4xx += r.status4xx ?? 0;
      const l = latW.get(i) ?? { w: 0, p50: 0, p95: 0 };
      l.w += req;
      l.p50 += (r.p50Ms ?? 0) * req;
      l.p95 = Math.max(l.p95, r.p95Ms ?? 0);
      latW.set(i, l);
    } else {
      if (!cpuMin.has(i)) cpuMin.set(i, new Map());
      if (!memMin.has(i)) memMin.set(i, new Map());
      cpuMin.get(i)!.set(b, (cpuMin.get(i)!.get(b) ?? 0) + r.cpuPercent);
      memMin.get(i)!.set(b, (memMin.get(i)!.get(b) ?? 0) + r.memoryBytes);
      p.memLimit = Math.max(p.memLimit, r.memoryLimitBytes ?? 0);
      p.rx += r.netRxBytes;
      p.tx += r.netTxBytes;
      const k = r.containerId ?? "";
      restartsMax.set(`${i}:${k}`, Math.max(restartsMax.get(`${i}:${k}`) ?? 0, r.restarts ?? 0));
    }
  }
  for (const [i, m] of cpuMin) pts[i]!.cpu = [...m.values()].reduce((a, b) => a + b, 0) / m.size;
  for (const [i, m] of memMin) pts[i]!.mem = Math.max(...m.values());
  for (const [i, l] of latW) {
    pts[i]!.p50 = l.w ? l.p50 / l.w : null;
    pts[i]!.p95 = l.w ? l.p95 : null;
  }
  for (const [k, v] of restartsMax) pts[Number(k.split(":")[0])]!.restarts += v;
  const totals = pts.reduce(
    (t, p) => ({ requests: t.requests + p.requests, errors: t.errors + p.errors, s4xx: t.s4xx + p.s4xx }),
    { requests: 0, errors: 0, s4xx: 0 },
  );
  return { from, to, step, points: pts, totals };
}
