import { z } from "zod";
import { route, json, body, requireApiTokenOrSession, E } from "@/lib/http";
import { db } from "@/lib/db";
import { loadConversationFor, conversationState } from "@/lib/ai/agent";
import { toAiActor } from "@/lib/ai/sse";
import { toUiAction, toUiMessage } from "@/lib/ai/store";
import { ToolError } from "@/lib/ai/permissions";
import type { UiConversation } from "@/lib/ai/types";

async function load(id: string) {
  const actor = await requireApiTokenOrSession();
  try {
    return { actor, conv: await loadConversationFor(id, toAiActor(actor)) };
  } catch (e) {
    if (e instanceof ToolError) throw E.notFound("Conversation not found");
    throw e;
  }
}

/** GET → { conversation, messages, actions, state } */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  const { conv } = await load(id);
  const [messages, actions, team, project, state] = await Promise.all([
    db.agentMessage.findMany({ where: { conversationId: conv.id }, orderBy: { createdAt: "asc" } }),
    db.agentAction.findMany({ where: { conversationId: conv.id }, orderBy: { createdAt: "asc" } }),
    db.team.findUnique({ where: { id: conv.teamId }, select: { slug: true } }),
    conv.projectId ? db.project.findUnique({ where: { id: conv.projectId }, select: { slug: true } }) : null,
    conversationState(conv.id),
  ]);
  const conversation: UiConversation = { id: conv.id, title: conv.title, projectId: conv.projectId, projectSlug: project?.slug ?? null, teamSlug: team?.slug ?? "", model: conv.model, updatedAt: conv.updatedAt.toISOString() };
  return json({ conversation, messages: messages.map(toUiMessage), actions: actions.map(toUiAction), state });
});

export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const { conv } = await load(id);
  const input = await body(req, z.object({ title: z.string().trim().min(1).max(120) }));
  await db.agentConversation.update({ where: { id: conv.id }, data: { title: input.title } });
  return json({ ok: true });
});

export const DELETE = route<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  const { conv } = await load(id);
  await db.agentConversation.delete({ where: { id: conv.id } });
  return json({ ok: true });
});
