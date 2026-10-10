import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";
import type { AgentAction, AgentConversation, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { audit } from "@/lib/audit";
import { AiNotConfiguredError, FALLBACK_BETA, getAnthropic, supportsServerFallback, type AiConfig } from "./config";
import { ToolError, teamRole, type AiActor } from "./permissions";
import { buildTurnContext, SYSTEM_PROMPT, type PageContext } from "./prompt";
import { appendMessage, loadHistory, stored, toUiAction, toUiMessage, type ActionOutput, type StoredContent } from "./store";
import { apiTools, errorText, gateTool, needsApproval, prepareToolCall, resultText, type ToolCtx } from "./tools";
import type { AgentEvent, RunState } from "./types";

/**
 * LevantDeploy Agent loop (manual streaming loop — approvals pause the loop across HTTP requests, and the
 * conversation lives in Postgres, so a single in-process tool runner can't hold it).
 *
 * One request = `tools` (sorted, stable) + `system` (frozen, cache breakpoint) + history (+ top-level automatic
 * cache_control for the growing tail). Per turn:
 *   stream → finalMessage → persist → stop_reason checks (refusal / max_tokens / pause_turn) →
 *   validate each tool_use input (eager input streaming) → read-only tools run (in parallel),
 *   mutating tools become AgentAction PENDING_APPROVAL → if any pending: pause; else all tool_results
 *   go back in ONE user message and the loop continues.
 */
export type Emit = (ev: AgentEvent) => void;

const MAX_STEPS = 16;
const MAX_TOKENS = 32_000;
const MAX_TOKENS_RETRY = 64_000;
const LOCK_TTL_MS = 10 * 60_000;

export class AgentBusyError extends Error {
  constructor() {
    super("The agent is already working on this conversation. Wait for it to finish.");
  }
}

// ───────────────────────────── request building ─────────────────────────────

export function buildRequest(config: Pick<AiConfig, "model" | "effort">, messages: Anthropic.Beta.BetaMessageParam[], maxTokens = MAX_TOKENS): BetaMessageStreamParams {
  const fallback = supportsServerFallback(config.model);
  return {
    model: config.model,
    max_tokens: maxTokens,
    // stable prefix: tools (sorted, byte-stable) + frozen system prompt with an explicit breakpoint …
    tools: apiTools(),
    tool_choice: { type: "auto" },
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    // … plus automatic caching of the growing conversation tail
    cache_control: { type: "ephemeral" },
    messages,
    // adaptive thinking (the only mode on Opus 5.5); summarized so progress notes between tool calls are visible
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: config.effort },
    // server-side refusal fallback (not offered for Haiku 5.5)
    ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
  };
}

// ───────────────────────────── locking ─────────────────────────────

async function withLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
  const key = `ld:ai:lock:${conversationId}`;
  const token = `${process.pid}-${Date.now()}-${Math.random()}`;
  const ok = await redis().set(key, token, "PX", LOCK_TTL_MS, "NX");
  if (ok !== "OK") throw new AgentBusyError();
  try {
    return await fn();
  } finally {
    const cur = await redis().get(key).catch(() => null);
    if (cur === token) await redis().del(key).catch(() => {});
  }
}

// ───────────────────────────── helpers ─────────────────────────────

function ctxFor(conv: AgentConversation, actor: AiActor): ToolCtx {
  return { actor, teamId: conv.teamId, projectId: conv.projectId, conversationId: conv.id };
}

async function setAction(id: string, data: Prisma.AgentActionUpdateInput, emit: Emit) {
  const a = await db.agentAction.update({ where: { id }, data });
  emit({ type: "action", action: toUiAction(a) });
  return a;
}

async function pendingActions(conversationId: string) {
  return db.agentAction.findMany({ where: { conversationId, status: { in: ["PENDING_APPROVAL", "APPROVED", "RUNNING"] } }, orderBy: { createdAt: "asc" } });
}

