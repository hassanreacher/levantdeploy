import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlockParam, MessageCreateParamsStreaming, MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages/messages";
import { LlmError, type LlmChatRequest, type LlmContentPart, type LlmFinishReason, type LlmPurpose } from "./types";
import { classifyHttp, type Adapter, type RawToolCall } from "./provider";
import { jsonPrompt, networkError } from "./openai";

/**
 * Anthropic adapter over `@anthropic-ai/sdk` (same key/base-URL conventions as src/lib/ai/config.ts).
 * Current Claude models: adaptive thinking is on by default (we omit `thinking`), sampling params and forced
 * tool_choice are rejected (→ omitted / `auto` + an instruction), effort via `output_config.effort`,
 * JSON via `output_config.format`. SDK retries are off — the router owns retries and failover.
 */
const EFFORT: Record<LlmPurpose, "low" | "medium" | "high"> = { plan: "high", judge: "high", code: "medium", fix: "medium", vision: "medium", chat: "low", fast: "low" };

export function buildAnthropicRequest(req: LlmChatRequest, modelId: string, maxOutput: number): MessageCreateParamsStreaming {
  const system: string[] = [];
  const messages: MessageParam[] = [];
  const push = (role: "user" | "assistant", blocks: ContentBlockParam[]) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) (last.content as ContentBlockParam[]).push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const m of req.messages) {
    if (m.role === "system") system.push(m.content);
    else if (m.role === "user") push("user", typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content.map(toBlock));
    else if (m.role === "assistant") {
      const blocks: ContentBlockParam[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: safeId(c.id), name: c.name, input: c.input ?? {} });
      if (blocks.length) push("assistant", blocks);
    } else if (m.role === "tool") push("user", [{ type: "tool_result", tool_use_id: safeId(m.toolCallId), content: m.content }]);
  }
  const forced = req.toolChoice && typeof req.toolChoice === "object" ? req.toolChoice.name : req.toolChoice === "required" ? "*" : null;
  if (forced) system.push(forced === "*" ? "You must call one of the tools in this turn." : `You must call the tool "${forced}" in this turn.`);
  const useSchema = !!req.jsonSchema && !req.tools?.length;
  if ((req.json || req.jsonSchema) && !useSchema) system.push(jsonPrompt(req)!);

  const params: MessageCreateParamsStreaming = {
    model: modelId,
    max_tokens: Math.min(req.maxTokens ?? 16_000, maxOutput || 64_000),
    messages,
    stream: true,
    output_config: {
      effort: EFFORT[req.purpose] ?? "medium",
      ...(useSchema ? { format: { type: "json_schema", schema: req.jsonSchema!.schema } } : {}),
    },
  };
  if (system.length) params.system = system.join("\n\n");
  if (req.tools?.length && req.toolChoice !== "none") {
    params.tools = req.tools.map((t): Tool => ({ name: t.name, description: t.description, input_schema: { type: "object", ...(t.parameters as object) } as Tool["input_schema"] }));
    params.tool_choice = { type: "auto" };
  }
  return params;
}

function toBlock(p: LlmContentPart): ContentBlockParam {
  if (p.type === "text") return { type: "text", text: p.text };
  const url = p.image_url.url;
  const m = url.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/);
  if (m) return { type: "image", source: { type: "base64", media_type: m[1] as "image/png", data: m[2] } };
  return { type: "image", source: { type: "url", url } };
}

/** Anthropic tool ids must match ^[a-zA-Z0-9_-]+$ (ids from other providers may not). */
const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "call";

export const anthropicAdapter: Adapter = async ({ provider, model, req, signal, onText, onActivity }) => {
  const ctx = { provider: provider.id, model: model.id };
  if (!provider.apiKey) throw new LlmError("AUTH", `${provider.id}: no API key`, ctx);
  const baseURL = /api\.anthropic\.com/.test(provider.baseUrl) ? undefined : provider.baseUrl;
  const client = new Anthropic({ apiKey: provider.apiKey, baseURL, maxRetries: 0, timeout: 10 * 60_000, defaultHeaders: provider.headers });
  const params = buildAnthropicRequest(req, model.id, model.maxOutput);

  let text = "";
  const calls: (RawToolCall & { index: number })[] = [];
  let stop: string | null = null;
  const usage = { inputTokens: 0, outputTokens: 0 };
  try {
    const stream = client.messages.stream(params, { signal });
    for await (const ev of stream) {
      onActivity();
      if (ev.type === "message_start") usage.inputTokens = ev.message.usage.input_tokens ?? 0;
      else if (ev.type === "content_block_start" && ev.content_block.type === "tool_use") calls.push({ index: ev.index, id: ev.content_block.id, name: ev.content_block.name, arguments: "" });
      else if (ev.type === "content_block_delta") {
        if (ev.delta.type === "text_delta") {
          text += ev.delta.text;
          onText(ev.delta.text);
        } else if (ev.delta.type === "input_json_delta") {
          const c = calls.find((x) => x.index === ev.index);
          if (c) c.arguments += ev.delta.partial_json;
        }
      } else if (ev.type === "message_delta") {
        stop = ev.delta.stop_reason ?? stop;
        usage.outputTokens = ev.usage.output_tokens ?? usage.outputTokens;
      }
    }
  } catch (e) {
    if (e instanceof Anthropic.APIError && typeof e.status === "number") {
      throw classifyHttp(e.status, JSON.stringify(e.error ?? { message: e.message }), (e.headers as Headers | undefined) ?? null, ctx);
    }
    throw networkError(e, signal, ctx, text.length > 0 || calls.length > 0);
  }
  if (!stop) throw new LlmError("STREAM_BROKEN", `${provider.id}/${model.id}: stream ended before completion`, ctx);
  if (stop === "refusal") throw new LlmError("INVALID_OUTPUT", `${provider.id}/${model.id}: the model declined the request`, ctx);
  const finish: LlmFinishReason = stop === "tool_use" ? "tool_calls" : stop === "max_tokens" ? "length" : "stop";
  return { text, toolCalls: calls.map(({ index: _i, ...c }) => ({ ...c, arguments: c.arguments || "{}" })), finishReason: finish, usage };
};
