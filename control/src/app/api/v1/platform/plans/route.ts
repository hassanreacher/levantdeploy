import type { Prisma } from "@prisma/client";
import { route, json, body, requirePlatformOwner, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { listPlans, setDefaultPlan, LIMIT_FIELDS, RESOURCES, limitsJsonSchema } from "@/lib/plans";
import { planDTO, planInputSchema } from "@/lib/plans/admin";

export const dynamic = "force-dynamic";

/** GET /api/v1/platform/plans → { items, schema (JSON Schema of PlanLimits), fields, resources, requests } (platform owner) */
export const GET = route(async () => {
  await requirePlatformOwner();
  const [plans, requests] = await Promise.all([
    listPlans({ includeArchived: true }),
    db.planUpgradeRequest.findMany({
      where: { status: "OPEN" },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { team: { select: { id: true, slug: true, name: true } }, plan: { select: { id: true, slug: true, name: true } }, requestedBy: { select: { name: true, email: true } } },
    }),
  ]);
  return json({ items: plans.map(planDTO), schema: limitsJsonSchema(), fields: LIMIT_FIELDS, resources: RESOURCES, requests });
});

/** POST /api/v1/platform/plans { slug, name, description?, priceMonthly?, limits, isDefault?, isInternal?, sortOrder? } → 201 { plan } */
export const POST = route(async (req) => {
  const actor = await requirePlatformOwner();
  const input = await body(req, planInputSchema);
  if (await db.plan.findUnique({ where: { slug: input.slug } })) throw E.validation({ slug: "A plan with this slug already exists" });
  const plan = await db.plan.create({
    data: {
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      priceMonthly: input.priceMonthly ?? null,
      limits: input.limits as unknown as Prisma.InputJsonObject,
      isInternal: input.isInternal ?? false,
      sortOrder: input.sortOrder ?? 50,
    },
  });
  if (input.isDefault) await setDefaultPlan(plan.id);
  await audit({ action: "plan.create", actor, targetType: "plan", targetId: plan.id, meta: { slug: plan.slug } });
  const full = await db.plan.findUniqueOrThrow({ where: { id: plan.id }, include: { _count: { select: { teams: true } } } });
  return json({ plan: planDTO(full) }, 201);
});
