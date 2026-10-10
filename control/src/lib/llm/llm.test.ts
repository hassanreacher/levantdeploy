import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeOpenAI, type FakeServer } from "../../../scripts/fake-openai";
import { resolveAll, preferencesOf, routingOf, type LlmSnapshot } from "./config";
import { Health, MemoryKv } from "./health";
import { createRouter, type LoadedConfig, type UsageRow } from "./router";
import { parseToolCallsFromText, repairJson } from "./repair";
import { classifyHttp, parseRetryAfter, scrubSecrets } from "./provider";
import { buildOpenAiBody, toUsage } from "./openai";
import { buildAnthropicRequest } from "./anthropic";
import { BUILTIN_PROVIDERS, DEFAULT_PREFERENCES, parseRef } from "./catalog";
import { LlmError, type LlmEvent, type LlmModelInfo, type LlmProviderOverride, type LlmTool } from "./types";

let fake: FakeServer;
beforeAll(async () => {
  fake = await startFakeOpenAI();
});
afterAll(async () => {
  await fake?.close();
});

const mi = (id: string, o: Partial<LlmModelInfo> = {}): LlmModelInfo => ({ id, tools: true, vision: false, contextWindow: 32_000, maxOutput: 4096, tier: "smart", ...o });

/** Router over custom providers pointing at the fake server (built-ins are dropped). */
function setup(providers: Record<string, { models: LlmModelInfo[]; rotate?: boolean; limits?: LlmProviderOverride["limits"]; jsonMode?: "schema" | "object" | "none" }>, prefs: Partial<Record<string, string[]>> = {}, routing: Partial<LoadedConfig["routing"]> = {}) {
  const overrides: Record<string, LlmProviderOverride> = {};
  for (const [id, p] of Object.entries(providers)) {
    overrides[id] = { custom: { label: id, jsonMode: p.jsonMode ?? "object" }, baseUrl: fake.url, apiKeyEnc: `plain:sk-test-${id}-0000`, models: p.models, limits: p.limits };
  }
  const snap: LlmSnapshot = { providers: overrides, preferences: prefs as LlmSnapshot["preferences"], routing: { timeoutMs: 2000, maxAttempts: 6, sameModelRetries: 0, ...routing }, modelsCache: {} };
  const { resolved, views } = resolveAll(snap, { env: {}, decrypt: (b) => (b?.startsWith("plain:") ? b.slice(6) : null), mask: (s) => `••••${s.slice(-4)}` });
  const ids = Object.keys(providers);
  const rot = ids.filter((id) => providers[id].rotate);
  const cfg: LoadedConfig = {
    providers: resolved.filter((p) => ids.includes(p.id)).map((p) => ({ ...p, rotate: rot.includes(p.id) })),
    views: views.filter((v) => ids.includes(v.id)),
    preferences: preferencesOf(snap),
    routing: routingOf(snap),
  };
  const usage: UsageRow[] = [];
  const sleeps: number[] = [];
  let now = Date.now();
  const health = new Health(new MemoryKv(() => now), () => now);
  const router = createRouter({
    load: async () => cfg,
    health,
    recordUsage: (r) => {
      usage.push(r);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
  });
  return { router, usage, sleeps, health, cfg, advance: (ms: number) => (now += ms) };
}

const user = (content: string) => [{ role: "user" as const, content }];
const writeFile: LlmTool = { name: "write_file", description: "Write a file", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } };
const readFile: LlmTool = { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } };
const reqsFor = (model: string) => fake.requests.filter((r) => r.model === model);

