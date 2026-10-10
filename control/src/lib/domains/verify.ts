import type { Domain, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { queues } from "@/lib/queues";
import { syncRoutes } from "@/lib/proxy/sync";
import { dnsLookup, type DnsLookup } from "./dns";
import { isApex, isWildcard, wildcardBase } from "./validate";
import { randomId } from "@/lib/crypto";
import { platformDomain } from "./platform";

/** Ownership TXT record. For a wildcard `*.example.com` it is the base's: `_levant-verify.example.com`. */
export const verifyRecordName = (host: string) => `_levant-verify.${wildcardBase(host)}`;
export const cnameTarget = () => `cname.${platformDomain()}`;
export function serverIps(): string[] {
  return env.SERVER_IPS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export type DnsRecordHint = { type: "A" | "AAAA" | "CNAME" | "TXT"; name: string; value: string; purpose: "routing" | "ownership"; alternative?: boolean };

/** DNS records the user must create (shown in the UI). */
export function dnsInstructions(d: Pick<Domain, "hostname" | "verifyToken">): DnsRecordHint[] {
  const ips = serverIps();
  const v4 = ips.filter((ip) => ip.includes("."));
  const v6 = ips.filter((ip) => ip.includes(":"));
  const recs: DnsRecordHint[] = [];
  const base = wildcardBase(d.hostname);
  const apex = isApex(base);
  // record names relative to the registrable zone (last two labels)
  const rel = base.split(".").slice(0, -2).join(".");
  const name = isWildcard(d.hostname) ? (rel ? `*.${rel}` : "*") : apex ? "@" : rel;
  if (apex && !isWildcard(d.hostname)) {
    for (const ip of v4.length ? v4 : ["<server IPv4>"]) recs.push({ type: "A", name, value: ip, purpose: "routing" });
    for (const ip of v6) recs.push({ type: "AAAA", name, value: ip, purpose: "routing" });
  } else {
    recs.push({ type: "CNAME", name, value: cnameTarget(), purpose: "routing" });
    for (const ip of v4) recs.push({ type: "A", name, value: ip, purpose: "routing", alternative: true });
  }
  const txtName = rel ? `_levant-verify.${rel}` : "_levant-verify";
  recs.push({ type: "TXT", name: txtName, value: d.verifyToken, purpose: "ownership" });
  return recs;
}

export type DnsCheck = {
  ok: boolean;
  routing: boolean;
  ownership: boolean;
  a: string[];
  aaaa: string[];
  cname: string[];
  txt: string[];
  reason: string | null;
  checkedAt: string;
};

/** Pure-ish check against an injectable resolver (tested with a fake DNS server). */
export async function checkDns(host: string, token: string, lookup: DnsLookup = dnsLookup(), ips = serverIps()): Promise<DnsCheck> {
  // wildcard: resolve a random name under it (answered by the `*` record)
  const probe = isWildcard(host) ? `levant-probe-${randomId(8)}.${wildcardBase(host)}` : host;
  const [a, aaaa, cname, txt] = await Promise.all([lookup.a(probe), lookup.aaaa(probe), lookup.cname(probe), lookup.txt(verifyRecordName(host))]);
  const target = cnameTarget();
  const pd = platformDomain();
  const cnameOk = cname.some((c) => c === target || c.endsWith(`.${pd}`) || c === pd);
  const ipOk = ips.length ? a.some((x) => ips.includes(x)) || aaaa.some((x) => ips.includes(x)) : a.length > 0 || aaaa.length > 0;
  const routing = cnameOk || ipOk;
  const ownership = txt.some((t) => t.trim() === token);
  let reason: string | null = null;
  if (!routing)
    reason = a.length || cname.length
      ? `Points to ${[...cname, ...a].slice(0, 3).join(", ")} instead of ${ips.length ? ips.join(" / ") : "this server"}${isApex(host) ? "" : ` or ${target}`}`
      : isWildcard(host)
        ? `No wildcard record found (${host} → A/CNAME)`
        : "No A/AAAA or CNAME record found";
  else if (!ownership) reason = txt.length ? `TXT ${verifyRecordName(host)} has a different value` : `TXT record ${verifyRecordName(host)} not found`;
  return { ok: routing && ownership, routing, ownership, a, aaaa, cname, txt, reason, checkedAt: new Date().toISOString() };
}

/** Check cadence: every minute for the first hour, every 10 min for 48 h, then daily. */
export function nextCheckDelayMs(createdAt: Date, now = new Date()): number {
  const age = now.getTime() - createdAt.getTime();
  if (age < 3600_000) return 60_000;
  if (age < 48 * 3600_000) return 10 * 60_000;
  return 24 * 3600_000;
}

/**
 * Check one custom domain and apply the state machine:
 *   PENDING/VERIFYING/FAILED + ok → ACTIVE (routes synced, notify "domain.verified")
 *   ACTIVE + not ok twice in a row → FAILED (routes synced, notify "domain.failed")
 */
export async function checkDomain(domainId: string, opts: { lookup?: DnsLookup; manual?: boolean } = {}) {
  const d = await db.domain.findUnique({ where: { id: domainId }, include: { project: { select: { id: true, teamId: true, name: true } } } });
  if (!d || d.kind === "PLATFORM" || d.status === "DISABLED") return d;
  const now = new Date();
  let check: DnsCheck;
  try {
    check = await checkDns(d.hostname, d.verifyToken, opts.lookup);
  } catch (e) {
    check = { ok: false, routing: false, ownership: false, a: [], aaaa: [], cname: [], txt: [], reason: `DNS lookup failed: ${(e as Error).message}`, checkedAt: now.toISOString() };
  }
  const prevFails = Number((d.dnsRecords as { failCount?: number } | null)?.failCount ?? 0);
  const failCount = check.ok ? 0 : prevFails + 1;
  let status = d.status;
  let event: string | null = null;
  if (check.ok && d.status !== "ACTIVE") {
    status = "ACTIVE";
    event = "domain.verified";
  } else if (!check.ok && d.status === "ACTIVE" && (failCount >= 2 || opts.manual)) {
    status = "FAILED";
    event = "domain.failed";
  } else if (!check.ok && d.status === "VERIFYING") {
    status = "PENDING";
  }
  const data: Prisma.DomainUpdateInput = {
    status,
    lastCheckedAt: now,
    nextCheckAt: new Date(now.getTime() + (status === "ACTIVE" ? 24 * 3600_000 : nextCheckDelayMs(d.createdAt, now))),
    lastError: check.ok ? null : check.reason,
    dnsRecords: { ...check, failCount } as unknown as Prisma.InputJsonValue,
  };
  if (status === "ACTIVE" && d.status !== "ACTIVE") {
    data.verifiedAt = now;
    data.certStatus = "PENDING";
  }
  const updated = await db.domain.update({ where: { id: d.id }, data });
  if (status !== d.status) {
    await syncRoutes();
    if (event)
      await queues.notify
        .add({ event, teamId: d.project.teamId, projectId: d.projectId, payload: { domainId: d.id, hostname: d.hostname, reason: check.reason } })
        .catch(() => {});
  }
  return updated;
}

/** Domains tick: check every custom domain whose nextCheckAt is due. */
export async function dueDomains(now = new Date(), limit = 50) {
  return db.domain.findMany({
    where: { kind: "CUSTOM", status: { in: ["PENDING", "VERIFYING", "ACTIVE", "FAILED"] }, OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }] },
    orderBy: { nextCheckAt: "asc" },
    take: limit,
    select: { id: true },
  });
}
