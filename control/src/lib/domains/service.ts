import type { Domain, Prisma, Project } from "@prisma/client";
import { assertCanAddDomain } from "@/lib/plans/enforce";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { randomId } from "@/lib/crypto";
import { queues } from "@/lib/queues";
import { requestSync } from "@/lib/proxy/sync";
import { isWildcard, normalizeHostname, validateHostname, validateSubdomainLabel, wwwCounterpart } from "./validate";
import { ensurePlatformDomain, platformDomain } from "./platform";
import { cnameTarget, dnsInstructions, serverIps, type DnsCheck } from "./verify";

export class DomainError extends Error {
  constructor(
    message: string,
    public code: "VALIDATION" | "CONFLICT" | "NOT_FOUND" = "VALIDATION",
    public field = "hostname",
  ) {
    super(message);
  }
}

export const newVerifyToken = () => `levant-${randomId(24)}`;

export function domainDTO(d: Domain) {
  const check = (d.dnsRecords ?? null) as (DnsCheck & { failCount?: number }) | null;
  return {
    id: d.id,
    hostname: d.hostname,
    wildcard: isWildcard(d.hostname),
    kind: d.kind,
    status: d.status,
    isPrimary: d.isPrimary,
    redirectTo: d.redirectTo,
    redirectStatus: d.redirectStatus,
    gitBranch: d.gitBranch,
    verifyToken: d.verifyToken,
    verifiedAt: d.verifiedAt?.toISOString() ?? null,
    lastCheckedAt: d.lastCheckedAt?.toISOString() ?? null,
    nextCheckAt: d.nextCheckAt?.toISOString() ?? null,
    lastError: d.lastError,
    certStatus: d.certStatus,
    createdAt: d.createdAt.toISOString(),
    dns: d.kind === "CUSTOM" ? dnsInstructions(d) : [],
    check: check ? { routing: check.routing, ownership: check.ownership, a: check.a, aaaa: check.aaaa, cname: check.cname, txt: check.txt, checkedAt: check.checkedAt } : null,
  };
}
export type DomainDTO = ReturnType<typeof domainDTO>;

export function dnsConfig() {
  return { platformDomain: platformDomain(), serverIps: serverIps(), cnameTarget: cnameTarget() };
}

export async function listDomains(project: Pick<Project, "id" | "slug">) {
  await ensurePlatformDomain(project);
  const rows = await db.domain.findMany({ where: { projectId: project.id }, orderBy: [{ kind: "asc" }, { createdAt: "asc" }] });
  // primary first, then platform, then custom by name
  rows.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || (a.kind === b.kind ? a.hostname.localeCompare(b.hostname) : a.kind === "PLATFORM" ? -1 : 1));
  return rows.map(domainDTO);
}

async function assertFree(hostname: string, projectId: string) {
  const existing = await db.domain.findUnique({ where: { hostname } });
  if (existing) {
    throw new DomainError(existing.projectId === projectId ? `${hostname} is already added to this project` : `${hostname} is already in use by another project`, "CONFLICT");
  }
}

async function assertRedirectTarget(projectId: string, target: string) {
  const t = await db.domain.findFirst({ where: { projectId, hostname: target } });
  if (!t) throw new DomainError("Redirect target must be another domain of this project", "VALIDATION", "redirectTo");
  if (t.redirectTo) throw new DomainError("Redirect target can't itself be a redirect", "VALIDATION", "redirectTo");
  if (isWildcard(t.hostname)) throw new DomainError("Redirect target can't be a wildcard domain", "VALIDATION", "redirectTo");
}

export type AddDomainInput = { hostname: string; redirectTo?: string | null; redirectStatus?: number | null; gitBranch?: string | null; withWww?: boolean };

/** Add a custom domain (+ optional www/apex counterpart that redirects to it). Starts DNS checks. */
export async function addDomain(project: Pick<Project, "id" | "slug">, input: AddDomainInput): Promise<Domain[]> {
  const hostname = normalizeHostname(input.hostname);
  const err = validateHostname(hostname, {
    platformDomain: platformDomain(),
    dashboardHost: env.DASHBOARD_HOST,
    // test/dev only: allow .test/.local… hostnames (resolved by a fake DNS server)
    allowReservedTlds: process.env.NODE_ENV !== "production" && process.env.DOMAINS_ALLOW_RESERVED_TLDS === "1",
  });
  if (err) throw new DomainError(err);
  await assertFree(hostname, project.id);
  await assertCanAddDomain(project.id); // plans area: custom domains per project (402 PLAN_LIMIT)
  const redirectTo = input.redirectTo ? normalizeHostname(input.redirectTo) : null;
  if (redirectTo && isWildcard(hostname)) throw new DomainError("Wildcard domains can't redirect — add the subdomains you want to redirect individually", "VALIDATION", "redirectTo");
  if (redirectTo) await assertRedirectTarget(project.id, redirectTo);
  const created: Domain[] = [];
  const main = await db.domain.create({
    data: {
      projectId: project.id,
      hostname,
      kind: "CUSTOM",
      status: "PENDING",
      verifyToken: newVerifyToken(),
      redirectTo,
      redirectStatus: redirectTo ? (input.redirectStatus ?? 308) : null,
      gitBranch: input.gitBranch?.trim() || null,
    },
  });
  created.push(main);
  if (input.withWww && !redirectTo && !isWildcard(hostname)) {
    const other = wwwCounterpart(hostname);
    // plans area: the www/apex counterpart is skipped (not an error) when it would exceed the plan's domain limit
    const roomForCounterpart = await assertCanAddDomain(project.id).then(() => true, () => false);
    if (other && roomForCounterpart && !(await db.domain.findUnique({ where: { hostname: other } }))) {
      created.push(
        await db.domain.create({
          data: { projectId: project.id, hostname: other, kind: "CUSTOM", status: "PENDING", verifyToken: newVerifyToken(), redirectTo: hostname, redirectStatus: 308 },
        }),
      );
    }
  }
  for (const d of created) await queues.domains.add({ domainId: d.id }, { jobId: `domain-${d.id}-${Date.now()}` }).catch(() => {});
  return created;
}

