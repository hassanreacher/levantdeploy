/**
 * LLM router — the single entry point every builder agent call goes through.
 *
 *   import { llm } from "@/lib/llm";
 *   const r = await llm.chat({ purpose: "code", messages, tools, onEvent });
 *
 * See docs/requests/llm.md for the contract. Worker-safe (no next/* imports).
 */
import { createRouter, type Router } from "./router";
import { defaultDeps } from "./runtime";

export * from "./types";
export { createRouter, type Router, type RouterDeps } from "./router";
export { repairJson, parseToolCallsFromText, normalizeToolCalls } from "./repair";
export { BUILTIN_PROVIDERS, DEFAULT_PREFERENCES, parseRef, refOf } from "./catalog";

const g = globalThis as unknown as { __llmRouter?: Router };

function router(): Router {
  return (g.__llmRouter ??= createRouter(defaultDeps()));
}

/** Lazily created singleton (Redis health store + DB settings + LlmUsage accounting). */
export const llm: Router = new Proxy({} as Router, {
  get(_t, prop) {
    const r = router() as unknown as Record<string | symbol, unknown>;
    const v = r[prop];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(r) : v;
  },
});
