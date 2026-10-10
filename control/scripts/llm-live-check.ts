/**
 * Live check of every configured LLM provider (keys from the environment only; never printed).
 *
 *   set -a; . /home/user/.levant-secrets/providers.env; set +a
 *   npx tsx scripts/llm-live-check.ts [--provider gemini] [--deep] [--timeout 20000]
 *
 * --deep additionally runs, per Gemini model: streaming, native tool calling and a 2-turn tool round-trip
 * (thought signatures echoed back). Behind an HTTPS proxy (sandbox) the script re-executes itself with
 * NODE_USE_ENV_PROXY=1 so fetch() uses it. Providers that cannot be reached are reported as such — never faked.
 */
import { spawnSync } from "node:child_process";
import { resolveAll, preferencesOf, routingOf, type LlmSnapshot } from "../src/lib/llm/config";
import { Health, MemoryKv } from "../src/lib/llm/health";
import { createRouter } from "../src/lib/llm/router";
import type { LlmErrorCode, LlmEvent, LlmTool } from "../src/lib/llm/types";

const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxy && !process.env.NODE_USE_ENV_PROXY) {
  const ca = process.env.NODE_EXTRA_CA_CERTS || "/root/.ccr/ca-bundle.crt";
  const r = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, NODE_USE_ENV_PROXY: "1", NODE_EXTRA_CA_CERTS: ca, NODE_NO_WARNINGS: "1" },
  });
  process.exit(r.status ?? 1);
}

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = opt("--provider");
const deep = args.includes("--deep");
const timeoutMs = Number(opt("--timeout") ?? 20_000);

const snap: LlmSnapshot = { providers: {}, preferences: null, routing: { timeoutMs, maxAttempts: 1, sameModelRetries: 0 }, modelsCache: {} };
const { resolved, views } = resolveAll(snap, { env: process.env, decrypt: () => null, mask: (s) => `••••${s.slice(-4)}` });
const router = createRouter({
  load: async () => ({ providers: resolved, views, preferences: preferencesOf(snap), routing: routingOf(snap) }),
  health: new Health(new MemoryKv()),
});

type Row = { provider: string; model: string; check: string; ok: string; latency: string; detail: string };
const rows: Row[] = [];
const note = (code: LlmErrorCode | undefined, msg: string) => {
  if (proxy && (code === "TIMEOUT" || code === "NETWORK")) return `unreachable from sandbox (network policy): ${msg}`;
  if (proxy && code === "AUTH" && /403/.test(msg) === false && /proxy|forbidden|blocked/i.test(msg)) return `blocked by sandbox proxy: ${msg}`;
  return msg;
};

const tool: LlmTool = {
  name: "get_weather",
  description: "Get the current weather for a city",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};

async function basic(provider: string, model: string) {
  const t0 = Date.now();
  try {
    const r = await router.chat({ purpose: "fast", model: `${provider}/${model}`, pinOnly: true, messages: [{ role: "user", content: "Reply with the single word: pong" }], maxTokens: 64, stream: false });
    rows.push({ provider, model, check: "chat", ok: "yes", latency: `${Date.now() - t0} ms`, detail: JSON.stringify(r.text.trim().slice(0, 40)) });
    return true;
  } catch (e) {
    const err = e as { code?: LlmErrorCode; message: string; attempts?: { errorCode?: LlmErrorCode; error?: string }[] };
    const a = err.attempts?.[0];
    rows.push({ provider, model, check: "chat", ok: "no", latency: `${Date.now() - t0} ms`, detail: note(a?.errorCode ?? err.code, `${a?.errorCode ?? err.code}: ${(a?.error ?? err.message).slice(0, 140)}`) });
    return false;
  }
}

