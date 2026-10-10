import { route, json, requireTeamRole } from "@/lib/http";
import { db } from "@/lib/db";
import { usageReport, listPlans, parseLimits } from "@/lib/plans";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/teams/:team/plan → { plan, source, limits, usage: UsageReport, plans: [{slug,name,priceMonthly,limits,current}], openRequest }
 * (plans area; any member)
 */
export const GET = route<{ team: string }>(async (_req, { params }) => {
  const { team: t } = await params;
  const { team } = await requireTeamRole(t, "VIEWER");
  const [usage, plans, openRequest] = await Promise.all([
    usageReport(team.id),
    listPlans({ includeInternal: false }),
    db.planUpgradeRequest.findFirst({ where: { teamId: team.id, status: "OPEN" }, orderBy: { createdAt: "desc" }, select: { id: true, createdAt: true, plan: { select: { slug: true, name: true } }, message: true } }),
  ]);
  return json({
    plan: usage.plan,
    source: usage.source,
    limits: usage.limits,
    usage,
    plans: plans.map((p) => ({ slug: p.slug, name: p.name, description: p.description, priceMonthly: p.priceMonthly, limits: parseLimits(p.limits), current: p.slug === usage.plan.slug })),
    openRequest,
  });
});