/** Map typed SDK errors (most specific first) to an error event; never includes the API key. */
export function describeError(e: unknown): { code: string; message: string } {
  if (e instanceof AiNotConfiguredError) return { code: "AI_NOT_CONFIGURED", message: e.message };
  if (e instanceof AgentBusyError) return { code: "BUSY", message: e.message };
  if (e instanceof Anthropic.APIUserAbortError) return { code: "ABORTED", message: "Stopped." };
  if (e instanceof Anthropic.AuthenticationError) return { code: "AI_AUTH", message: "The Anthropic API key was rejected. Check Settings → AI." };
  if (e instanceof Anthropic.PermissionDeniedError) return { code: "AI_FORBIDDEN", message: "This API key is not allowed to use the selected model." };
  if (e instanceof Anthropic.NotFoundError) return { code: "AI_MODEL", message: "The selected model is not available for this API key." };
  if (e instanceof Anthropic.RateLimitError) return { code: "AI_RATE_LIMITED", message: "The AI provider is rate limiting requests. Try again in a minute." };
  if (e instanceof Anthropic.BadRequestError) return { code: "AI_BAD_REQUEST", message: `The AI request was rejected: ${e.message.slice(0, 300)}` };
  if (e instanceof Anthropic.InternalServerError) return { code: "AI_UNAVAILABLE", message: "The AI provider is temporarily unavailable. Try again shortly." };
  if (e instanceof Anthropic.APIConnectionError) return { code: "AI_UNAVAILABLE", message: "Could not reach the AI provider." };
  if (e instanceof Anthropic.APIError) return { code: "AI_ERROR", message: `AI provider error (${e.status ?? "?"})` };
  if (e instanceof ToolError) return { code: e.code, message: e.message };
  console.error("[ai] agent error", (e as Error)?.name, (e as Error)?.message);
  return { code: "SERVER_ERROR", message: "Something went wrong while running the agent." };
}

// ───────────────────────────── one model step ─────────────────────────────

class TruncatedToolInput extends Error {}

/** Stream one assistant message, forwarding deltas. Retries unparseable eager tool input (≤2) and max_tokens-truncated tool input (once). */
async function streamStep(client: Anthropic, config: AiConfig, messages: Anthropic.Beta.BetaMessageParam[], emit: Emit, signal?: AbortSignal): Promise<Anthropic.Beta.BetaMessage> {
  let jsonRetries = 0;
  let maxTokens = MAX_TOKENS;
  for (;;) {
    let message: Anthropic.Beta.BetaMessage;
    try {
      const stream = client.beta.messages.stream(buildRequest(config, messages, maxTokens), { signal });
      for await (const ev of stream) {
        switch (ev.type) {
          case "message_start":
            emit({ type: "message_start", model: ev.message.model });
            break;
          case "content_block_start":
            if (ev.content_block.type === "tool_use") emit({ type: "tool_use_start", index: ev.index, id: ev.content_block.id, name: ev.content_block.name });
            else if (ev.content_block.type === "fallback") emit({ type: "fallback", from: ev.content_block.from.model, to: ev.content_block.to.model });
            break;
          case "content_block_delta":
            if (ev.delta.type === "text_delta") emit({ type: "text_delta", index: ev.index, text: ev.delta.text });
            else if (ev.delta.type === "thinking_delta") emit({ type: "thinking_delta", index: ev.index, text: ev.delta.thinking });
            break;
        }
      }
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      // API errors (incl. abort) are handled by the caller; only an unparseable eager tool input is retried.
      if (err instanceof Anthropic.APIError || signal?.aborted || jsonRetries++ >= 2) throw err;
      emit({ type: "error", code: "RETRYING", message: "A tool call came back malformed; retrying that step." });
      continue;
    }
    // A tool input cut off at max_tokens can still parse as a valid partial object: never run it.
    if (message.stop_reason === "max_tokens" && message.content.some((b) => b.type === "tool_use")) {
      if (maxTokens < MAX_TOKENS_RETRY) {
        maxTokens = MAX_TOKENS_RETRY;
        emit({ type: "error", code: "RETRYING", message: "Output limit reached mid tool call; retrying with a higher limit." });
        continue;
      }
      throw new TruncatedToolInput("The model's tool call was cut off at the output limit.");
    }
    return message;
  }
}

// ───────────────────────────── tool handling ─────────────────────────────

