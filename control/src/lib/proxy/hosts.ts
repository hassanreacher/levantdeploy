import type { Deployment, Domain, Project } from "@prisma/client";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { branchHost, dnsLabel } from "@/lib/deployments";
import { platformDomain } from "@/lib/domains/platform";
import { coveringWildcard } from "@/lib/domains/validate";
import { baseHostAllowedForTls } from "@/lib/base/routes";
import { builderIdFromHost as builderPreviewIdFromHost } from "@/lib/builder/host";

export type ResolvedHost =
  | { kind: "dashboard" }
  | { kind: "deployment"; deployment: Deployment; project: Project }
  | { kind: "domain"; domain: Domain; project: Project }
  | { kind: "branch"; branch: string; project: Project; deployment: Deployment | null }
  | { kind: "unknown" };

export const cleanHost = (h: string) => h.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");

/** What does this hostname belong to? (tls-ask, branded 404/503 pages) */
export async function resolveHost(raw: string): Promise<ResolvedHost> {
  const host = cleanHost(raw);
  if (!host) return { kind: "unknown" };
  if (host === cleanHost(env.DASHBOARD_HOST)) return { kind: "dashboard" };
  const domain = await db.domain.findUnique({ where: { hostname: host }, include: { project: true } });
  if (domain) return { kind: "domain", domain, project: domain.project };
  // a single-label subdomain of a wildcard custom domain (`a.example.com` ← `*.example.com`); exact hosts above win
  const wc = coveringWildcard(host);
  if (wc) {
    const w = await db.domain.findUnique({ where: { hostname: wc }, include: { project: true } });
    if (w) return { kind: "domain", domain: w, project: w.project };
  }
  const pd = platformDomain();
  if (!host.endsWith(`.${pd}`)) return { kind: "unknown" };
  const dep = await db.deployment.findUnique({ where: { url: host }, include: { project: true } });
  if (dep) return { kind: "deployment", deployment: dep, project: dep.project };
  const label = host.slice(0, -pd.length - 1);
  if (label.includes(".")) return { kind: "unknown" };
  const idx = label.indexOf("-git-");
  if (idx > 0) {
    const slugPart = label.slice(0, idx);
    const projects = await db.project.findMany({ where: { slug: { startsWith: slugPart.slice(0, 20) } }, take: 50 });
    for (const p of projects) {
      if (!dnsLabel(p.slug).startsWith(slugPart)) continue;
      const branches = await db.deployment.findMany({ where: { projectId: p.id, branch: { not: null } }, distinct: ["branch"], select: { branch: true }, take: 500 });
      for (const b of branches) {
        if (b.branch && branchHost(p.slug, b.branch) === host) {
          const latest = await db.deployment.findFirst({ where: { projectId: p.id, branch: b.branch }, orderBy: { createdAt: "desc" } });
          return { kind: "branch", branch: b.branch, project: p, deployment: latest };
        }
      }
    }
  }
  return { kind: "unknown" };
}

/** May Caddy obtain a certificate for this host? (on-demand TLS gate) */
export async function hostAllowedForTls(raw: string): Promise<boolean> {
  if (raw.includes("*")) return false; // SNI names are concrete; wildcard certs need DNS-01 (not used)
  // base-runtime area: {ref}.BASE_DOMAIN / studio-{ref}.BASE_DOMAIN → only for existing Base projects
  const base = await baseHostAllowedForTls(raw);
  if (base !== null) return base;
  // builder-core area: preview-{id}.PLATFORM_DOMAIN → only for existing builder projects
  const builderId = builderPreviewIdFromHost(raw);
  if (builderId) return !!(await db.builderProject.findUnique({ where: { id: builderId }, select: { id: true } }));
  const r = await resolveHost(raw);
  switch (r.kind) {
    case "dashboard":
    case "deployment":
    case "branch":
      return true;
    case "domain":
      return r.domain.kind === "PLATFORM" || r.domain.status === "ACTIVE";
    default:
      return false;
  }
}
