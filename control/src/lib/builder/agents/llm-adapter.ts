/**
 * LlmPort over the platform router (`@/lib/llm`, llm area). Maps the agents' provider-agnostic conversation to the
 * router's types and the router's errors to LlmCallError (so the orchestrator knows which provider to exclude).
 */
import type { LlmChatRequest, LlmError as LlmErrorT, LlmMessage, LlmPurpose, LlmResult, LlmToolCall } from "@/lib/llm";
import { LlmCallError, type ChatRequest, type ChatResult, type LlmPort, type Msg, type ToolCall } from "./types";

type Router = typeof import("@/lib/llm")["llm"];

const PURPOSES: LlmPurpose[] = ["plan", "code", "fix", "judge", "chat", "vision", "fast"];
const purposeOf = (p: string): LlmPurpose => (PURPOSES.includes(p as LlmPurpose) ? (p as LlmPurpose) : "code");

function toLlmToolCall(t: ToolCall): LlmToolCall {
  let input: Record<string, unknown> | null = null;
  try {
    const v = JSON.parse(t.arguments || "{}");
    input = v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {}
  const extra = t.extra as LlmToolCall["extra"] | undefined;
  return { id: t.id, name: t.name, arguments: t.arguments || "{}", input, ...(extra && typeof extra.provider === "string" ? { extra } : {}) };
}

export function toLlmMessages(messages: Msg[]): LlmMessage[] {
  return messages.map((m): LlmMessage => {
    switch (m.role) {
      case "assistant":
        return { role: "assistant", content: m.content || null, ...(m.toolCalls?.length ? { toolCalls: m.toolCalls.map(toLlmToolCall) } : {}) };
      case "tool":
        return { role: "tool", toolCallId: m.toolCallId, name: m.name, content: m.content };
      case "user":
        return { role: "user", content: m.content };
      default:
        return { role: "system", content: m.content };
    }
  });
}

function toLlmRequest(req: ChatRequest): LlmChatRequest {
  return {
    purpose: purposeOf(req.purpose),
    messages: toLlmMessages(req.messages),
    tools: req.tools?.map((t) => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters })),
    toolChoice: req.tools?.length ? "auto" : undefined,
    jsonSchema: req.jsonSchema ? { name: req.jsonSchema.name, schema: req.jsonSchema.schema } : undefined,
    temperature: req.temperature,
    maxTokens: req.maxTokens ?? (req.tools?.length ? 16_000 : 8_000),
    providers: req.provider ? [req.provider] : undefined,
    exclude: req.excludeProviders?.length ? req.excludeProviders : undefined,
    signal: req.signal,
    teamId: req.teamId ?? null,
    runId: req.ref?.runId ?? null,
    // whole files are written through tool arguments: allow long gaps between chunks
    timeoutMs: 120_000,
  };
}

export function fromLlmResult(r: LlmResult): ChatResult {
  const failed = r.attempts.filter((a) => !a.ok);
  return {
    content: r.text ?? "",
    toolCalls: r.toolCalls.map((t) => ({ id: t.id, name: t.name, arguments: t.input ? JSON.stringify(t.input) : t.arguments, ...(t.extra ? { extra: t.extra as unknown as Record<string, unknown> } : {}) })),
    provider: r.provider,
    model: r.model,
    usage: r.usage,
    fallbacks: failed.map((a) => ({ from: `${a.provider}/${a.model}`, to: r.ref, reason: `${a.errorCode ?? "error"}: ${(a.error ?? "").slice(0, 120)}` })),
    finishReason: r.finishReason,
    json: r.json,
  };
}

function toCallError(e: unknown): LlmCallError {
  const err = e as LlmErrorT & { code?: string };
  if (!err || typeof err !== "object" || typeof err.code !== "string") return new LlmCallError((e as Error)?.message ?? String(e));
  const attempts = (err.extra?.attempts ?? []) as { provider: string }[];
  const provider = err.extra?.provider ?? attempts.at(-1)?.provider ?? null;
  switch (err.code) {
    case "NO_PROVIDERS":
      return new LlmCallError("No AI provider is configured or available — the platform owner can add one in Settings → AI providers.", null, true, false);
    case "ALL_FAILED":
      return new LlmCallError(err.message, provider, true, true, err.extra?.retryAfterMs ?? null);
    case "RATE_LIMITED":
    case "OVERLOADED":
      // no attempt made = every candidate is cooling down → wait, don't exclude
      return new LlmCallError(err.message, attempts.length ? provider : null, !attempts.length, true, err.extra?.retryAfterMs ?? null);
    case "ABORTED":
      return new LlmCallError("aborted", provider, false, false);
    default:
      return new LlmCallError(err.message, provider, false, true);
  }
}

export function routerLlm(router: Router): LlmPort {
  return {
    async chat(req) {
      try {
        return fromLlmResult(await router.chat(toLlmRequest(req)));
      } catch (e) {
        throw toCallError(e);
      }
    },
    async providers(purpose, opts) {
      const list = (await router.candidates({ purpose: purposeOf(purpose), tools: opts?.needTools })).filter((c) => !c.unavailable);
      const out: string[] = [];
      for (const c of list) if (!out.includes(c.provider)) out.push(c.provider);
      // a single provider: diversify best-of-N across its models ("provider/model" refs are valid allow-list entries)
      if (out.length < 2) return [...new Set(list.map((c) => c.ref))].slice(0, 3);
      return out;
    },
    async ensemble(req) {
      const { candidates, ...rest } = req;
      const { model: _m, pinOnly: _p, onEvent: _e, ...base } = toLlmRequest(rest);
      const items = await router.ensemble({ ...base, candidates });
      return items.map((i) => (i.ok ? { ok: true as const, result: fromLlmResult(i.result) } : { ok: false as const, error: `${i.error.code}: ${i.error.message}`, provider: i.ref?.split("/")[0] ?? null }));
    },
    async judge(task, candidates, opts) {
      const v = await router.judge(task, candidates, { criteria: opts.criteria, signal: opts.signal, teamId: opts.teamId ?? null, runId: opts.runId ?? null });
      return { winner: v.winner, reasoning: v.reasoning, provider: v.judge.provider, model: v.judge.model };
    },
  };
}