async function deepChecks(provider: string, model: string) {
  // streaming
  let t0 = Date.now();
  try {
    let deltas = 0;
    const r = await router.chat({
      purpose: "chat",
      model: `${provider}/${model}`,
      pinOnly: true,
      messages: [{ role: "user", content: "Count from 1 to 15 separated by spaces." }],
      maxTokens: 400,
      onEvent: (e: LlmEvent) => {
        if (e.type === "text") deltas++;
      },
    });
    rows.push({ provider, model, check: "stream", ok: deltas > 0 ? "yes" : "no", latency: `${Date.now() - t0} ms`, detail: `${deltas} deltas, ${r.usage.inputTokens}/${r.usage.outputTokens} tok: ${JSON.stringify(r.text.trim().slice(0, 30))}` });
  } catch (e) {
    rows.push({ provider, model, check: "stream", ok: "no", latency: `${Date.now() - t0} ms`, detail: (e as Error).message.slice(0, 160) });
  }
  // tool call + round trip
  t0 = Date.now();
  try {
    const messages: Parameters<typeof router.chat>[0]["messages"] = [{ role: "user", content: "What's the weather in Beirut? Use the tool." }];
    const r1 = await router.chat({ purpose: "code", model: `${provider}/${model}`, pinOnly: true, messages, tools: [tool], maxTokens: 800 });
    const call = r1.toolCalls[0];
    if (!call) throw new Error(`no tool call (text: ${JSON.stringify(r1.text.slice(0, 60))})`);
    rows.push({ provider, model, check: "tool_call", ok: call.name === "get_weather" ? "yes" : "no", latency: `${Date.now() - t0} ms`, detail: `${call.name}(${call.arguments})${call.extra ? " +signature" : ""}` });
    t0 = Date.now();
    messages.push({ role: "assistant", content: r1.text || null, toolCalls: r1.toolCalls });
    for (const c of r1.toolCalls) messages.push({ role: "tool", toolCallId: c.id, name: c.name, content: JSON.stringify({ city: "Beirut", tempC: 27, sky: "sunny" }) });
    const r2 = await router.chat({ purpose: "code", model: `${provider}/${model}`, pinOnly: true, messages, tools: [tool], maxTokens: 400 });
    rows.push({ provider, model, check: "tool_result", ok: /27/.test(r2.text) ? "yes" : "no", latency: `${Date.now() - t0} ms`, detail: JSON.stringify(r2.text.trim().slice(0, 60)) });
  } catch (e) {
    rows.push({ provider, model, check: "tool_call", ok: "no", latency: `${Date.now() - t0} ms`, detail: (e as Error).message.slice(0, 160) });
  }
}

async function main() {
  const targets = resolved.filter((p) => (!only || p.id === only) && p.enabled && p.configured);
  const skipped = views.filter((v) => (!only || v.id === only) && !(v.enabled && v.configured));
  console.log(`Checking ${targets.length} provider(s)${proxy ? " (sandbox: HTTPS proxy in use)" : ""}…`);
  await Promise.all(
    targets.map(async (p) => {
      const models = p.id === "gemini" ? ["gemini-3.5-flash", "gemini-3-flash-preview", "gemini-3.1-flash-lite"] : [p.models.find((m) => m.tier === "fast")?.id ?? p.models[0]?.id];
      for (const m of models.filter(Boolean) as string[]) {
        const ok = await basic(p.id, m);
        if (ok && deep && p.id === "gemini") await deepChecks(p.id, m);
        if (!ok && p.id !== "gemini") break;
      }
    }),
  );
  for (const v of skipped) rows.push({ provider: v.id, model: "-", check: "-", ok: "skip", latency: "-", detail: !v.enabled ? "disabled (default off)" : v.extraVars.length && !v.extraVars.every((x) => v.vars[x]) ? `missing ${v.extraVars.join(", ")}` : "no key configured" });
  rows.sort((a, b) => a.provider.localeCompare(b.provider));
  const cols: (keyof Row)[] = ["provider", "model", "check", "ok", "latency", "detail"];
  const w = cols.map((c) => Math.min(80, Math.max(c.length, ...rows.map((r) => r[c].length))));
  const line = (r: Record<string, string>) => cols.map((c, i) => r[c].slice(0, w[i]).padEnd(w[i])).join("  ");
  console.log(line(Object.fromEntries(cols.map((c) => [c, c]))));
  console.log(w.map((n) => "-".repeat(n)).join("  "));
  for (const r of rows) console.log(line(r));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
