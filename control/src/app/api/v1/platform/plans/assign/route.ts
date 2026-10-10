import { z } from "zod";
import { route, json, body, requirePlatformOwner, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assignPlan, planFor } from "@/lib/plans";

/** POST /api/v1/platform/plans/assign { team: id|slug, plan: id|slug|null } → { team, plan } (null = automatic) */
export const POST = route(async (req) => {
  const actor = await requirePlatformOwner();
  const input = await body(req, z.object({ team: z.string().min(1).max(64), plan: z.string().min(1).max(64).nullable() }));
  const team = await db.team.findFirst({ where: { OR: [{ id: input.team }, { slug: input.team }] } });
  if (!team) throw E.notFound("Team not found");
  const plan = input.plan ? await db.plan.findFirst({ where: { OR: [{ id: input.plan }, { slug: input.plan }] } }) : null;
  if (input.plan && !plan) throw E.validation({ plan: "Unknown plan" });
  await assignPlan(team.id, plan?.id ?? null);
  await audit({ action: "plan.assign", teamId: team.id, actor, targetType: "team", targetId: team.id, meta: { plan: plan?.slug ?? "automatic" } });
  const tp = await planFor(team.id);
  return json({ team: { id: team.id, slug: team.slug, name: team.name }, plan: tp.plan, source: tp.source });
});
