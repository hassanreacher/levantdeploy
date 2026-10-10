import { z } from "zod";
import { route, body, requireApiTokenOrSession, throttle, E } from "@/lib/http";
import { LIMITS } from "@/lib/rate-limit";
import { loadConversationFor, sendUserMessage } from "@/lib/ai/agent";
import { agentStream, toAiActor } from "@/lib/ai/sse";
import { ToolError } from "@/lib/ai/permissions";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

const schema = z.object({
  content: z.string().trim().min(1).max(20_000),
  /** where the user opened the assistant (adds context, e.g. the failing deployment) */
  page: z.object({ deploymentId: z.string().max(60).nullable().optional(), path: z.string().max(300).nullable().optional() }).optional(),
});

/** POST /api/v1/ai/conversations/:id/messages { content } → text/event-stream of AgentEvent */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const input = await body(req, schema);
  const actor = await requireApiTokenOrSession();
  await throttle(`ai:msg:${actor.user.id}`, LIMITS.ai);
  const aiActor = toAiActor(actor);
  try {
    await loadConversationFor(id, aiActor);
  } catch (e) {
    if (e instanceof ToolError) throw E.notFound("Conversation not found");
    throw e;
  }
  return agentStream(req, (emit, signal) =>
    sendUserMessage({ conversationId: id, actor: aiActor, user: { id: actor.user.id, name: actor.user.name, email: actor.user.email }, text: input.content, page: input.page ?? undefined, emit, signal }),
  );
});
