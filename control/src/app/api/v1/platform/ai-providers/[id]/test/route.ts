import { z } from "zod";
import { route, json, body, requirePlatformOwner, throttle, E } from "@/lib/http";
import { LIMITS } from "@/lib/rate-limit";
import { llm } from "@/lib/llm";
import { providerExists } from "@/lib/llm/admin";

/** POST { model? } → 1-token request: { ok, model, latencyMs, text?, error?, code? } (errors are key-scrubbed). */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const actor = await requirePlatformOwner();
  if (!(await providerExists(id))) throw E.notFound("Unknown provider");
  const input = await body(req, z.object({ model: z.string().trim().min(1).max(200).optional() }).default({}));
  await throttle(`llm-test:${actor.user.id}`, LIMITS.deploy);
  return json(await llm.test(id, input.model));
});
