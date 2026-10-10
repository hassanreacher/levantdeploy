import fs from "node:fs";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { accessLogPath } from "@/lib/runtime/metrics";
import { psql } from "./compose";
import { parseBaseHost } from "./config";
import { baseEvent } from "./events";
import { baseLimitsForTeam } from "./limits";
import { readSettings } from "./settings";

/**
 * Usage:
 *  - access-log tailer (worker, every few seconds): Caddy JSON access log lines for {ref}.{BASE_DOMAIN} →
 *    Redis hash `lb:usage:{ref}` {requests, fn, egress, last} (same file the runtime metrics tailer reads; own offset)
 *  - sampleUsage(ref) (worker, every 15 min): db size, storage size, MAU via SQL + the counters above → BaseUsageSample,
 *    BaseProject.lastActivityAt
 */

export type BaseAccessAcc = Map<string, { requests: number; fn: number; egress: number; last: number }>;

/** Pure (tested): access-log JSON lines → per-ref counters. Studio hosts don't count as API activity. */
export function aggregateBaseAccess(lines: string[], into: BaseAccessAcc = new Map()): BaseAccessAcc {
  for (const raw of lines) {
    if (!raw.trim()) continue;
    let j: { ts?: number; size?: number; request?: { host?: string; uri?: string } };
    try {
      j = JSON.parse(raw);
    } catch {
      continue;
    }
    const h = parseBaseHost(j.request?.host ?? "");
    if (!h || h.kind !== "api") continue;
    const a = into.get(h.ref) ?? { requests: 0, fn: 0, egress: 0, last: 0 };
    a.requests++;
    if ((j.request?.uri ?? "").startsWith("/functions/v1/")) a.fn++;
    a.egress += Math.max(0, Number(j.size ?? 0));
    a.last = Math.max(a.last, Math.round((j.ts ?? Date.now() / 1000) * 1000));
    into.set(h.ref, a);
  }
  return into;
}

const POS_KEY = "lb:usage:access:pos";
const ug = globalThis as unknown as { __lbAccess?: { timer: NodeJS.Timeout | null; offset: number; ino: number; partial: string } };

export async function tailBaseAccessOnce(): Promise<number> {
  const t = (ug.__lbAccess ??= { timer: null, offset: -1, ino: 0, partial: "" });
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(accessLogPath());
  } catch {
    return 0;
  }
  if (t.offset < 0) {
    const saved = await redis().get(POS_KEY).catch(() => null);
    const [ino, off] = (saved ?? "").split(":").map(Number);
    t.offset = ino === st.ino && off! <= st.size ? off! : st.size;
    t.ino = st.ino;
  }
  if (st.ino !== t.ino || st.size < t.offset) {
    t.offset = 0;
    t.ino = st.ino;
    t.partial = "";
  }
  if (st.size <= t.offset) return 0;
  const len = Math.min(st.size - t.offset, 8 * 1024 * 1024);
  const fh = await fs.promises.open(accessLogPath(), "r");
  const buf = Buffer.alloc(len);
  try {
    await fh.read(buf, 0, len, t.offset);
  } finally {
    await fh.close();
  }
  t.offset += len;
  const lines = (t.partial + buf.toString("utf8")).split("\n");
  t.partial = lines.pop() ?? "";
  const acc = aggregateBaseAccess(lines);
  const r = redis();
  for (const [ref, a] of acc) {
    const k = `lb:usage:${ref}`;
    await r.hincrby(k, "requests", a.requests);
    await r.hincrby(k, "fn", a.fn);
    await r.hincrby(k, "egress", a.egress);
    const prev = Number((await r.hget(k, "last")) ?? 0);
    if (a.last > prev) await r.hset(k, "last", String(a.last));
  }
  await r.set(POS_KEY, `${t.ino}:${t.offset}`).catch(() => {});
  return acc.size;
}

export function startBaseAccessTailer(intervalMs = 5000) {
  const t = (ug.__lbAccess ??= { timer: null, offset: -1, ino: 0, partial: "" });
  if (t.timer) return;
  let busy = false;
  t.timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void tailBaseAccessOnce()
      .catch((e) => console.warn("[base] access log:", (e as Error).message))
      .finally(() => (busy = false));
  }, intervalMs);
}

/** SQL usage of a running project. */
export async function measureDb(ref: string): Promise<{ dbSizeBytes: bigint; storageSizeBytes: bigint; mau: number }> {
  const out = await psql(
    ref,
    `select pg_database_size('postgres'),
            (select coalesce(sum((metadata->>'size')::bigint), 0) from storage.objects),
            (select count(*) from auth.users where last_sign_in_at >= date_trunc('month', now()));`,
  );
  const [db1, st, mau] = out.trim().split("|");
  return { dbSizeBytes: BigInt(db1 || 0), storageSizeBytes: BigInt(st || 0), mau: Number(mau || 0) };
}