describe("streaming + events", () => {
  it("streams text deltas, usage and done; records LlmUsage", async () => {
    const { router, usage } = setup({ fa: { models: [mi("ok")] } });
    const events: LlmEvent[] = [];
    const r = await router.chat({ purpose: "chat", messages: user("hi"), onEvent: (e) => events.push(e), teamId: "t1", runId: "r1" });
    expect(r.text).toBe("Hello from ok");
    expect(r.provider).toBe("fa");
    expect(r.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(events[0]).toMatchObject({ type: "provider", provider: "fa", model: "ok", attempt: 1 });
    expect(events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("")).toBe("Hello from ok");
    expect(events.at(-1)?.type).toBe("done");
    expect(usage).toEqual([expect.objectContaining({ provider: "fa", model: "ok", purpose: "chat", ok: true, inputTokens: 11, outputTokens: 7, teamId: "t1", runId: "r1" })]);
    const sent = reqsFor("ok").at(-1)!;
    expect(sent.headers.authorization).toBe("Bearer sk-test-fa-0000");
    expect(sent.body.stream_options).toEqual({ include_usage: true });
  });

  it("llm.stream() yields the same events and returns the result", async () => {
    const { router } = setup({ fa: { models: [mi("ok-stream")] } });
    const gen = router.stream({ purpose: "chat", messages: user("hi") });
    const types: string[] = [];
    let step = await gen.next();
    while (!step.done) {
      types.push(step.value.type);
      step = await gen.next();
    }
    expect(step.value.text).toBe("Hello from ok-stream");
    expect(types[0]).toBe("provider");
    expect(types.at(-1)).toBe("done");
  });

  it("non-stream mode works too", async () => {
    const { router } = setup({ fa: { models: [mi("ok-nostream")] } });
    const r = await router.chat({ purpose: "chat", messages: user("hi"), stream: false });
    expect(r.text).toBe("Hello from ok-nostream");
    expect(reqsFor("ok-nostream").at(-1)!.body.stream).toBe(false);
  });
});

describe("tool calling", () => {
  it("accumulates native streamed tool calls", async () => {
    const { router } = setup({ fa: { models: [mi("tools")] } });
    const events: LlmEvent[] = [];
    const r = await router.chat({ purpose: "code", messages: user("make a page"), tools: [writeFile], onEvent: (e) => events.push(e) });
    expect(r.finishReason).toBe("tool_calls");
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]).toMatchObject({ id: "call_abc", name: "write_file", input: { path: "app/page.tsx" } });
    expect(events.filter((e) => e.type === "tool_call")).toHaveLength(1);
    const body = reqsFor("tools").at(-1)!.body;
    expect(body.tools).toEqual([{ type: "function", function: { name: "write_file", description: "Write a file", parameters: writeFile.parameters } }]);
  });

  it("splits parallel calls sent with the same index and keeps provider extras (thought signatures) for the next turn", async () => {
    const { router } = setup({ fa: { models: [mi("tools-parallel")] } });
    const r = await router.chat({ purpose: "code", messages: user("read"), tools: [readFile] });
    expect(r.toolCalls.map((c) => c.input)).toEqual([{ path: "a.ts" }, { path: "b.ts" }]);
    expect(r.toolCalls[0].extra).toEqual({ provider: "fa", data: { extra_content: { google: { thought_signature: "sig-1" } } } });
    // next turn echoes the signature back
    await router
      .chat({
        purpose: "code",
        model: "fa/tools-parallel",
        tools: [readFile],
        messages: [...user("read"), { role: "assistant", content: null, toolCalls: r.toolCalls }, { role: "tool", toolCallId: "call_1", name: "read_file", content: "A" }, { role: "tool", toolCallId: "call_2", name: "read_file", content: "B" }],
      })
      .catch(() => {});
    const msgs = reqsFor("tools-parallel").at(-1)!.body.messages as Record<string, unknown>[];
    const asst = msgs.find((m) => m.role === "assistant") as { tool_calls: Record<string, unknown>[] };
    expect(asst.tool_calls[0].extra_content).toEqual({ google: { thought_signature: "sig-1" } });
    expect(msgs.filter((m) => m.role === "tool").map((m) => m.tool_call_id)).toEqual(["call_1", "call_2"]);
  });

  it("parses tool calls written as text by models without native tools (and does not stream the raw markup)", async () => {
    const { router } = setup({ fa: { models: [mi("text-tools", { tools: false })] } });
    const events: LlmEvent[] = [];
    const r = await router.chat({ purpose: "code", messages: [{ role: "system", content: "You build apps." }, ...user("page")], tools: [writeFile], onEvent: (e) => events.push(e) });
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]).toMatchObject({ name: "write_file", input: { path: "app/page.tsx" } });
    expect(r.text).toBe("I'll create the page.");
    expect(events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("")).not.toContain("<tool_call>");
    const body = reqsFor("text-tools").at(-1)!.body;
    expect(body.tools).toBeUndefined();
    const sys = (body.messages as { role: string; content: string }[])[0];
    expect(sys.role).toBe("system");
    expect(sys.content).toContain("You build apps.");
    expect(sys.content).toContain("<tool_call>");
  });

  it("repairs fenced, single-quoted JSON tool calls", async () => {
    const { router } = setup({ fa: { models: [mi("fenced-tools", { tools: false })] } });
    const r = await router.chat({ purpose: "code", messages: user("page"), tools: [writeFile] });
    expect(r.toolCalls[0]).toMatchObject({ name: "write_file", input: { path: "app/page.tsx", content: "x" } });
  });
});

