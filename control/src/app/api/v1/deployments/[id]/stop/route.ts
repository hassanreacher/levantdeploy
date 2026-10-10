import { z } from "zod";
import { route, json, body, requireProjectRole, E } from "@/lib/http";
import { audit } from "@/lib/audit";
import { findDeployment, enqueueAction } from "@/lib/runtime/api";

const schema = z.object({ force: z.boolean().default(false) });

/** POST /api/v1/deployments/:id/stop { force? } → 202 { jobId }. Stopping current production needs force:true. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const input = await body(req, schema);
  const d = await findDeployment(id);
  const { team, actor } = await requireProjectRole(d.projectId, "MEMBER", { scope: "deployments:write" });
  if (!["READY", "SUPERSEDED"].includes(d.status)) throw E.conflict(`Can't stop a ${d.status.toLowerCase()} deployment`);
  if (d.stoppedAt) throw E.conflict("This deployment is already stopped");
  if (d.isCurrentProduction && !input.force) throw E.conflict("This is the current production deployment — stopping it takes the site offline. Send { force: true } to confirm.");
  const jobId = await enqueueAction(d.id, "stop", { byUserId: actor.user.id });
  await audit({ action: "deployment.stop", teamId: team.id, actor, targetType: "deployment", targetId: d.id, meta: { number: d.number, production: d.isCurrentProduction } });
  return json({ deployment: { id: d.id, number: d.number }, jobId }, 202);
});