export async function sampleUsage(ref: string) {
  const p = await db.baseProject.findUnique({ where: { ref } });
  if (!p) return null;
  const k = `lb:usage:${ref}`;
  const counters = await redis().hgetall(k);
  // take-and-reset the counters (small race window acceptable for metering)
  await redis().hincrby(k, "requests", -Number(counters.requests ?? 0));
  await redis().hincrby(k, "fn", -Number(counters.fn ?? 0));
  await redis().hincrby(k, "egress", -Number(counters.egress ?? 0));
  let measured = { dbSizeBytes: 0n, storageSizeBytes: 0n, mau: 0 };
  if (p.status === "ACTIVE") measured = await measureDb(ref).catch(() => measured);
  else {
    const prev = await db.baseUsageSample.findFirst({ where: { baseProjectId: p.id }, orderBy: { at: "desc" } });
    if (prev) measured = { dbSizeBytes: prev.dbSizeBytes, storageSizeBytes: prev.storageSizeBytes, mau: prev.mau };
  }
  const sample = await db.baseUsageSample.create({
    data: {
      baseProjectId: p.id,
      dbSizeBytes: measured.dbSizeBytes,
      storageSizeBytes: measured.storageSizeBytes,
      mau: measured.mau,
      requests: Number(counters.requests ?? 0),
      functionInvocations: Number(counters.fn ?? 0),
      egressBytes: BigInt(counters.egress ?? 0),
    },
  });
  if (p.status === "ACTIVE") {
    const { applyEnforcement } = await import("./enforce");
    const limits = await baseLimitsForTeam(p.teamId, readSettings(p.settings).limits);
    await applyEnforcement(p, limits, {
      dbSizeBytes: Number(measured.dbSizeBytes),
      storageSizeBytes: Number(measured.storageSizeBytes),
      mau: measured.mau,
    }).catch((e) => console.warn(`[base] enforcement ${ref}:`, (e as Error).message));
  }
  const last = Number(counters.last ?? 0);
  if (last && (!p.lastActivityAt || last > p.lastActivityAt.getTime())) {
    await db.baseProject.update({ where: { id: p.id }, data: { lastActivityAt: new Date(last) } });
  }
  return sample;
}

/** Month-to-date totals + latest gauges (dashboard + plan enforcement). */
export async function baseUsage(ref: string, now = new Date()) {
  const p = await db.baseProject.findUnique({ where: { ref } });
  if (!p) return null;
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [agg, latest] = await Promise.all([
    db.baseUsageSample.aggregate({ where: { baseProjectId: p.id, at: { gte: monthStart } }, _sum: { requests: true, functionInvocations: true, egressBytes: true } }),
    db.baseUsageSample.findFirst({ where: { baseProjectId: p.id }, orderBy: { at: "desc" } }),
  ]);
  const live = await redis().hgetall(`lb:usage:${ref}`).catch(() => ({}) as Record<string, string>);
  const limits = await baseLimitsForTeam(p.teamId, readSettings(p.settings).limits);
  const fns = await db.baseFunction.count({ where: { baseProjectId: p.id } });
  const month = {
    requests: (agg._sum.requests ?? 0) + Number(live.requests ?? 0),
    functionInvocations: (agg._sum.functionInvocations ?? 0) + Number(live.fn ?? 0),
    egressBytes: (agg._sum.egressBytes ?? 0n) + BigInt(live.egress ?? 0),
  };
  return {
    // flat aliases (dashboard naming)
    dbBytes: Number(latest?.dbSizeBytes ?? 0n),
    storageBytes: Number(latest?.storageSizeBytes ?? 0n),
    egressBytes: Number(month.egressBytes),
    invocations: month.functionInvocations,
    functions: fns,
    at: latest?.at ?? null,
    dbSizeBytes: latest?.dbSizeBytes ?? 0n,
    storageSizeBytes: latest?.storageSizeBytes ?? 0n,
    mau: latest?.mau ?? 0,
    month,
    lastActivityAt: p.lastActivityAt,
    limits,
  };
}

/** Projects whose plan pauses them after N idle days. Returns refs that should be paused now. */
export async function inactiveProjects(now = Date.now()): Promise<string[]> {
  const rows = await db.baseProject.findMany({ where: { status: "ACTIVE" }, select: { ref: true, teamId: true, settings: true, lastActivityAt: true, createdAt: true } });
  const out: string[] = [];
  for (const r of rows) {
    const live = Number((await redis().hget(`lb:usage:${r.ref}`, "last").catch(() => null)) ?? 0);
    const last = Math.max(r.lastActivityAt?.getTime() ?? 0, r.createdAt.getTime(), live);
    const l = await baseLimitsForTeam(r.teamId, readSettings(r.settings).limits);
    if (l.pauseAfterDays != null && now - last > l.pauseAfterDays * 86400_000) out.push(r.ref);
  }
  return out;
}

export { baseEvent };
