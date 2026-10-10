import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { route, json, body, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { newVerifyToken } from "@/lib/domains/service";
import { normalizeHostname, validateHostname, isWildcard } from "@/lib/domains/validate";
import { dnsInstructions } from "@/lib/domains/verify";
import { platformDomain } from "@/lib/domains/platform";
import { syncBaseRoutes } from "@/lib/base-ui/adapters";
import { requireBaseRole } from "@/lib/base-ui/access";
import { readStored } from "@/lib/base-ui/settings";

export const dynamic = "force-dynamic";

const view = (settings: unknown) => {
  const c = readStored(settings).customDomain;
  return c ? { hostname: c.hostname, status: c.status, lastError: c.lastError ?? null, records: dnsInstructions({ hostname: c.hostname, verifyToken: c.verifyToken }) } : null;
};

/** GET /api/v1/base/projects/:ref/domain — custom API domain + DNS records (VIEWER). */
export const GET = route<{ ref: string }>(async (_req, { params }) => {
  const { ref } = await params;
  const { base } = await requireBaseRole(ref, "VIEWER");
  return json({ domain: view(base.settings) });
});

/** PUT { hostname } — ADMIN: set the custom API domain (verification via the domains lib DNS check). */
export const PUT = route<{ ref: string }>(async (req, { params }) => {
  const { ref } = await params;
  const input = await body(req, z.object({ hostname: z.string().min(1).max(253) }));
  const { base, team, actor } = await requireBaseRole(ref, "ADMIN");
  const host = normalizeHostname(input.hostname);
  if (isWildcard(host)) throw E.validation({ hostname: "Wildcards can't be used as an API domain" });
  const err = validateHostname(host, { platformDomain: platformDomain(), dashboardHost: env.DASHBOARD_HOST });
  if (err) throw E.validation({ hostname: err });
  if (await db.domain.findUnique({ where: { hostname: host }, select: { id: true } })) throw E.conflict(`${host} is already used by a Deploy project`);
  const others = await db.baseProject.findMany({ where: { id: { not: base.id } }, select: { settings: true } });
  if (others.some((o) => readStored(o.settings).customDomain?.hostname === host)) throw E.conflict(`${host} is already used by another Base project`);
  const s = readStored(base.settings);
  s.customDomain = { hostname: host, verifyToken: s.customDomain?.hostname === host ? s.customDomain.verifyToken : newVerifyToken(), status: "PENDING", lastError: null };
  const row = await db.baseProject.update({ where: { id: base.id }, data: { settings: s as Prisma.InputJsonObject } });
  await audit({ action: "base.domain.set", teamId: team.id, actor, targetType: "base_project", targetId: base.id, meta: { ref, hostname: host } });
  return json({ domain: view(row.settings) });
});

/** DELETE — ADMIN: back to {ref}.{BASE_DOMAIN}. */
export const DELETE = route<{ ref: string }>(async (_req, { params }) => {
  const { ref } = await params;
  const { base, team, actor } = await requireBaseRole(ref, "ADMIN");
  const s = readStored(base.settings);
  const host = s.customDomain?.hostname ?? null;
  s.customDomain = null;
  await db.baseProject.update({ where: { id: base.id }, data: { settings: s as Prisma.InputJsonObject } });
  await syncBaseRoutes().catch(() => {});
  await audit({ action: "base.domain.remove", teamId: team.id, actor, targetType: "base_project", targetId: base.id, meta: { ref, hostname: host } });
  return json({ ok: true });
});