export type UpdateDomainInput = {
  redirectTo?: string | null;
  redirectStatus?: number | null;
  gitBranch?: string | null;
  isPrimary?: boolean;
  /** PLATFORM domain only: new label for `{label}.{PLATFORM_DOMAIN}` */
  subdomain?: string;
};

export async function updateDomain(project: Pick<Project, "id">, domainId: string, input: UpdateDomainInput): Promise<Domain> {
  const d = await db.domain.findFirst({ where: { id: domainId, projectId: project.id } });
  if (!d) throw new DomainError("Domain not found", "NOT_FOUND");
  const data: Prisma.DomainUncheckedUpdateInput = {};
  if (input.subdomain !== undefined) {
    if (d.kind !== "PLATFORM") throw new DomainError("Only the free platform domain can be renamed", "VALIDATION", "subdomain");
    const label = input.subdomain.trim().toLowerCase();
    const e = validateSubdomainLabel(label);
    if (e) throw new DomainError(e, "VALIDATION", "subdomain");
    const host = `${label}.${platformDomain()}`;
    if (host !== d.hostname) {
      await assertFree(host, project.id);
      if (await db.deployment.findUnique({ where: { url: host }, select: { id: true } })) throw new DomainError(`${host} is already in use`, "CONFLICT", "subdomain");
      data.hostname = host;
      // redirects that pointed at the old name follow the rename
      await db.domain.updateMany({ where: { projectId: project.id, redirectTo: d.hostname }, data: { redirectTo: host } });
    }
  }
  if (input.redirectTo !== undefined) {
    if (input.redirectTo) {
      if (isWildcard(d.hostname)) throw new DomainError("Wildcard domains can't redirect", "VALIDATION", "redirectTo");
      const t = normalizeHostname(input.redirectTo);
      if (t === d.hostname) throw new DomainError("A domain can't redirect to itself", "VALIDATION", "redirectTo");
      await assertRedirectTarget(project.id, t);
      if (await db.domain.count({ where: { projectId: project.id, redirectTo: d.hostname } }))
        throw new DomainError("Other domains redirect to this one — change them first", "CONFLICT", "redirectTo");
      data.redirectTo = t;
      data.redirectStatus = input.redirectStatus ?? d.redirectStatus ?? 308;
      data.isPrimary = false;
    } else {
      data.redirectTo = null;
      data.redirectStatus = null;
    }
  } else if (input.redirectStatus !== undefined && d.redirectTo) data.redirectStatus = input.redirectStatus;
  if (input.gitBranch !== undefined) data.gitBranch = input.gitBranch?.trim() || null;
  if (input.isPrimary) {
    if (d.redirectTo || data.redirectTo) throw new DomainError("A redirecting domain can't be primary", "VALIDATION", "isPrimary");
    await db.domain.updateMany({ where: { projectId: project.id, isPrimary: true }, data: { isPrimary: false } });
    data.isPrimary = true;
  }
  const updated = await db.domain.update({ where: { id: d.id }, data });
  requestSync();
  return updated;
}

export async function removeDomain(project: Pick<Project, "id">, domainId: string): Promise<Domain> {
  const d = await db.domain.findFirst({ where: { id: domainId, projectId: project.id } });
  if (!d) throw new DomainError("Domain not found", "NOT_FOUND");
  if (d.kind === "PLATFORM") throw new DomainError("The free platform domain can't be removed — rename it instead", "CONFLICT");
  // redirects pointing at it would dangle → remove their redirect
  await db.domain.updateMany({ where: { projectId: project.id, redirectTo: d.hostname }, data: { redirectTo: null, redirectStatus: null } });
  await db.domain.delete({ where: { id: d.id } });
  if (d.isPrimary) {
    const p = await db.domain.findFirst({ where: { projectId: project.id, kind: "PLATFORM" } });
    if (p) await db.domain.update({ where: { id: p.id }, data: { isPrimary: true } });
  }
  requestSync();
  return d;
}
