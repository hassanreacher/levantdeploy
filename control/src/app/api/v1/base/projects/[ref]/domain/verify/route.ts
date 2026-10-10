import type { Prisma } from "@prisma/client";
import { route, json, throttle, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { checkDns, dnsInstructions } from "@/lib/domains/verify";
import { syncBaseRoutes } from "@/lib/base-ui/adapters";
import { requireBaseRole } from "@/lib/base-ui/access";
import { readStored } from "@/lib/base-ui/settings";

/** POST /api/v1/base/projects/:ref/domain/verify — ADMIN: DNS check now (routing + TXT ownership). */
export const POST = route<{ ref: string }>(async (_req, { params }) => {
  const { ref } = await params;
  const { base, team, actor } = await requireBaseRole(ref, "ADMIN");
  await throttle(`base:domain-verify:${actor.user.id}`, { limit: 20, window: 60 });
  const s = readStored(base.settings);
  const c = s.customDomain;
  if (!c) throw E.notFound("No custom domain set");
  const check = await checkDns(c.hostname, c.verifyToken);
  s.customDomain = { ...c, status: check.ok ? "ACTIVE" : "FAILED", lastError: check.ok ? null : check.reason };
  await db.baseProject.update({ where: { id: base.id }, data: { settings: s as Prisma.InputJsonObject } });
  if (check.ok) {
    await syncBaseRoutes().catch(() => {});
    await audit({ action: "base.domain.verify", teamId: team.id, actor, targetType: "base_project", targetId: base.id, meta: { ref, hostname: c.hostname } });
  }
  return json({ ok: check.ok, check, domain: { hostname: c.hostname, status: s.customDomain.status, lastError: s.customDomain.lastError, records: dnsInstructions(c) } });
});
