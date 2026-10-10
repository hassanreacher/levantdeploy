import { z } from "zod";
import { route, json, body, requireProjectRole, E } from "@/lib/http";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { currentProduction } from "@/lib/deployments";
import { enqueueAction } from "@/lib/runtime/api";

const schema = z.object({ replicas: z.number().int().min(1).max(50) });

/** POST /api/v1/projects/:id/scale { replicas } → 202 { replicas, jobId | null } (live when production is running) */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const input = await body(req, schema);
  const { team, actor, project } = await requireProjectRole(id, "MEMBER", { scope: "projects:write" });
  const max = (await getSetting("limits.defaults")).maxReplicas;
  if (input.replicas > max) throw E.validation({ replicas: `Maximum is ${max} replicas` });
  if (project.kind === "COMPOSE" && input.replicas !== 1) throw E.conflict("Compose projects run one copy of each service");
  await db.project.update({ where: { id: project.id }, data: { replicas: input.replicas } });
  const cur = await currentProduction(project.id);
  const jobId = cur && cur.status === "READY" && !cur.stoppedAt ? await enqueueAction(cur.id, "scale", { replicas: input.replicas, byUserId: actor.user.id }) : null;
  await audit({ action: "project.scale", teamId: team.id, actor, targetType: "project", targetId: project.id, meta: { from: project.replicas, to: input.replicas } });
  return json({ replicas: input.replicas, jobId, applied: !!jobId }, 202);
});