/** Create AgentActions for every tool_use of an assistant message; run read-only ones now. Returns pending ids. */
async function handleToolUses(conv: AgentConversation, actor: AiActor, messageId: string, toolUses: Anthropic.Beta.BetaToolUseBlock[], emit: Emit): Promise<string[]> {
  const ctx = ctxFor(conv, actor);
  const pending: string[] = [];
  const reads: Promise<void>[] = [];
  for (const block of toolUses) {
    const prepared = prepareToolCall(block.name, block.input);
    if (!prepared.ok) {
      const a = await db.agentAction.create({
        data: { conversationId: conv.id, messageId, toolUseId: block.id, tool: block.name, input: {}, status: "FAILED", error: prepared.error.slice(0, 2000), output: { summary: block.name, result: prepared.error } satisfies ActionOutput, finishedAt: new Date() },
      });
      emit({ type: "action", action: toUiAction(a) });
      continue;
    }
    const { tool, input } = prepared;
    const summary = tool.summarize(input as never);
    const display = (tool.display ? tool.display(input as never) : input) as Prisma.InputJsonObject;
    const mutating = needsApproval(tool, input);
    const a = await db.agentAction.create({
      data: { conversationId: conv.id, messageId, toolUseId: block.id, tool: tool.name, input: display, status: mutating ? "PENDING_APPROVAL" : "RUNNING", requiresApproval: mutating, output: { summary } satisfies ActionOutput },
    });
    emit({ type: "action", action: toUiAction(a) });
    if (mutating) {
      try {
        await gateTool(tool, input, ctx);
        await tool.precheck?.(input as never, ctx);
        const confirmText = (await tool.confirmText?.(input as never, ctx)) ?? null;
        await setAction(a.id, { output: { summary, confirmText } satisfies ActionOutput }, emit);
        pending.push(a.id);
      } catch (e) {
        const msg = errorText(e);
        await setAction(a.id, { status: "FAILED", error: msg, output: { summary, result: `Not proposed — ${msg}` } satisfies ActionOutput, finishedAt: new Date() }, emit);
      }
      continue;
    }
    reads.push(
      (async () => {
        try {
          await gateTool(tool, input, ctx);
          const out = await tool.run(input as never, ctx);
          await setAction(a.id, { status: "SUCCEEDED", output: { summary, result: resultText(out) } satisfies ActionOutput, finishedAt: new Date() }, emit);
        } catch (e) {
          const msg = errorText(e);
          await setAction(a.id, { status: "FAILED", error: msg, output: { summary, result: msg } satisfies ActionOutput, finishedAt: new Date() }, emit);
        }
      })(),
    );
  }
  await Promise.all(reads);
  return pending;
}

/** All tool_use blocks of `messageId` resolved → ONE user message with every tool_result, in block order. */
async function appendToolResults(conv: AgentConversation, messageId: string, emit: Emit) {
  const msg = await db.agentMessage.findUniqueOrThrow({ where: { id: messageId } });
  const uses = stored(msg).blocks.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
  const actions = await db.agentAction.findMany({ where: { messageId } });
  const byId = new Map(actions.map((a) => [a.toolUseId, a]));
  const blocks: Anthropic.Beta.BetaToolResultBlockParam[] = uses.map((u) => {
    const a = byId.get(u.id);
    const o = (a?.output as ActionOutput | null) ?? {};
    if (!a) return { type: "tool_result", tool_use_id: u.id, is_error: true, content: "FAILED: tool call was not processed" };
    if (a.status === "SUCCEEDED") return { type: "tool_result", tool_use_id: u.id, content: (a.requiresApproval ? "Approved by the user and executed.\n" : "") + (o.result ?? "ok") };
    if (a.status === "REJECTED") return { type: "tool_result", tool_use_id: u.id, is_error: true, content: `REJECTED: the user rejected this action${a.error ? ` (${a.error})` : ""}. Do not retry it unless asked.` };
    return { type: "tool_result", tool_use_id: u.id, is_error: true, content: o.result ?? a.error ?? "FAILED" };
  });
  const m = await appendMessage(conv.id, "TOOL", { blocks });
  emit({ type: "message", message: toUiMessage(m) });
}

// ───────────────────────────── the loop ─────────────────────────────

async function runLoop(conv: AgentConversation, actor: AiActor, emit: Emit, signal?: AbortSignal): Promise<RunState> {
  const { client, config } = await getAnthropic();
  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal?.aborted) return "idle";
    const messages = await loadHistory(conv.id);
    const message = await streamStep(client, config, messages, emit, signal);
    const u = message.usage;
    // plain JSON copy (tool inputs are lazy getters in the SDK snapshot)
    const blocks = JSON.parse(JSON.stringify(message.content)) as StoredContent["blocks"];
    const content: StoredContent = { blocks, model: message.model, stop_reason: message.stop_reason, stop_details: message.stop_details ?? null, usage: u };
    const saved = await appendMessage(conv.id, "ASSISTANT", content, {
      tokensIn: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      tokensOut: u.output_tokens ?? 0,
    });
    emit({ type: "message", message: toUiMessage(saved) });

    if (message.stop_reason === "refusal") {
      // The whole fallback chain declined: never run this turn's tools (a refusal can cut a tool_use off mid-input).
      emit({ type: "refusal", category: message.stop_details?.category ?? null, explanation: message.stop_details?.explanation ?? null });
      return "idle";
    }
    if (message.stop_reason === "pause_turn") continue;
    const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (!toolUses.length) return "idle";
    const pending = await handleToolUses(conv, actor, saved.id, toolUses, emit);
    if (pending.length) {
      emit({ type: "awaiting_approval", actionIds: pending });
      return "awaiting_approval";
    }
    await appendToolResults(conv, saved.id, emit);
  }
  emit({ type: "error", code: "STEP_LIMIT", message: `Stopped after ${MAX_STEPS} steps. Ask me to continue if needed.` });
  return "idle";
}

