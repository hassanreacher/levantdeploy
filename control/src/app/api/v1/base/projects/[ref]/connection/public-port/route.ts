import { z } from "zod";
import { route, json, body, E } from "@/lib/http";
import { audit } from "@/lib/audit";
import { setPublicPort } from "@/lib/base-ui/adapters";
import { requireBaseRole } from "@/lib/base-ui/access";

/** POST /api/v1/base/projects/:ref/connection/public-port { enabled } — ADMIN, plan-gated. */
export const POST = route<{ ref: string }>(async (req, { params }) => {
  const { ref } = await params;
  const { enabled } = await body(req, z.object({ enabled: z.boolean() }));
  const { base, team, actor } = await requireBaseRole(ref, "ADMIN");
  if (base.status !== "ACTIVE") throw E.conflict("The project must be running");
  const port = await setPublicPort(ref, enabled, actor.user.id); // plan-gated by the runtime (402 PLAN_LIMIT)
  await audit({ action: enabled ? "base.public_port.enable" : "base.public_port.disable", teamId: team.id, actor, targetType: "base_project", targetId: base.id, meta: { ref, port } });
  return json({ ok: true, port });
});
