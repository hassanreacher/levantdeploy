import { z } from "zod";
import { route, json, body, throttle, E } from "@/lib/http";
import { db } from "@/lib/db";
import { invokeFunction } from "@/lib/base-ui/adapters";
import { requireBaseRole } from "@/lib/base-ui/access";
import { audit } from "@/lib/audit";

const schema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
  body: z.string().max(256 * 1024).optional(),
  headers: z.record(z.string().max(200), z.string().max(4000)).optional(),
  /** which key to send as Authorization (the service key never leaves the server) */
  auth: z.enum(["anon", "service_role", "none"]).default("anon"),
});

/**
 * POST /api/v1/base/projects/:ref/functions/:slug/invoke { method, body?, headers?, auth: anon|service_role|none }
 * MEMBER (anon / none); `service_role` needs ADMIN and is audited. Dashboard tester + CLI `levant base functions invoke`.
 */
export const POST = route<{ ref: string; slug: string }>(async (req, { params }) => {
  const { ref, slug } = await params;
  const input = await body(req, schema);
  const { base, team, actor } = await requireBaseRole(ref, input.auth === "service_role" ? "ADMIN" : "MEMBER");
  await throttle(`base:invoke:${actor.user.id}`, { limit: 60, window: 60 });
  if (!(await db.baseFunction.findUnique({ where: { baseProjectId_slug: { baseProjectId: base.id, slug } }, select: { id: true } }))) throw E.notFound("Function not found");
  if (input.auth === "service_role")
    await audit({ action: "base.function.invoke_service_role", teamId: team.id, actor, targetType: "base_project", targetId: base.id, meta: { ref, slug, method: input.method } });
  try {
    return json(await invokeFunction(ref, slug, { method: input.method, body: input.body, headers: input.headers, auth: input.auth }));
  } catch (e) {
    throw E.bad((e as Error).message.slice(0, 500));
  }
});