async function finish(emit: Emit, fn: () => Promise<RunState>) {
  let state: RunState = "idle";
  try {
    state = await fn();
  } catch (e) {
    const d = e instanceof TruncatedToolInput ? { code: "TRUNCATED", message: e.message } : describeError(e);
    if (d.code !== "ABORTED") emit({ type: "error", ...d });
  }
  emit({ type: "done", state });
  return state;
}

/** Reject still-pending proposals (the user moved on) so the history stays valid. */
async function supersedePending(conv: AgentConversation, actor: AiActor, emit: Emit) {
  const pend = await pendingActions(conv.id);
  if (!pend.length) return;
  const messageIds = new Set<string>();
  for (const a of pend) {
    await setAction(a.id, { status: "REJECTED", error: "superseded by a new message", finishedAt: new Date() }, emit);
    if (a.messageId) messageIds.add(a.messageId);
  }
  void actor;
  for (const id of messageIds) await appendToolResults(conv, id, emit);
}

export async function loadConversationFor(conversationId: string, actor: AiActor): Promise<AgentConversation> {
  const conv = await db.agentConversation.findUnique({ where: { id: conversationId } });
  if (!conv || conv.userId !== actor.userId) throw new ToolError("NOT_FOUND", "Conversation not found");
  if (actor.token?.teamId && actor.token.teamId !== conv.teamId) throw new ToolError("NOT_FOUND", "Conversation not found");
  const role = await teamRole(conv.teamId, actor.userId);
  if (!role) throw new ToolError("NOT_FOUND", "Conversation not found");
  return conv;
}

/** POST /messages: append the user's turn (with fresh context) and run the loop. */
export async function sendUserMessage(opts: { conversationId: string; actor: AiActor; user: { id: string; name: string; email: string }; text: string; page?: PageContext; emit: Emit; signal?: AbortSignal }): Promise<RunState> {
  const { emit } = opts;
  return finish(emit, () =>
    withLock(opts.conversationId, async () => {
      const conv = await loadConversationFor(opts.conversationId, opts.actor);
      emit({ type: "run_start", conversationId: conv.id });
      await getAnthropic(); // fail fast (disabled / no key) before writing anything
      const role = (await teamRole(conv.teamId, opts.actor.userId))!;
      await supersedePending(conv, opts.actor, emit);
      const ctxText = await buildTurnContext(conv, opts.user, role, opts.page);
      const m = await appendMessage(conv.id, "USER", { blocks: [{ type: "text", text: ctxText }, { type: "text", text: opts.text }] });
      emit({ type: "message", message: toUiMessage(m) });
      if (conv.title === "New conversation") {
        const title = opts.text.replace(/\s+/g, " ").trim().slice(0, 60) || "New conversation";
        await db.agentConversation.update({ where: { id: conv.id }, data: { title } });
        emit({ type: "title", title });
      }
      return runLoop(conv, opts.actor, emit, opts.signal);
    }),
  );
}

