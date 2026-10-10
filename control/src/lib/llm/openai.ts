import { LlmError, type LlmChatRequest, type LlmContentPart, type LlmFinishReason, type LlmMessage, type LlmModelInfo, type LlmUsageCounts } from "./types";
import { classifyHttp, type Adapter, type RawToolCall, type ResolvedProvider } from "./provider";
import { readSse } from "./sse";

/**
 * OpenAI-compatible chat/completions adapter (SSE streaming, tools, JSON mode, vision).
 * Models without native tool calling get the tools described in the system prompt and the router parses
 * `<tool_call>{…}</tool_call>` blocks out of the text (see repair.ts).
 */

/** Gemini 3 requires the thought signature of earlier function calls; calls made by other providers get the documented bypass value. */
const GEMINI_SIG_BYPASS = "skip_thought_signature_validator";

export function toolPrompt(req: LlmChatRequest): string {
  const tools = req.tools ?? [];
  return [
    "You can call tools. To call one, reply with one or more blocks exactly like:",
    '<tool_call>{"name": "tool_name", "arguments": {"arg": "value"}}</tool_call>',
    "Use valid JSON (double quotes, no comments, no trailing commas) and no markdown fences around the blocks. After the tool calls, stop and wait for the results.",
    "Available tools:",
    ...tools.map((t) => `- ${t.name}: ${t.description}\n  arguments JSON schema: ${JSON.stringify(t.parameters)}`),
  ].join("\n");
}

export function jsonPrompt(req: LlmChatRequest): string | null {
  if (req.jsonSchema) return `Reply with a single JSON value only (no prose, no markdown fences) that matches this JSON schema:\n${JSON.stringify(req.jsonSchema.schema)}`;
  if (req.json) return "Reply with a single JSON object only (no prose, no markdown fences).";
  return null;
}

type OaMessage = Record<string, unknown>;

export function buildOpenAiMessages(req: LlmChatRequest, provider: ResolvedProvider, model: LlmModelInfo, nativeTools: boolean): OaMessage[] {
  const out: OaMessage[] = [];
  const extraSystem: string[] = [];
  if (req.tools?.length && !nativeTools && req.toolChoice !== "none") extraSystem.push(toolPrompt(req));
  const jp = jsonPrompt(req);
  if (jp && (provider.jsonMode !== "schema" || !req.jsonSchema)) extraSystem.push(jp);
  if (req.toolChoice && typeof req.toolChoice === "object" && !nativeTools) extraSystem.push(`You must call the tool "${req.toolChoice.name}" now.`);

  let systemDone = false;
  const isGemini = isGeminiProvider(provider);
  for (const m of req.messages) {
    if (m.role === "system") {
      out.push({ role: "system", content: [m.content, ...(systemDone ? [] : extraSystem)].filter(Boolean).join("\n\n") });
      systemDone = true;
    } else if (m.role === "user") {
      out.push({ role: "user", content: typeof m.content === "string" ? m.content : userParts(m.content, model) });
    } else if (m.role === "assistant") {
      if (nativeTools && m.toolCalls?.length) {
        out.push({
          role: "assistant",
          content: m.content ?? "",
          tool_calls: m.toolCalls.map((c) => {
            const tc: Record<string, unknown> = { id: c.id, type: "function", function: { name: c.name, arguments: c.arguments || "{}" } };
            if (c.extra?.provider === provider.id) Object.assign(tc, c.extra.data);
            else if (isGemini) tc.extra_content = { google: { thought_signature: GEMINI_SIG_BYPASS } };
            return tc;
          }),
        });
      } else {
        const calls = (m.toolCalls ?? []).map((c) => `<tool_call>${JSON.stringify({ name: c.name, arguments: c.input ?? c.arguments })}</tool_call>`).join("\n");
        out.push({ role: "assistant", content: [m.content ?? "", calls].filter(Boolean).join("\n") });
      }
    } else if (m.role === "tool") {
      if (nativeTools) out.push({ role: "tool", tool_call_id: m.toolCallId, ...(m.name ? { name: m.name } : {}), content: m.content });
      else out.push({ role: "user", content: `Tool result for ${m.name ?? m.toolCallId}:\n${m.content}` });
    }
  }
  if (!systemDone && extraSystem.length) out.unshift({ role: "system", content: extraSystem.join("\n\n") });
  // merge consecutive user messages produced by text-mode tool results (some providers require alternation)
  return mergeConsecutive(out);
}

