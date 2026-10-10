import { z } from "zod";
import { route, json, body, throttle, E } from "@/lib/http";
import { audit } from "@/lib/audit";
import { assertCanCreateBase, stackAction } from "@/lib/base-ui/adapters";
import { requireBaseRole } from "@/lib/base-ui/access";
import { BASE_SERVICES } from "@/lib/base-ui/shared";

const schema = z.object({
  action: z.enum(["pause", "resume", "restart", "upgrade"]),
  service: z.enum(BASE_SERVICES.map((s) => s.id) as [string, ...string[]]).optional(),
  version: z.string().max(100).optional(),
});

/** Allowed source states per action. */
const FROM: Record<string, string[]> = {
  pause: ["ACTIVE", "ERROR"],
  resume: ["PAUSED", "ERROR"],
  restart: ["ACTIVE", "ERROR"],
  upgrade: ["ACTIVE"],
};

/** POST /api/v1/base/projects/:ref/actions { action: pause|resume|restart|upgrade, service? } — ADMIN (restart of one service: MEMBER). */
export const POST = route<{ ref: string }>(async (req, { params }) => {
  const { ref } = await params;
  const input = await body(req, schema);
  const min = input.action === "restart" && input.service ? "MEMBER" : "ADMIN";
  const { base, team, actor } = await requireBaseRole(ref, min);
  await throttle(`base:action:${actor.user.id}`, { limit: 20, window: 60 });
  if (!FROM[input.action]!.includes(base.status)) throw E.conflict(`Can't ${input.action} a project that is ${base.status.toLowerCase()}`);
  // resuming a paused backend makes it active again → counts against the plan's active-project cap
  if (input.action === "resume" && base.status === "PAUSED") await assertCanCreateBase(team.id, actor.user.id);
  await stackAction(ref, input.action, { service: input.service, actorId: actor.user.id, version: input.version });
  await audit({ action: `base.${input.action}`, teamId: team.id, actor, targetType: "base_project", targetId: base.id, meta: { ref, service: input.service ?? null, version: input.version ?? null } });
  return json({ ok: true });
});
