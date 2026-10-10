import { db } from "@/lib/db";
import { listPlans, LIMIT_FIELDS, parseLimits } from "@/lib/plans";
import { planDTO, teamsOverview } from "@/lib/plans/admin";
import { PlansAdmin } from "./plans-client";

export const metadata = { title: "Plans · Platform Settings" };
export const dynamic = "force-dynamic";

/** Owner admin (plans area): plan CRUD with a schema-driven limits form, plan assignment, teams over quota, upgrade requests. */
export default async function PlatformPlansPage() {
  const [plans, teams, requests] = await Promise.all([
    listPlans({ includeArchived: true }),
    teamsOverview(),
    db.planUpgradeRequest.findMany({
      where: { status: "OPEN" },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { team: { select: { slug: true, name: true } }, plan: { select: { id: true, name: true } }, requestedBy: { select: { name: true, email: true } } },
    }),
  ]);
  return (
    <PlansAdmin
      plans={plans.map((p) => ({ ...planDTO(p), limits: parseLimits(p.limits) }))}
      fields={LIMIT_FIELDS}
      teams={JSON.parse(JSON.stringify(teams))}
      requests={requests.map((r) => ({
        id: r.id,
        team: r.team,
        plan: r.plan,
        message: r.message,
        by: r.requestedBy?.name ?? r.requestedBy?.email ?? null,
        createdAt: r.createdAt.toISOString(),
      }))}
    />
  );
}