function userParts(parts: LlmContentPart[], model: LlmModelInfo): unknown {
  if (model.vision) return parts;
  const text = parts.map((p) => (p.type === "text" ? p.text : "[image omitted: this model cannot see images]")).join("\n");
  return text;
}

function mergeConsecutive(msgs: OaMessage[]): OaMessage[] {
  const out: OaMessage[] = [];
  for (const m of msgs) {
    const prev = out[out.length - 1];
    if (prev && prev.role === "user" && m.role === "user" && typeof prev.content === "string" && typeof m.content === "string") prev.content = `${prev.content}\n\n${m.content}`;
    else out.push({ ...m });
  }
  return out;
}

export function buildOpenAiBody(req: LlmChatRequest, provider: ResolvedProvider, model: LlmModelInfo, stream: boolean): Record<string, unknown> {
  const nativeTools = !!req.tools?.length && model.tools;
  const body: Record<string, unknown> = {
    model: model.id,
    messages: buildOpenAiMessages(req, provider, model, nativeTools),
    stream,
  };
  const maxTokens = Math.min(req.maxTokens ?? 8192, model.maxOutput || 8192);
  body.max_tokens = maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  // Gemini 3 thinks by default; keep quick purposes quick (OpenAI-compat `reasoning_effort`)
  if (isGeminiProvider(provider) && (req.purpose === "fast" || req.purpose === "chat")) body.reasoning_effort = "minimal";
  if (stream && !NO_STREAM_OPTIONS.has(provider.id)) body.stream_options = { include_usage: true };
  if (nativeTools && req.toolChoice !== "none") {
    body.tools = req.tools!.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    if (req.toolChoice) body.tool_choice = typeof req.toolChoice === "string" ? req.toolChoice : { type: "function", function: { name: req.toolChoice.name } };
  }
  if (req.jsonSchema && provider.jsonMode === "schema" && !nativeTools) {
    body.response_format = { type: "json_schema", json_schema: { name: req.jsonSchema.name ?? "result", schema: req.jsonSchema.schema, strict: false } };
  } else if ((req.json || req.jsonSchema) && provider.jsonMode !== "none" && !nativeTools) {
    body.response_format = { type: "json_object" };
  }
  return body;
}

const isGeminiProvider = (p: ResolvedProvider) => p.id === "gemini" || /generativelanguage\.googleapis\.com/.test(p.baseUrl);

/** providers known to reject `stream_options` */
const NO_STREAM_OPTIONS = new Set(["mistral", "cloudflare", "pollinations"]);

export function openAiHeaders(provider: ResolvedProvider): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", ...provider.headers };
  if (provider.apiKey) h.authorization = `Bearer ${provider.apiKey}`;
  return h;
}