describe("failover, cooldown, retries", () => {
  it("429 → cooldown with Retry-After and failover to the next candidate; cooled model is skipped next time", async () => {
    const { router, health } = setup({ fa: { models: [mi("429-retry-120")] }, fb: { models: [mi("ok-b")] } }, { chat: ["fa/429-retry-120", "fb/ok-b"] });
    const events: LlmEvent[] = [];
    const r = await router.chat({ purpose: "chat", messages: user("hi"), onEvent: (e) => events.push(e) });
    expect(r.ref).toBe("fb/ok-b");
    expect(r.attempts.map((a) => [a.provider, a.ok, a.errorCode])).toEqual([
      ["fa", false, "RATE_LIMITED"],
      ["fb", true, undefined],
    ]);
    const retry = events.find((e) => e.type === "retry") as Extract<LlmEvent, { type: "retry" }>;
    expect(retry).toMatchObject({ code: "RATE_LIMITED", restart: false, provider: "fa" });
    const cool = await health.cooldown("fa/429-retry-120");
    expect(cool && cool.until - Date.now()).toBeGreaterThan(100_000); // Retry-After 120 s honoured
    const before = reqsFor("429-retry-120").length;
    const r2 = await router.chat({ purpose: "chat", messages: user("again") });
    expect(r2.ref).toBe("fb/ok-b");
    expect(reqsFor("429-retry-120").length).toBe(before);
  });

  it("quota errors in a 400 body count as rate limits", async () => {
    const { router } = setup({ fa: { models: [mi("quota")] }, fb: { models: [mi("ok-q")] } }, { chat: ["fa/quota", "fb/ok-q"] });
    const r = await router.chat({ purpose: "chat", messages: user("hi") });
    expect(r.attempts[0].errorCode).toBe("RATE_LIMITED");
  });

  it("503 / high demand → OVERLOADED and failover", async () => {
    const { router, health } = setup({ fa: { models: [mi("high-demand"), mi("503")] }, fb: { models: [mi("ok-c")] } }, { chat: ["fa/high-demand", "fa/503", "fb/ok-c"] });
    const r = await router.chat({ purpose: "chat", messages: user("hi") });
    expect(r.attempts.map((a) => a.errorCode ?? "ok")).toEqual(["OVERLOADED", "OVERLOADED", "ok"]);
    expect(await health.cooldown("fa/high-demand")).not.toBeNull();
  });

  it("times out a silent provider and a stalled stream, then fails over", async () => {
    const { router } = setup({ fa: { models: [mi("timeout"), mi("stall")] }, fb: { models: [mi("ok-t")] } }, { chat: ["fa/timeout", "fa/stall", "fb/ok-t"] }, { timeoutMs: 300 });
    const events: LlmEvent[] = [];
    const t0 = Date.now();
    const r = await router.chat({ purpose: "chat", messages: user("hi"), onEvent: (e) => events.push(e) });
    expect(r.ref).toBe("fb/ok-t");
    expect(r.attempts.map((a) => a.errorCode ?? "ok")).toEqual(["TIMEOUT", "TIMEOUT", "ok"]);
    expect(Date.now() - t0).toBeLessThan(3000);
    // the stalled stream had emitted "Hel" → its retry event tells the caller to discard
    const retries = events.filter((e) => e.type === "retry") as Extract<LlmEvent, { type: "retry" }>[];
    expect(retries.map((e) => e.restart)).toEqual([false, true]);
  });

  it("broken stream mid-way → retry event with restart:true and the whole request re-runs on the next model", async () => {
    const { router } = setup({ fa: { models: [mi("broken")] }, fb: { models: [mi("ok-d")] } }, { chat: ["fa/broken", "fb/ok-d"] });
    const events: LlmEvent[] = [];
    const r = await router.chat({ purpose: "chat", messages: user("hi"), onEvent: (e) => events.push(e) });
    expect(r.text).toBe("Hello from ok-d");
    const i = events.findIndex((e) => e.type === "retry");
    expect(events.slice(0, i).some((e) => e.type === "text")).toBe(true);
    expect(events[i]).toMatchObject({ type: "retry", code: "STREAM_BROKEN", restart: true });
    expect(events[i + 1]).toMatchObject({ type: "provider", provider: "fb", attempt: 2 });
  });

  it("transient errors retry the same model once with jittered backoff", async () => {
    const events: LlmEvent[] = [];
    // 503 is OVERLOADED (cooldown → failover, no same-model retry); 500 is the transient path
    const s2 = setup({ fa: { models: [mi("500")] }, fb: { models: [mi("ok-f")] } }, { chat: ["fa/500", "fb/ok-f"] }, { sameModelRetries: 1 });
    const r = await s2.router.chat({ purpose: "chat", messages: user("hi"), onEvent: (e) => events.push(e) });
    expect(r.attempts.map((a) => `${a.model}:${a.errorCode ?? "ok"}`)).toEqual(["500:SERVER", "500:SERVER", "ok-f:ok"]);
    expect(s2.sleeps).toEqual([400]); // 400 * 2^0 * (0.5 + 0.5)
    expect((events.find((e) => e.type === "retry") as { delayMs: number }).delayMs).toBe(400);
  });

  it("all candidates fail → ALL_FAILED with every attempt; error event emitted", async () => {
    const { router } = setup({ fa: { models: [mi("500")] }, fb: { models: [mi("404")] } }, { chat: ["fa/500", "fb/404"] });
    const events: LlmEvent[] = [];
    const err = await router.chat({ purpose: "chat", messages: user("hi"), onEvent: (e) => events.push(e) }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.code).toBe("ALL_FAILED");
    expect(err.attempts.map((a: { errorCode: string }) => a.errorCode)).toEqual(["SERVER", "NOT_FOUND"]);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "ALL_FAILED" });
  });

  it("401 puts the whole provider in cooldown and never leaks the key", async () => {
    const { router, health, usage } = setup({ fa: { models: [mi("401"), mi("ok-g")] }, fb: { models: [mi("ok-h")] } }, { chat: ["fa/401", "fa/ok-g", "fb/ok-h"] });
    const r = await router.chat({ purpose: "chat", messages: user("hi") });
    expect(r.ref).toBe("fb/ok-h"); // fa/ok-g skipped: provider cooled down
    expect(await health.cooldown("fa")).not.toBeNull();
    const row = usage.find((u) => !u.ok)!;
    expect(row.errorCode).toBe("AUTH");
    expect(row.error).not.toContain("sk-fake-should-not-leak-1234");
    expect(row.error).toContain("••••1234");
  });

  it("no enabled providers → NO_PROVIDERS", async () => {
    const { router } = setup({});
    await expect(router.chat({ purpose: "chat", messages: user("x") })).rejects.toMatchObject({ code: "NO_PROVIDERS" });
  });

  it("caller abort → ABORTED quickly", async () => {
    const { router } = setup({ fa: { models: [mi("timeout")] } }, {}, { timeoutMs: 10_000 });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 100);
    await expect(router.chat({ purpose: "chat", messages: user("x"), signal: ctl.signal })).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("pinOnly never falls back", async () => {
    const { router } = setup({ fa: { models: [mi("500")] }, fb: { models: [mi("ok-i")] } });
    await expect(router.chat({ purpose: "chat", messages: user("x"), model: "fa/500", pinOnly: true })).rejects.toMatchObject({ code: "ALL_FAILED" });
  });
});

