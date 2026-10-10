import type { Deployment, Domain, Project } from "@prisma/client";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { branchHost } from "@/lib/deployments";
import { containerRefs } from "@/lib/runtime/containers";
import { readProtection } from "@/lib/dashboard/protection";
import type { ProxyState, RedirectRoute, SiteProtection, SiteRoute } from "./config";
import { loadBaseRoutes } from "@/lib/base/routes";

type Dep = Pick<Deployment, "id" | "projectId" | "url" | "branch" | "target" | "status" | "isCurrentProduction" | "containerIds" | "stoppedAt" | "readyAt" | "createdAt">;

/** A deployment can receive traffic: READY/SUPERSEDED, not stopped, has containers. */
export const isLive = (d: Pick<Deployment, "status" | "stoppedAt" | "containerIds">) =>
  (d.status === "READY" || d.status === "SUPERSEDED") && !d.stoppedAt && containerRefs(d as Deployment).length > 0;

export function upstreamsOf(d: Pick<Deployment, "containerIds">): string[] {
  const refs = containerRefs(d as Deployment);
  const pub = refs.filter((r) => r.public);
  return (pub.length ? pub : refs.filter((r) => !r.service)).map((r) => `${r.alias}:${r.port}`);
}

/**
 * Pure part of the state derivation (tested): projects + their domains + live/candidate deployments → sites/redirects.
 *  - every live deployment: its own URL
 *  - current production (live): all ACTIVE domains of the project without gitBranch (incl. the PLATFORM one)
 *  - branch alias `{project}-git-{branch}`: latest live deployment of that branch; custom domains pinned to that branch too
 *  - ACTIVE domains with redirectTo: redirect routes
 */
export function deriveRoutes(
  projects: Array<Pick<Project, "id" | "slug"> & { kind?: Project["kind"]; protection?: unknown }>,
  domains: Array<Pick<Domain, "hostname" | "projectId" | "status" | "redirectTo" | "redirectStatus" | "gitBranch">>,
  deployments: Dep[],
): { sites: SiteRoute[]; redirects: RedirectRoute[] } {
  const sites: SiteRoute[] = [];
  const redirects: RedirectRoute[] = [];
  const byProject = new Map<string, Dep[]>();
  for (const d of deployments) {
    if (!byProject.has(d.projectId)) byProject.set(d.projectId, []);
    byProject.get(d.projectId)!.push(d);
  }
  const taken = new Set<string>();
  const hostsFor = new Map<string, string[]>(); // deploymentId → hosts
  const previewish = new Set<string>(); // deployment URLs, branch aliases, branch-pinned domains
  const add = (depId: string, h: string, preview = false) => {
    const host = h.toLowerCase();
    if (taken.has(host)) return;
    taken.add(host);
    if (preview) previewish.add(host);
    if (!hostsFor.has(depId)) hostsFor.set(depId, []);
    hostsFor.get(depId)!.push(host);
  };

  for (const p of projects) {
    if (p.kind === "WORKER") continue; // background workers have no HTTP endpoint
    const deps = (byProject.get(p.id) ?? []).filter(isLive);
    const pDomains = domains.filter((x) => x.projectId === p.id && x.status === "ACTIVE");
    for (const d of pDomains) if (d.redirectTo) redirects.push({ host: d.hostname.toLowerCase(), to: d.redirectTo.toLowerCase(), status: d.redirectStatus ?? 308, projectId: p.id });
    for (const r of redirects) taken.add(r.host);

    const prod = deps.find((d) => d.isCurrentProduction);
    if (prod) for (const d of pDomains) if (!d.redirectTo && !d.gitBranch) add(prod.id, d.hostname);

    // latest live deployment per branch
    const latest = new Map<string, Dep>();
    for (const d of deps) {
      if (!d.branch) continue;
      const cur = latest.get(d.branch);
      const t = (x: Dep) => (x.readyAt ?? x.createdAt).getTime();
      if (!cur || t(d) > t(cur)) latest.set(d.branch, d);
    }
    for (const [branch, d] of latest) {
      add(d.id, branchHost(p.slug, branch), true);
      for (const dom of pDomains) if (!dom.redirectTo && dom.gitBranch === branch) add(d.id, dom.hostname, true);
    }
    for (const d of deps) add(d.id, d.url, true);

    const prot = readProtection(p.protection);
    const protection: SiteProtection | undefined =
      prot.mode !== "none" && prot.passwordHash ? { mode: prot.mode, username: prot.username, passwordHash: prot.passwordHash } : undefined;
    for (const d of deps) {
      const hosts = hostsFor.get(d.id);
      const ups = upstreamsOf(d);
      if (!hosts?.length || !ups.length) continue;
      const site: SiteRoute = { hosts, upstreams: ups, projectId: p.id, deploymentId: d.id };
      if (protection) {
        site.protection = protection;
        site.protectedHosts = prot.scope === "all" ? hosts : hosts.filter((h) => previewish.has(h));
      }
      sites.push(site);
    }
  }
  return { sites, redirects };
}

export function adminOrigins(): string[] {
  const set = new Set(["localhost:2019", "127.0.0.1:2019", "caddy:2019", "levant-caddy:2019", "[::1]:2019"]);
  try {
    set.add(new URL(env.CADDY_ADMIN_URL).host);
  } catch {}
  return [...set];
}

/** Read the DB and build the full ProxyState. */
export async function loadProxyState(): Promise<ProxyState> {
  const [projects, domains, deployments] = await Promise.all([
    db.project.findMany({ select: { id: true, slug: true, kind: true, protection: true } }),
    db.domain.findMany({ where: { status: "ACTIVE" }, select: { hostname: true, projectId: true, status: true, redirectTo: true, redirectStatus: true, gitBranch: true } }),
    db.deployment.findMany({
      where: { status: { in: ["READY", "SUPERSEDED"] }, stoppedAt: null },
      select: { id: true, projectId: true, url: true, branch: true, target: true, status: true, isCurrentProduction: true, containerIds: true, stoppedAt: true, readyAt: true, createdAt: true },
    }),
  ]);
  const { sites, redirects } = deriveRoutes(projects, domains, deployments);
  const bases = await loadBaseRoutes().catch((e) => {
    console.warn("[proxy] base routes:", (e as Error).message);
    return [];
  });
  return {
    dashboardHost: env.DASHBOARD_HOST,
    controlUpstream: env.CONTROL_UPSTREAM,
    scheme: env.PLATFORM_SCHEME,
    tls: env.PROXY_TLS,
    acmeEmail: env.ACME_EMAIL,
    logDir: env.CADDY_LOG_DIR,
    adminListen: process.env.CADDY_ADMIN_LISTEN || "0.0.0.0:2019",
    adminOrigins: adminOrigins(),
    sites,
    redirects,
    bases,
    // builder-core: static route for AI builder previews (preview-{id}.{PLATFORM_DOMAIN})
    builderPreviewDomain: process.env.BUILDER_PREVIEWS === "off" ? null : env.PLATFORM_DOMAIN,
  };
}
