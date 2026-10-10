import type Anthropic from "@anthropic-ai/sdk";
import type { AgentAction, AgentMessage, AgentMessageRole, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { CONTEXT_TAG, type UiAction, type UiBlock, type UiMessage } from "./types";

/**
 * AgentMessage.content layout (JSON):
 *   { blocks: BetaContentBlockParam[] | BetaContentBlock[],   // exactly what was sent / received
 *     model?, stop_reason?, stop_details?, usage? }            // assistant metadata
 * role USER = user turn (context block + text), TOOL = user message carrying tool_result blocks,
 * ASSISTANT = model output, stored unmodified so the history replays byte-identically
 * (prompt cache + preserved thinking).
 */
export type StoredContent = {
  blocks: Array<Anthropic.Beta.BetaContentBlockParam | Anthropic.Beta.BetaContentBlock>;
  model?: string;
  stop_reason?: string | null;
  stop_details?: unknown;
  usage?: unknown;
};

export const stored = (m: Pick<AgentMessage, "content">): StoredContent => {
  const c = m.content as unknown;
  if (c && typeof c === "object" && Array.isArray((c as StoredContent).blocks)) return c as StoredContent;
  if (Array.isArray(c)) return { blocks: c as StoredContent["blocks"] };
  if (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string") return { blocks: [{ type: "text", text: (c as { text: string }).text }] };
  return { blocks: [] };
};

/** Append a message with a strictly increasing createdAt (history order = createdAt). */
export async function appendMessage(conversationId: string, role: AgentMessageRole, content: StoredContent, usage?: { tokensIn?: number; tokensOut?: number }): Promise<AgentMessage> {
  const last = await db.agentMessage.findFirst({ where: { conversationId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  const now = Date.now();
  const createdAt = new Date(Math.max(now, (last?.createdAt.getTime() ?? 0) + 1));
  const msg = await db.agentMessage.create({
    data: { conversationId, role, content: content as unknown as Prisma.InputJsonObject, createdAt, tokensIn: usage?.tokensIn ?? null, tokensOut: usage?.tokensOut ?? null },
  });
  await db.agentConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
  return msg;
}

/**
 * Echo rules after a server-side refusal fallback: before the LAST `fallback` block drop thinking,
 * redacted_thinking and tool_use blocks (and unpaired server_tool_use); the fallback marker itself is dropped.
 */
export function sanitizeForReplay(blocks: StoredContent["blocks"]): Anthropic.Beta.BetaContentBlockParam[] {
  const lastFallback = blocks.map((b) => b.type).lastIndexOf("fallback");
  const out: unknown[] = [];
  blocks.forEach((b, i) => {
    if (b.type === "fallback") return;
    if (i < lastFallback && ["thinking", "redacted_thinking", "tool_use", "server_tool_use"].includes(b.type)) return;
    out.push(b);
  });
  return out as Anthropic.Beta.BetaContentBlockParam[];
}

/** API `messages` rebuilt from the stored history. Refused assistant turns are discarded (partial output). */
export async function loadHistory(conversationId: string): Promise<Anthropic.Beta.BetaMessageParam[]> {
  const rows = await db.agentMessage.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" } });
  const out: Anthropic.Beta.BetaMessageParam[] = [];
  for (const r of rows) {
    const c = stored(r);
    if (r.role === "SYSTEM") continue;
    if (r.role === "ASSISTANT") {
      if (c.stop_reason === "refusal") continue;
      const blocks = sanitizeForReplay(c.blocks);
      if (blocks.length) out.push({ role: "assistant", content: blocks });
      continue;
    }
    out.push({ role: "user", content: c.blocks as Anthropic.Beta.BetaContentBlockParam[] });
  }
  return out;
}

// ───────────────────────────── UI mapping ─────────────────────────────

const isContext = (t: string) => t.trimStart().startsWith(`<${CONTEXT_TAG}>`);

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "")).join("\n");
  return "";
}

export function toUiMessage(m: AgentMessage): UiMessage {
  const c = stored(m);
  const blocks: UiBlock[] = [];
  for (const b of c.blocks as Array<Record<string, unknown> & { type: string }>) {
    switch (b.type) {
      case "text":
        if (m.role === "USER" && isContext(String(b.text))) break;
        blocks.push({ type: "text", text: String(b.text ?? "") });
        break;
      case "thinking":
        if (b.thinking) blocks.push({ type: "thinking", text: String(b.thinking) });
        break;
      case "tool_use":
        blocks.push({ type: "tool_use", id: String(b.id), name: String(b.name), input: (b.input as Record<string, unknown>) ?? {} });
        break;
      case "tool_result":
        blocks.push({ type: "tool_result", toolUseId: String(b.tool_use_id), isError: !!b.is_error, text: toolResultText(b.content).slice(0, 4000) });
        break;
      case "fallback": {
        const from = (b.from as { model?: string })?.model ?? "model";
        const to = (b.to as { model?: string })?.model ?? "fallback model";
        blocks.push({ type: "fallback", from, to });
        break;
      }
    }
  }
  if (m.role === "ASSISTANT" && c.stop_reason === "refusal") {
    const d = c.stop_details as { category?: string | null; explanation?: string | null } | null;
    blocks.push({ type: "notice", tone: "warning", text: `The model declined this request${d?.category ? ` (${d.category})` : ""}. ${d?.explanation ?? "Try rephrasing it."}` });
  }
  if (m.role === "ASSISTANT" && c.stop_reason === "max_tokens") blocks.push({ type: "notice", tone: "info", text: "The answer was cut off (output limit reached). Ask me to continue." });
  return { id: m.id, role: m.role === "ASSISTANT" ? "assistant" : m.role === "TOOL" ? "tool" : "user", blocks, model: c.model ?? null, stopReason: c.stop_reason ?? null, createdAt: m.createdAt.toISOString() };
}

export type ActionOutput = { summary?: string; confirmText?: string | null; result?: string };

export function toUiAction(a: AgentAction): UiAction {
  const o = (a.output as ActionOutput | null) ?? {};
  return {
    id: a.id,
    toolUseId: a.toolUseId,
    tool: a.tool,
    input: (a.input as Record<string, unknown>) ?? {},
    output: o.result ?? null,
    status: a.status,
    requiresApproval: a.requiresApproval,
    confirmText: o.confirmText ?? null,
    summary: o.summary ?? a.tool,
    error: a.error,
    createdAt: a.createdAt.toISOString(),
    finishedAt: a.finishedAt?.toISOString() ?? null,
  };
}
