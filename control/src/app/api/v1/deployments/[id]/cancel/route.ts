import { route, json, requireProjectRole, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { ACTIVE_STATUSES, cancelDeployment, TransitionError } from "@/lib/deployments";
import { toDTO } from "@/lib/dashboard/deployments";

/** POST /api/v1/deployments/:id/cancel → { deployment }   (409 when already finished) */
export const POST = route<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  const d0 = await db.deployment.findFirst({ where: { OR: [{ id }, { shortId: id }] } });
  if (!d0) throw E.notFound("Deployment not found");
  const { team, actor } = await requireProjectRole(d0.projectId, "MEMBER", { scope: "deployments:write" });
  if (!ACTIVE_STATUSES.includes(d0.status)) throw E.conflict(`Deployment is already ${d0.status.toLowerCase()}`);
  try {
    const d = await cancelDeployment(d0.id, actor.user.id);
    await audit({ action: "deployment.cancel", teamId: team.id, actor, targetType: "deployment", targetId: d.id, meta: { number: d.number } });
    return json({ deployment: toDTO(d) });
  } catch (e) {
    if (e instanceof TransitionError) throw E.conflict(`Deployment is already ${e.from.toLowerCase()}`);
    throw e;
  }
});