describe("rate limits + rotation + ranking", () => {
  it("skips a model over its RPM and recovers next minute", async () => {
    const s = setup({ fa: { models: [mi("ok-rpm", { rpm: 2 })] }, fb: { models: [mi("ok-j")] } }, { chat: ["fa/ok-rpm", "fb/ok-j"] });
    const refs: string[] = [];
    for (let i = 0; i < 3; i++) refs.push((await s.router.chat({ purpose: "chat", messages: user("x") })).ref);
    expect(refs).toEqual(["fa/ok-rpm", "fa/ok-rpm", "fb/ok-j"]);
    s.advance(61_000);
    expect((await s.router.chat({ purpose: "chat", messages: user("x") })).ref).toBe("fa/ok-rpm");
  });

  it("provider-wide RPD limit", async () => {
    const s = setup({ fa: { models: [mi("ok-k1"), mi("ok-k2")], limits: { rpd: 1 } }, fb: { models: [mi("ok-k3")] } }, { chat: ["fa/ok-k1", "fa/ok-k2", "fb/ok-k3"] });
    expect((await s.router.chat({ purpose: "chat", messages: user("x") })).ref).toBe("fa/ok-k1");
    expect((await s.router.chat({ purpose: "chat", messages: user("x") })).ref).toBe("fb/ok-k3");
  });

  it("rotates across the free models of a 1-req/min provider", async () => {
    const s = setup({ uno: { rotate: true, limits: { modelRpm: 1 }, models: [mi("ok-r1"), mi("ok-r2"), mi("ok-r3")] } });
    const refs: string[] = [];
    for (let i = 0; i < 3; i++) {
      refs.push((await s.router.chat({ purpose: "chat", messages: user("x") })).model);
      s.advance(1000);
    }
    expect(new Set(refs).size).toBe(3);
    await expect(s.router.chat({ purpose: "chat", messages: user("x") })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    s.advance(60_000);
    expect((await s.router.chat({ purpose: "chat", messages: user("x") })).model).toBe(refs[0]);
  });

  it("ranks: explicit model, then preferences, then tier; native tools before text-mode; vision filter; unhealthy demoted", async () => {
    const s = setup(
      { fa: { models: [mi("a-fast", { tier: "fast" }), mi("a-smart"), mi("a-notools", { tools: false })] }, fb: { models: [mi("b-vision", { vision: true, tier: "fast" })] } },
      { code: ["fa/a-notools", "fa/a-fast"] },
    );
    let c = await s.router.candidates({ purpose: "code", tools: true });
    expect(c.map((x) => x.ref)).toEqual(["fa/a-fast", "fa/a-smart", "fb/b-vision", "fa/a-notools"]);
    c = await s.router.candidates({ purpose: "code" });
    expect(c.map((x) => x.ref)).toEqual(["fa/a-notools", "fa/a-fast", "fa/a-smart", "fb/b-vision"]);
    c = await s.router.candidates({ purpose: "chat", vision: true });
    expect(c.map((x) => x.ref)).toEqual(["fb/b-vision"]);
    for (let i = 0; i < 4; i++) await s.health.recordFailure("fa", "a-notools", "INVALID_OUTPUT", "x");
    c = await s.router.candidates({ purpose: "code" });
    expect(c.at(-1)!.ref).toBe("fa/a-notools");
  });
});

describe("JSON mode", () => {
  it("repairs JSON in prose/fences and returns it in result.json", async () => {
    const { router } = setup({ fa: { models: [mi("json")], jsonMode: "schema" } });
    const r = await router.chat({ purpose: "plan", messages: user("plan"), jsonSchema: { name: "plan", schema: { type: "object" } } });
    expect(r.json).toEqual({ files: ["app/page.tsx"], steps: 2 });
    expect(reqsFor("json").at(-1)!.body.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "plan" } });
  });
  it("invalid JSON → INVALID_OUTPUT and the next model is tried", async () => {
    const { router } = setup({ fa: { models: [mi("bad-json")] }, fb: { models: [mi("json")] } }, { plan: ["fa/bad-json", "fb/json"] });
    const r = await router.chat({ purpose: "plan", messages: user("plan"), json: true });
    expect(r.attempts[0].errorCode).toBe("INVALID_OUTPUT");
    expect(reqsFor("bad-json").at(-1)!.body.response_format).toEqual({ type: "json_object" });
  });
  it("empty completions are failures", async () => {
    const { router } = setup({ fa: { models: [mi("empty")] }, fb: { models: [mi("ok-l")] } }, { chat: ["fa/empty", "fb/ok-l"] });
    expect((await router.chat({ purpose: "chat", messages: user("x") })).attempts[0].errorCode).toBe("INVALID_OUTPUT");
  });
});

