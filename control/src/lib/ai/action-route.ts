import { z } from "zod";
import { body, requireApiTokenOrSession, throttle, E } from "@/lib/http";
import { LIMITS } from "@/lib/rate-limit";
import { checkResolvable, ConfirmationError, resolveAction } from "./agent";
import { ToolError } from "./permissions";
import { agentStream, toAiActor } from "./sse";

const schema = z.object({ confirmText: z.string().max(200).optional(), reason: z.string().max(500).optional() });

/** Shared handler for POST /api/v1/ai/actions/:id/{approve,reject} → text/event-stream (the agent continues). */
export async function handleDecision(req: Request, id: string, decision: "approve" | "reject"): Promise<Response> {
  const input = await body(req, schema);
  const actor = await requireApiTokenOrSession();
  await throttle(`ai:msg:${actor.user.id}`, LIMITS.ai);
  const aiActor = toAiActor(actor);
  try {
    await checkResolvable(id, aiActor, decision, input.confirmText);
  } catch (e) {
    if (e instanceof ConfirmationError) throw E.validation({ confirmText: e.message }, e.message);
    if (e instanceof ToolError) throw e.code === "CONFLICT" ? E.conflict(e.message) : E.notFound(e.message);
    throw e;
  }
  return agentStream(req, (emit, signal) => resolveAction({ actionId: id, actor: aiActor, decision, confirmText: input.confirmText, reason: input.reason, emit, signal }));
}
