import { z } from "zod";
import { route, json, body, requireTeamRole, throttle, E } from "@/lib/http";
import { db } from "@/lib/db";
import { queues } from "@/lib/queues";
import { audit } from "@/lib/audit";

const schema = z.object({ plan: z.string().max(60).optional().nullable(), message: z.string().trim().max(1000).optional().nullable() });

/**
 * POST /api/v1/teams/:team/plan/upgrade-request { plan?: slug, message? } → 201 { request }
 * No payments yet: notifies the platform owner(s) (in-app + email via the notify queue), who assign the plan in /settings/plans.
 */
export const POST = route<{ team: string }>(async (req, { params }) => {
  const { team: t } = await params;
  const input = await body(req, schema);
  const { team, actor } = await requireTeamRole(t, "ADMIN");
  await throttle(`plan-request:${team.id}`, { limit: 5, window: 3600 });
  const plan = input.plan ? await db.plan.findFirst({ where: { slug: input.plan, archivedAt: null, isInternal: false } }) : null;
  if (input.plan && !plan) throw E.validation({ plan: "Unknown plan" });
  const existing = await db.planUpgradeRequest.findFirst({ where: { teamId: team.id, status: "OPEN" } });
  const request = existing
    ? await db.planUpgradeRequest.update({ where: { id: existing.id }, data: { planId: plan?.id ?? existing.planId, message: input.message ?? existing.message, requestedById: actor.user.id } })
    : await db.planUpgradeRequest.create({ data: { teamId: team.id, requestedById: actor.user.id, planId: plan?.id ?? null, message: input.message ?? null } });
  await queues.notify
    .add({ event: "plan.upgrade_request", teamId: team.id, payload: { requestId: request.id, plan: plan?.name ?? null, message: input.message ?? null, by: actor.user.name } })
    .catch(() => {});
  await audit({ action: "plan.upgrade_request", teamId: team.id, actor, targetType: "team", targetId: team.id, meta: { plan: plan?.slug ?? null } });
  return json({ request: { id: request.id, status: request.status, plan: plan ? { slug: plan.slug, name: plan.name } : null, createdAt: request.createdAt } }, 201);
});