describe("ensemble + judge", () => {
  it("runs n different providers in parallel", async () => {
    const { router } = setup({ fa: { models: [mi("ok-e1")] }, fb: { models: [mi("ok-e2")] }, fc: { models: [mi("500"), mi("ok-e3")] } }, { code: ["fa/ok-e1", "fb/ok-e2", "fc/500"] });
    const items = await router.ensemble({ candidates: 3, purpose: "code", messages: user("x") });
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.ok)).toBe(true);
    const refs = items.map((i) => (i.ok ? i.result.ref : ""));
    expect(new Set(refs.map((r) => parseRef(r).provider)).size).toBe(3);
    expect(refs[2]).toBe("fc/ok-e3"); // fell back within its own provider
  });

  it("judge parses the verdict and clamps it", async () => {
    const router = createRouter({
      load: async () => ({
        providers: [{ id: "j", label: "j", kind: "openai", baseUrl: "http://x", apiKey: "k", headers: {}, enabled: true, configured: true, jsonMode: "schema", modelsEndpoint: false, rotate: false, limits: {}, models: [mi("judge")], allModels: [mi("judge")] }],
        views: [],
        preferences: DEFAULT_PREFERENCES,
        routing: { timeoutMs: 1000, maxAttempts: 2, sameModelRetries: 0 },
      }),
      health: new Health(new MemoryKv()),
      adapters: { openai: async () => ({ text: '```json\n{"scores": [3, 9.5, 42], "winner": 7, "reasoning": "B compiles"}\n```', toolCalls: [], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }) },
    });
    const v = await router.judge("Write X", ["a", "b", "c"]);
    expect(v).toMatchObject({ winner: 2, scores: [3, 9.5, 10], reasoning: "B compiles", judge: { provider: "j", model: "judge" } });
  });
});