/** Execute an approved action with the approver's permissions (re-checked now). */
async function executeAction(conv: AgentConversation, action: AgentAction, actor: AiActor, emit: Emit) {
  const msg = action.messageId ? await db.agentMessage.findUnique({ where: { id: action.messageId } }) : null;
  const block = msg ? stored(msg).blocks.find((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use" && b.id === action.toolUseId) : null;
  const summary = ((action.output as ActionOutput | null) ?? {}).summary ?? action.tool;
  if (!block) {
    await setAction(action.id, { status: "FAILED", error: "tool call not found", finishedAt: new Date() }, emit);
    return;
  }
  const prepared = prepareToolCall(block.name, block.input);
  if (!prepared.ok) {
    await setAction(action.id, { status: "FAILED", error: prepared.error, output: { summary, result: prepared.error } satisfies ActionOutput, finishedAt: new Date() }, emit);
    return;
  }
  const ctx = ctxFor(conv, actor);
  await setAction(action.id, { status: "RUNNING" }, emit);
  try {
    await gateTool(prepared.tool, prepared.input, ctx);
    const out = await prepared.tool.run(prepared.input as never, ctx);
    await setAction(action.id, { status: "SUCCEEDED", output: { summary, result: resultText(out) } satisfies ActionOutput, finishedAt: new Date() }, emit);
    await audit({ action: "ai.action.execute", teamId: conv.teamId, userId: actor.userId, targetType: "agent_action", targetId: action.id, meta: { tool: action.tool, summary, conversationId: conv.id, status: "SUCCEEDED" } });
  } catch (e) {
    const msgText = errorText(e);
    await setAction(action.id, { status: "FAILED", error: msgText, output: { summary, result: msgText } satisfies ActionOutput, finishedAt: new Date() }, emit);
    await audit({ action: "ai.action.execute", teamId: conv.teamId, userId: actor.userId, targetType: "agent_action", targetId: action.id, meta: { tool: action.tool, summary, conversationId: conv.id, status: "FAILED", error: msgText.slice(0, 300) } });
  }
}

export class ConfirmationError extends Error {}

/** Validation done before streaming (→ plain HTTP errors): ownership, still pending, confirmation text. */
export async function checkResolvable(actionId: string, actor: AiActor, decision: "approve" | "reject", confirmText?: string) {
  const action = await db.agentAction.findUnique({ where: { id: actionId } });
  if (!action) throw new ToolError("NOT_FOUND", "Action not found");
  const conv = await loadConversationFor(action.conversationId, actor);
  if (action.status !== "PENDING_APPROVAL") throw new ToolError("CONFLICT", `This action is already ${action.status.toLowerCase().replace("_", " ")}`);
  const needed = ((action.output as ActionOutput | null) ?? {}).confirmText ?? null;
  if (decision === "approve" && needed && (confirmText ?? "").trim() !== needed) throw new ConfirmationError(`Type "${needed}" to confirm this action`);
  return { action, conv };
}

/** POST /actions/:id/approve|reject → resolve one proposal; when the whole turn is resolved, continue the loop. */
export async function resolveAction(opts: { actionId: string; actor: AiActor; decision: "approve" | "reject"; confirmText?: string; reason?: string; emit: Emit; signal?: AbortSignal }): Promise<RunState> {
  const { action: action0, conv } = await checkResolvable(opts.actionId, opts.actor, opts.decision, opts.confirmText);
  const { emit } = opts;
  return finish(emit, () =>
    withLock(conv.id, async () => {
      emit({ type: "run_start", conversationId: conv.id });
      // compare-and-set so a double click can't execute twice
      const claimed = await db.agentAction.updateMany({
        where: { id: action0.id, status: "PENDING_APPROVAL" },
        data: opts.decision === "approve" ? { status: "APPROVED", approvedById: opts.actor.userId, approvedAt: new Date() } : { status: "REJECTED", error: opts.reason?.slice(0, 500) || null, finishedAt: new Date() },
      });
      if (!claimed.count) throw new ToolError("CONFLICT", "This action was already handled");
      const action = await db.agentAction.findUniqueOrThrow({ where: { id: action0.id } });
      emit({ type: "action", action: toUiAction(action) });
      if (opts.decision === "approve") await executeAction(conv, action, opts.actor, emit);
      else await audit({ action: "ai.action.reject", teamId: conv.teamId, userId: opts.actor.userId, targetType: "agent_action", targetId: action.id, meta: { tool: action.tool, conversationId: conv.id } });
      const still = await db.agentAction.count({ where: { messageId: action.messageId, status: { in: ["PENDING_APPROVAL", "APPROVED", "RUNNING"] } } });
      if (still > 0) {
        const ids = (await db.agentAction.findMany({ where: { messageId: action.messageId, status: "PENDING_APPROVAL" }, select: { id: true } })).map((x) => x.id);
        emit({ type: "awaiting_approval", actionIds: ids });
        return "awaiting_approval";
      }
      await appendToolResults(conv, action.messageId!, emit);
      return runLoop(conv, opts.actor, emit, opts.signal);
    }),
  );
}

export async function conversationState(conversationId: string): Promise<RunState> {
  const busy = await redis().exists(`ld:ai:lock:${conversationId}`);
  if (busy) return "running";
  const n = await db.agentAction.count({ where: { conversationId, status: "PENDING_APPROVAL" } });
  return n ? "awaiting_approval" : "idle";
}
