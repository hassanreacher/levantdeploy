import type { Prisma } from "@prisma/client";
import { route, json, body, requirePlatformOwner, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { setDefaultPlan } from "@/lib/plans";
import { planDTO, planInputSchema } from "@/lib/plans/admin";

type P = { id: string };
const patchSchema = planInputSchema.partial().extend({ archived: planInputSchema.shape.isDefault });

async function load(id: string) {
  const p = await db.plan.findFirst({ where: { OR: [{ id }, { slug: id }] } });
  if (!p) throw E.notFound("Plan not found");
  return p;
}

/** PATCH /api/v1/platform/plans/:id|slug { …any plan field, archived? } → { plan } */
export const PATCH = route<P>(async (req, { params }) => {
  const actor = await requirePlatformOwner();
  const { id } = await params;
  const cur = await load(id);
  const input = await body(req, patchSchema);
  if (input.slug && input.slug !== cur.slug && (await db.plan.findUnique({ where: { slug: input.slug } }))) throw E.validation({ slug: "A plan with this slug already exists" });
  if (input.archived && (cur.isDefault || input.isDefault)) throw E.bad("The default plan can't be archived — make another plan the default first");
  if (input.isDefault === false && cur.isDefault) throw E.bad("Make another plan the default instead");
  await db.plan.update({
    where: { id: cur.id },
    data: {
      ...(input.slug !== undefined ? { slug: input.slug } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.priceMonthly !== undefined ? { priceMonthly: input.priceMonthly } : {}),
      ...(input.limits !== undefined ? { limits: input.limits as unknown as Prisma.InputJsonObject } : {}),
      ...(input.isInternal !== undefined ? { isInternal: input.isInternal } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(input.archived !== undefined ? { archivedAt: input.archived ? new Date() : null } : {}),
    },
  });
  if (input.isDefault) await setDefaultPlan(cur.id);
  await audit({ action: "plan.update", actor, targetType: "plan", targetId: cur.id, meta: { slug: cur.slug, keys: Object.keys(input) } });
  return json({ plan: planDTO(await db.plan.findUniqueOrThrow({ where: { id: cur.id }, include: { _count: { select: { teams: true } } } })) });
});

/** DELETE /api/v1/platform/plans/:id|slug — only when no team uses it and it isn't the default (archive it otherwise). */
export const DELETE = route<P>(async (_req, { params }) => {
  const actor = await requirePlatformOwner();
  const { id } = await params;
  const cur = await load(id);
  if (cur.isDefault) throw E.bad("The default plan can't be deleted");
  const used = await db.team.count({ where: { planId: cur.id } });
  if (used) throw E.conflict(`${used} team${used === 1 ? " uses" : "s use"} this plan — move them to another plan or archive it`);
  await db.plan.delete({ where: { id: cur.id } });
  await audit({ action: "plan.delete", actor, targetType: "plan", targetId: cur.id, meta: { slug: cur.slug } });
  return json({ ok: true });
});