describe("repair", () => {
  it.each([
    ['{"a":1}', { a: 1 }],
    ['```json\n{"a": [1,2,],}\n```', { a: [1, 2] }],
    ["Here you go: {'path': 'x.ts', 'ok': True, 'n': None}", { path: "x.ts", ok: true, n: null }],
    ["{path: \"a\", count: 2}", { path: "a", count: 2 }],
    ['{"content": "line1\\nline2", "nested": {"a": "b', { content: "line1\nline2", nested: { a: "b" } }],
    ["“{“a”: 1}", { a: 1 }],
  ])("repairs %s", (input, expected) => {
    const r = repairJson(input);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(expected);
  });
  it("fails cleanly", () => expect(repairJson("nope").ok).toBe(false));

  it.each([
    ['<tool_call>{"name": "read_file", "arguments": {"path": "a"}}</tool_call>', "read_file"],
    ['<function=read_file>{"path": "a"}</function>', "read_file"],
    ['[TOOL_CALLS] [{"name": "read_file", "arguments": {"path": "a"}}]', "read_file"],
    ['```json\n{"tool": "read_file", "parameters": {"path": "a"}}\n```', "read_file"],
    ['{"tool_calls": [{"function": {"name": "read_file", "arguments": "{\\"path\\": \\"a\\"}"}}]}', "read_file"],
  ])("parses text tool call %s", (text, name) => {
    const r = parseToolCallsFromText(text, ["read_file"]);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ name, input: { path: "a" } });
    expect(r.calls[0].id).toMatch(/^call_/);
  });
  it("ignores JSON that is not a call to a known tool", () => {
    expect(parseToolCallsFromText('{"name": "Bob", "age": 3}', ["read_file"]).calls).toHaveLength(0);
    expect(parseToolCallsFromText("no tools here", ["read_file"]).calls).toHaveLength(0);
  });
});