export function chatUrl(provider: ResolvedProvider) {
  return `${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

type Acc = { id?: string; name: string; arguments: string; extra?: Record<string, unknown> };

export const openAiAdapter: Adapter = async ({ provider, model, req, signal, stream, onText, onActivity }) => {
  const ctx = { provider: provider.id, model: model.id };
  const body = buildOpenAiBody(req, provider, model, stream);
  let res: Response;
  try {
    res = await fetch(chatUrl(provider), { method: "POST", headers: openAiHeaders(provider), body: JSON.stringify(body), signal });
  } catch (e) {
    throw networkError(e, signal, ctx);
  }
  onActivity();
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw classifyHttp(res.status, text, res.headers, ctx);
  }
  const ctype = res.headers.get("content-type") ?? "";
  if (!stream || !ctype.includes("text/event-stream")) {
    let json: Record<string, unknown>;
    const raw = await res.text().catch((e) => {
      throw networkError(e, signal, ctx);
    });
    try {
      json = JSON.parse(raw);
    } catch {
      // some gateways stream even when asked not to
      if (raw.includes("data:")) return parseSseText(raw, ctx, onText);
      throw new LlmError("INVALID_OUTPUT", `${ctx.provider}/${ctx.model}: response is not JSON`, ctx);
    }
    if (json.error) throw classifyHttp(500, JSON.stringify(json), null, ctx);
    return fromCompletion(json, onText);
  }

  let text = "";
  const calls: Acc[] = [];
  let finish: LlmFinishReason | null = null;
  let usage: LlmUsageCounts = { inputTokens: 0, outputTokens: 0 };
  let done = false;
  try {
    for await (const data of readSse(res.body!, signal)) {
      onActivity();
      if (data === "[DONE]") {
        done = true;
        break;
      }
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.error) throw classifyHttp(Number((chunk.error as { code?: unknown }).code) || 500, JSON.stringify(chunk), null, ctx);
      const u = chunk.usage as RawUsage | undefined;
      if (u) usage = toUsage(u);
      for (const ch of (chunk.choices as Record<string, unknown>[] | undefined) ?? []) {
        const delta = (ch.delta ?? {}) as Record<string, unknown>;
        if (typeof delta.content === "string" && delta.content) {
          text += delta.content;
          onText(delta.content);
        }
        for (const tc of (delta.tool_calls as Record<string, unknown>[] | undefined) ?? []) accumulate(calls, tc);
        if (ch.finish_reason) finish = mapFinish(String(ch.finish_reason));
      }
    }
  } catch (e) {
    if (e instanceof LlmError) throw e;
    throw networkError(e, signal, ctx, true);
  }
  if (!done && !finish) throw new LlmError("STREAM_BROKEN", `${ctx.provider}/${ctx.model}: stream ended before completion`, ctx);
  const toolCalls = calls.filter((c) => c.name).map((c) => ({ id: c.id, name: c.name, arguments: c.arguments, extra: c.extra }));
  return { text, toolCalls, finishReason: toolCalls.length ? "tool_calls" : (finish ?? "stop"), usage };
};

function accumulate(calls: Acc[], tc: Record<string, unknown>) {
  const fn = (tc.function ?? {}) as { name?: string; arguments?: string | object };
  const id = typeof tc.id === "string" && tc.id ? tc.id : undefined;
  let idx = typeof tc.index === "number" ? tc.index : calls.length > 0 && !id ? calls.length - 1 : calls.length;
  // providers that send every complete call with index 0 but distinct ids
  if (calls[idx] && id && calls[idx].id && calls[idx].id !== id) idx = calls.length;
  const cur = (calls[idx] ??= { name: "", arguments: "" });
  if (id) cur.id = id;
  if (fn.name) cur.name = cur.name && cur.name !== fn.name ? cur.name + fn.name : fn.name;
  if (fn.arguments !== undefined) cur.arguments += typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments);
  if (tc.extra_content && typeof tc.extra_content === "object") cur.extra = { extra_content: tc.extra_content };
}

function fromCompletion(json: Record<string, unknown>, onText: (t: string) => void) {
  const choice = ((json.choices as Record<string, unknown>[] | undefined) ?? [])[0] ?? {};
  const msg = (choice.message ?? {}) as Record<string, unknown>;
  const text = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? (msg.content as { text?: string }[]).map((p) => p.text ?? "").join("") : "";
  if (text) onText(text);
  const toolCalls: RawToolCall[] = ((msg.tool_calls as Record<string, unknown>[] | undefined) ?? []).map((tc) => {
    const fn = (tc.function ?? {}) as { name?: string; arguments?: unknown };
    return {
      id: typeof tc.id === "string" ? tc.id : undefined,
      name: fn.name ?? "",
      arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      extra: tc.extra_content && typeof tc.extra_content === "object" ? { extra_content: tc.extra_content } : undefined,
    };
  });
  return {
    text,
    toolCalls,
    finishReason: toolCalls.length ? ("tool_calls" as const) : mapFinish(String(choice.finish_reason ?? "stop")),
    usage: toUsage((json.usage ?? {}) as RawUsage),
  };
}

function parseSseText(raw: string, ctx: { provider: string; model: string }, onText: (t: string) => void) {
  let text = "";
  const calls: Acc[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const d = line.slice(5).trim();
    if (!d || d === "[DONE]") continue;
    try {
      const c = JSON.parse(d) as { choices?: { delta?: { content?: string; tool_calls?: Record<string, unknown>[] } }[] };
      for (const ch of c.choices ?? []) {
        if (ch.delta?.content) text += ch.delta.content;
        for (const tc of ch.delta?.tool_calls ?? []) accumulate(calls, tc);
      }
    } catch {
      /* skip */
    }
  }
  if (!text && !calls.length) throw new LlmError("INVALID_OUTPUT", `${ctx.provider}/${ctx.model}: empty response`, ctx);
  if (text) onText(text);
  const toolCalls = calls.filter((c) => c.name).map((c) => ({ id: c.id, name: c.name, arguments: c.arguments, extra: c.extra }));
  return { text, toolCalls, finishReason: toolCalls.length ? ("tool_calls" as const) : ("stop" as const), usage: { inputTokens: 0, outputTokens: 0 } };
}

type RawUsage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
/** output includes reasoning/thinking tokens (Gemini reports them only in total_tokens) */
export function toUsage(u: RawUsage): LlmUsageCounts {
  const input = u.prompt_tokens ?? 0;
  const completion = u.completion_tokens ?? 0;
  return { inputTokens: input, outputTokens: Math.max(completion, (u.total_tokens ?? 0) - input) };
}

export function mapFinish(r: string): LlmFinishReason {
  if (r === "tool_calls" || r === "function_call") return "tool_calls";
  if (r === "length" || r === "max_tokens") return "length";
  if (r === "content_filter" || r === "safety") return "content_filter";
  return "stop";
}

export function networkError(e: unknown, signal: AbortSignal, ctx: { provider: string; model: string }, midStream = false): LlmError {
  if (e instanceof LlmError) return e;
  if (signal.aborted) {
    const reason = signal.reason;
    if (reason instanceof LlmError) return reason;
    return new LlmError("ABORTED", "aborted", ctx);
  }
  const err = e as Error & { cause?: { code?: string; message?: string } };
  const c = err.cause;
  const detail = [typeof c?.code === "string" ? c.code : null, c?.message, !c ? err.message : null].filter(Boolean).join(": ") || err.message;
  return new LlmError(midStream ? "STREAM_BROKEN" : "NETWORK", `${ctx.provider}/${ctx.model}: ${midStream ? "stream interrupted" : "network error"} (${detail})`, ctx);
}

/** GET {base}/models → ids (strips Gemini's "models/" prefix). */
export async function fetchOpenAiModels(provider: ResolvedProvider, signal?: AbortSignal): Promise<{ id: string; contextWindow?: number; maxOutput?: number; vision?: boolean; tools?: boolean; free?: boolean }[]> {
  const res = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/models`, { headers: openAiHeaders(provider), signal: signal ?? AbortSignal.timeout(15_000) });
  if (!res.ok) throw classifyHttp(res.status, await res.text().catch(() => ""), res.headers, { provider: provider.id, model: "models" });
  const j = (await res.json()) as { data?: Record<string, unknown>[]; models?: Record<string, unknown>[] } | Record<string, unknown>[];
  const list = Array.isArray(j) ? j : (j.data ?? j.models ?? []);
  return list
    .map((x) => {
      const id = String(x.id ?? x.name ?? "").replace(/^models\//, "");
      const arch = (x.architecture ?? {}) as { input_modalities?: string[] };
      const pricing = (x.pricing ?? {}) as { prompt?: string; completion?: string };
      const params = (x.supported_parameters ?? null) as string[] | null;
      return {
        id,
        contextWindow: num(x.context_length ?? x.context_window ?? x.max_context_length),
        maxOutput: num((x.top_provider as { max_completion_tokens?: unknown } | undefined)?.max_completion_tokens ?? x.max_completion_tokens ?? x.max_output_tokens),
        vision: arch.input_modalities ? arch.input_modalities.includes("image") : undefined,
        tools: params ? params.includes("tools") : undefined,
        free: id.endsWith(":free") || (pricing.prompt === "0" && pricing.completion === "0") || undefined,
      };
    })
    .filter((x) => x.id && !/embed|tts|transcribe|whisper|image|live|audio|guard|moderation|rerank|veo|imagen|lyria|aqa/i.test(x.id));
}

const num = (v: unknown) => (typeof v === "number" && v > 0 ? v : undefined);

export type { LlmMessage };