describe("provider plumbing", () => {
  it("classifies HTTP errors and Retry-After", () => {
    const ctx = { provider: "p", model: "m" };
    expect(classifyHttp(429, "{}", new Headers({ "retry-after": "12" }), ctx)).toMatchObject({ code: "RATE_LIMITED", extra: { retryAfterMs: 12_000 } });
    expect(classifyHttp(503, '{"error":{"message":"high demand"}}', null, ctx).code).toBe("OVERLOADED");
    expect(classifyHttp(400, '{"error":{"message":"Quota exceeded for metric"}}', null, ctx).code).toBe("RATE_LIMITED");
    expect(classifyHttp(400, '{"error":{"message":"invalid tools"}}', null, ctx).code).toBe("BAD_REQUEST");
    expect(classifyHttp(403, "forbidden", null, ctx).code).toBe("AUTH");
    expect(classifyHttp(404, "", null, ctx).code).toBe("NOT_FOUND");
    expect(parseRetryAfter(null, '"retryDelay": "31s"')).toBe(31_000);
    expect(parseRetryAfter(null, "Please try again in 1m30s")).toBe(90_000);
  });
  it("scrubs keys from messages", () => {
    expect(scrubSecrets("bad key AIzaSyA1234567890abcdefghijkLMNO used", [])).not.toContain("AIzaSyA1234567890");
    expect(scrubSecrets("key=abcdef123 x", [])).toBe("key=•••• x");
    expect(scrubSecrets("my secret-key-value-9876 here", ["secret-key-value-9876"])).toBe("my ••••9876 here");
  });

  it("OpenAI body: Gemini gets a bypass thought signature for foreign tool calls; images dropped for non-vision models", () => {
    const gem = { id: "gemini", label: "g", kind: "openai" as const, baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: "k", headers: {}, enabled: true, configured: true, jsonMode: "schema" as const, modelsEndpoint: true, rotate: false, limits: {}, models: [], allModels: [] };
    const body = buildOpenAiBody(
      {
        purpose: "code",
        tools: [readFile],
        messages: [
          { role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] },
          { role: "assistant", content: null, toolCalls: [{ id: "x1", name: "read_file", arguments: '{"path":"a"}', input: { path: "a" }, extra: { provider: "groq", data: { foo: 1 } } }] },
          { role: "tool", toolCallId: "x1", content: "A" },
        ],
      },
      gem,
      mi("gemini-3.5-flash", { vision: false }),
      true,
    );
    const msgs = body.messages as Record<string, unknown>[];
    expect(msgs[0].content).toBe("see\n[image omitted: this model cannot see images]");
    expect((msgs[1].tool_calls as Record<string, unknown>[])[0]).toEqual({ id: "x1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' }, extra_content: { google: { thought_signature: "skip_thought_signature_validator" } } });
    expect(body.max_tokens).toBe(4096);
  });

  it("usage counts thinking tokens; Gemini quick purposes use minimal reasoning", () => {
    expect(toUsage({ prompt_tokens: 8, completion_tokens: 1, total_tokens: 69 })).toEqual({ inputTokens: 8, outputTokens: 61 });
    expect(toUsage({ prompt_tokens: 8, completion_tokens: 5 })).toEqual({ inputTokens: 8, outputTokens: 5 });
    const gem = { id: "gemini", label: "g", kind: "openai" as const, baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: "k", headers: {}, enabled: true, configured: true, jsonMode: "schema" as const, modelsEndpoint: true, rotate: false, limits: {}, models: [], allModels: [] };
    expect(buildOpenAiBody({ purpose: "fast", messages: user("x") }, gem, mi("g"), true).reasoning_effort).toBe("minimal");
    expect(buildOpenAiBody({ purpose: "code", messages: user("x") }, gem, mi("g"), true).reasoning_effort).toBeUndefined();
    expect(buildOpenAiBody({ purpose: "fast", messages: user("x") }, { ...gem, id: "groq", baseUrl: "https://api.groq.com/openai/v1" }, mi("g"), true).reasoning_effort).toBeUndefined();
  });

  it("Anthropic request: no sampling params, auto tool_choice for forced tools, tool results merged, images mapped", () => {
    const p = buildAnthropicRequest(
      {
        purpose: "code",
        temperature: 0.3,
        toolChoice: { name: "read_file" },
        tools: [readFile],
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }, { type: "text", text: "hi" }] },
          { role: "assistant", content: "ok", toolCalls: [{ id: "call.1", name: "read_file", arguments: "{}", input: { path: "a" } }, { id: "c2", name: "read_file", arguments: "{}", input: { path: "b" } }] },
          { role: "tool", toolCallId: "call.1", content: "A" },
          { role: "tool", toolCallId: "c2", content: "B" },
        ],
      },
      "claude-sonnet-5-5",
      64_000,
    );
    expect(p).not.toHaveProperty("temperature");
    expect(p.tool_choice).toEqual({ type: "auto" });
    expect(p.system).toContain('You must call the tool "read_file"');
    expect(p.messages).toHaveLength(3);
    expect(p.messages[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "A" }, { type: "tool_result", tool_use_id: "c2", content: "B" }] });
    expect((p.messages[0].content as { type: string }[])[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } });
    expect(p.output_config).toEqual({ effort: "medium" });
  });
});

describe("config resolution", () => {
  const dec = (b: string | null | undefined) => (b?.startsWith("plain:") ? b.slice(6) : null);
  const mask = (s: string) => `••••${s.slice(-4)}`;
  it("covers every provider of the spec table", () => {
    expect(BUILTIN_PROVIDERS.map((p) => p.id).sort()).toEqual(
      ["anthropic", "cerebras", "cloudflare", "gemini", "groq", "kilo", "llm7", "logfare", "mistral", "nvidia", "ollama", "openrouter", "orcarouter", "ovh", "pollinations", "unorouter"].sort(),
    );
    for (const purpose of Object.keys(DEFAULT_PREFERENCES) as (keyof typeof DEFAULT_PREFERENCES)[])
      for (const ref of DEFAULT_PREFERENCES[purpose]) {
        const { provider, model } = parseRef(ref);
        expect(BUILTIN_PROVIDERS.find((p) => p.id === provider)?.models.some((m) => m.id === model), ref).toBe(true);
      }
  });
  it("setting key > env key; masked hints; logfare off by default; cloudflare needs the account id", () => {
    const snap: LlmSnapshot = {
      providers: { groq: { apiKeyEnc: "plain:gsk_fromsetting_ABCD" }, openrouter: { headers: { "X-Title": "Mine" } } },
      preferences: null,
      routing: null,
      modelsCache: { gemini: { fetchedAt: "2026-01-01T00:00:00Z", models: [{ id: "gemini-3.7-flash" }, { id: "gemini-3.5-flash", contextWindow: 999 }] } },
    };
    const env = { GROQ_API_KEY: "gsk_env_1111", GEMINI_API_KEY: "AIza-env-2222", LOGFARE_API_KEY: "lf-3333", CLOUDFLARE_API_TOKEN: "cf-4444" };
    const { resolved, views } = resolveAll(snap, { env, decrypt: dec, mask });
    const v = (id: string) => views.find((x) => x.id === id)!;
    const r = (id: string) => resolved.find((x) => x.id === id)!;
    expect(r("groq").apiKey).toBe("gsk_fromsetting_ABCD");
    expect(v("groq")).toMatchObject({ keySource: "setting", keyHint: "••••ABCD", configured: true });
    expect(v("gemini")).toMatchObject({ keySource: "env", keyHint: "••••2222", enabled: true });
    expect(JSON.stringify(views)).not.toContain("gsk_fromsetting_ABCD");
    expect(v("logfare")).toMatchObject({ enabled: false, configured: true });
    expect(v("logfare").warning).toMatch(/logs your prompts/i);
    expect(v("cloudflare").configured).toBe(false);
    expect(v("openrouter").headers).toMatchObject({ "HTTP-Referer": expect.any(String), "X-Title": "Mine" });
    expect(v("pollinations").configured).toBe(false); // keyless tier only when explicitly enabled
    // fetched models: merged into the view, only explicit refs for non-rotation providers
    expect(v("gemini").models.find((m) => m.id === "gemini-3.7-flash")?.source).toBe("fetched");
    expect(v("gemini").models.find((m) => m.id === "gemini-3.5-flash")?.contextWindow).toBe(999);
    expect(r("gemini").models.some((m) => m.id === "gemini-3.7-flash")).toBe(false);
    expect(r("gemini").allModels.some((m) => m.id === "gemini-3.7-flash")).toBe(true);
    const cf = resolveAll({ ...snap, providers: { cloudflare: { vars: { CLOUDFLARE_ACCOUNT_ID: "acc123" } } } }, { env, decrypt: dec, mask });
    expect(cf.resolved.find((x) => x.id === "cloudflare")).toMatchObject({ configured: true, baseUrl: "https://api.cloudflare.com/client/v4/accounts/acc123/ai/v1" });
  });
  it("custom providers and model overrides", () => {
    const snap: LlmSnapshot = {
      providers: { myllm: { custom: { label: "My LLM" }, baseUrl: "https://llm.example.com/v1", apiKeyEnc: "plain:k-5555", models: [mi("m1"), mi("m2")], modelOverrides: { m2: { disabled: true }, m1: { tier: "fast" } } } },
      preferences: { code: ["myllm/m1"] },
      routing: null,
      modelsCache: {},
    };
    const { resolved, views } = resolveAll(snap, { env: {}, decrypt: dec, mask });
    expect(views.find((x) => x.id === "myllm")).toMatchObject({ custom: true, label: "My LLM", configured: true });
    expect(resolved.find((x) => x.id === "myllm")!.models.map((m) => [m.id, m.tier])).toEqual([["m1", "fast"]]);
    expect(preferencesOf(snap).code).toEqual(["myllm/m1"]);
    expect(preferencesOf(snap).plan).toEqual(DEFAULT_PREFERENCES.plan);
  });
});
