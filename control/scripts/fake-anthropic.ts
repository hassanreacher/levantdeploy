/**
 * Fake Anthropic Messages API for tests (never used in production).
 *
 *   npx tsx scripts/fake-anthropic.ts [port=4105]
 *   ANTHROPIC_BASE_URL=http://127.0.0.1:4105 ANTHROPIC_API_KEY=sk-ant-fake… npm run dev
 *
 * Speaks the Messages streaming SSE protocol (message_start → content_block_start/delta/stop → message_delta →
 * message_stop) and validates requests like the real API would for what LevantDeploy relies on:
 *   - x-api-key + anthropic-version headers
 *   - `fallbacks: "default"` must come with the `server-side-fallback-2026-07-01` beta (and vice versa)
 *   - thinking must be omitted/adaptive (disabled/budget → 400 on claude-opus-5-5), forced tool_choice → 400
 *   - output_config.effort present; every client tool has eager_input_streaming
 *   - each assistant tool_use must be answered by tool_result blocks in the next user message
 * Scripted scenarios are chosen by keywords in the latest user text (see `script()`).
 * Test hooks: GET /__requests (recorded request bodies + headers), POST /__reset.
 */
import http from "node:http";
import crypto from "node:crypto";

type Json = Record<string, unknown>;
type Block = Json & { type: string };
type Msg = { role: "user" | "assistant"; content: string | Block[] };
type Turn = { blocks: Block[]; stop_reason: string; stop_details?: Json | null; model?: string };

const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const recorded: { headers: Json; body: Json; at: number }[] = [];
const seenPrefixes = new Set<string>();

const blocksOf = (m: Msg): Block[] => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content);

function latestUserText(messages: Msg[]): { text: string; index: number } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const texts = blocksOf(m).filter((b) => b.type === "text" && !String(b.text).trimStart().startsWith("<levant_context>"));
    if (texts.length) return { text: texts.map((t) => String(t.text)).join("\n"), index: i };
  }
  return { text: "", index: 0 };
}

function lastToolResults(messages: Msg[]): Block[] {
  const last = messages[messages.length - 1];
  return last && last.role === "user" ? blocksOf(last).filter((b) => b.type === "tool_result") : [];
}

const resultText = (b: Block | undefined) => (b ? (typeof b.content === "string" ? b.content : JSON.stringify(b.content)) : "");
const toolUse = (name: string, input: Json): Block => ({ type: "tool_use", id: `toolu_${crypto.randomBytes(8).toString("hex")}`, name, input });
const text = (t: string): Block => ({ type: "text", text: t });
const thinking = (t: string): Block => ({ type: "thinking", thinking: t, signature: crypto.randomBytes(24).toString("base64") });

/** The scripted "model". */
function script(body: Json): Turn {
  const messages = body.messages as Msg[];
  const { text: q, index } = latestUserText(messages);
  const step = messages.slice(index + 1).filter((m) => m.role === "assistant").length;
  const results = lastToolResults(messages);
  const lower = q.toLowerCase();

  // A one-shot diagnosis request (auto-diagnosis banner)
  if (lower.includes("write a short diagnosis for a banner")) {
    return { blocks: [text("**`DATABASE_URL` is not set**, so the app crashes on start.\n\n- Add `DATABASE_URL` in Environment\n- Redeploy")], stop_reason: "end_turn" };
  }

  if (lower.includes("refuse")) {
    return { blocks: [text("Let me look at th")], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "This request was flagged by a safety classifier." } };
  }

  if (lower.includes("fallback")) {
    return {
      model: "claude-opus-5",
      blocks: [{ type: "fallback", from: { model: String(body.model) }, to: { model: "claude-opus-5" }, trigger: { type: "refusal", category: "cyber" } }, text("Answered by the fallback model: your firewall rules look fine.")],
      stop_reason: "end_turn",
    };
  }

  if (lower.includes("invalid input")) {
    if (step === 0) return { blocks: [toolUse("set_env_var", { key: "1BAD KEY", value: 42 })], stop_reason: "tool_use" };
    return { blocks: [text(`The tool rejected my input: ${resultText(results[0]).slice(0, 80)}`)], stop_reason: "end_turn" };
  }

  if (lower.includes("roll back") || lower.includes("rollback")) {
    if (step === 0) return { blocks: [text("I'll propose restoring the previous production deployment."), toolUse("rollback", { deployment: "#1" })], stop_reason: "tool_use" };
    return { blocks: [text(results.some((r) => r.is_error) ? `Rollback not done: ${resultText(results[0]).slice(0, 200)}` : "Production now serves #1.")], stop_reason: "end_turn" };
  }

  if (lower.includes("fail") || lower.includes("fix") || lower.includes("why")) {
    if (step === 0)
      return {
        blocks: [
          thinking("The user wants to know why the latest deployment failed. I should look at the deployment and its build log in parallel."),
          text("I'll check the latest deployment and its build log."),
          toolUse("get_deployment", { deployment: "latest" }),
          toolUse("get_build_logs", { deployment: "latest", search: "error|DATABASE_URL", context: 1 }),
        ],
        stop_reason: "tool_use",
      };
    if (step === 1) {
      const logs = resultText(results.find((r) => resultText(r).includes("log —")) ?? results[1]);
      const missing = /DATABASE_URL/.test(logs);
      return {
        blocks: [
          text(
            `The build log shows the app can't start because **\`DATABASE_URL\` is not set**:\n\n\`\`\`\n${(logs.split("\n").find((l) => l.includes("DATABASE_URL")) ?? "Error: DATABASE_URL is not defined").trim()}\n\`\`\`\n\nI'll add it (you gave me the connection string earlier) and then redeploy.`,
          ),
          toolUse("set_env_var", { key: "DATABASE_URL", value: "postgres://app:s3cret-pass@db.internal:5432/app", targets: ["PRODUCTION", "PREVIEW"], is_secret: true }),
        ],
        stop_reason: missing ? "tool_use" : "tool_use",
      };
    }
    if (step === 2) {
      if (results.some((r) => String(resultText(r)).startsWith("REJECTED"))) return { blocks: [text("Okay — I won't change the environment. Tell me if you'd prefer another fix.")], stop_reason: "end_turn" };
      return { blocks: [text("`DATABASE_URL` is saved. Now a redeploy so it takes effect:"), toolUse("redeploy", { deployment: "latest" })], stop_reason: "tool_use" };
    }
    const r = resultText(results[0]);
    const num = /"number":\s*(\d+)/.exec(r)?.[1];
    return { blocks: [text(`Done. **Recap:** the build failed because \`DATABASE_URL\` was missing. I added it (production + preview, secret) and queued redeploy${num ? ` **#${num}**` : ""}. Watch the build in Deployments.`)], stop_reason: "end_turn" };
  }

  if (lower.includes("projects")) {
    if (step === 0) return { blocks: [toolUse("list_projects", {})], stop_reason: "tool_use" };
    return { blocks: [text(`Here are your projects:\n\n${resultText(results[0]).slice(0, 200)}`)], stop_reason: "end_turn" };
  }

  return {
    blocks: [
      text(
        "Hi! I'm the **LevantDeploy Agent**. I can diagnose failed builds, manage environment variables, domains and deployments.\n\nFor example, to deploy from your terminal:\n\n```bash\nnpx levant deploy --prod\n```\n\nAsk me *why a deployment failed* and I'll dig into the logs.",
      ),
    ],
    stop_reason: "end_turn",
  };
}

// ───────────────────────────── validation ─────────────────────────────

function validate(headers: http.IncomingHttpHeaders, body: Json): string | null {
  if (!headers["x-api-key"] && !headers["authorization"]) return "authentication_error: missing x-api-key";
  if (!headers["anthropic-version"]) return "anthropic-version header is required";
  const betas = String(headers["anthropic-beta"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (body.fallbacks === "default" && !betas.includes(FALLBACK_BETA)) return `fallbacks: "default" requires the ${FALLBACK_BETA} beta`;
  if (betas.includes(FALLBACK_BETA) && body.fallbacks !== undefined && body.fallbacks !== "default") return "the server-side-fallback-2026-07-01 beta only accepts fallbacks: \"default\"";
  const model = String(body.model ?? "");
  const thinking = body.thinking as Json | undefined;
  if (thinking && thinking.type !== "adaptive") return `"thinking.type.${thinking.type}" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.`;
  const tc = body.tool_choice as Json | undefined;
  if (tc && (tc.type === "any" || tc.type === "tool") && /opus-5-5|sonnet-5-5/.test(model)) return 'tool_choice: type "tool" and "any" are not supported for this model.';
  if (model.startsWith("claude-haiku") && body.fallbacks !== undefined && body.fallbacks !== "default") return "fallbacks is not supported for this model";
  const oc = body.output_config as Json | undefined;
  if (!oc || !["low", "medium", "high", "xhigh", "max"].includes(String(oc.effort))) return "test server: output_config.effort must be set explicitly";
  const tools = (body.tools as Json[] | undefined) ?? [];
  for (const t of tools) if (t.eager_input_streaming !== true) return `test server: tool ${t.name} must set eager_input_streaming`;
  const names = tools.map((t) => String(t.name));
  if ([...names].sort().join() !== names.join()) return "test server: tools must be sorted (stable cache prefix)";
  const messages = body.messages as Msg[];
  if (!Array.isArray(messages) || !messages.length || messages[0]!.role !== "user") return "messages: first message must use the user role";
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const uses = blocksOf(m).filter((b) => b.type === "tool_use").map((b) => String(b.id));
    if (!uses.length) continue;
    const next = messages[i + 1];
    if (!next) return "messages: trailing assistant tool_use without results";
    const results = blocksOf(next).filter((b) => b.type === "tool_result").map((b) => String(b.tool_use_id));
    for (const id of uses) if (!results.includes(id)) return `messages.${i + 1}: tool_use ids were found without tool_result blocks immediately after: ${id}`;
  }
  return null;
}

// ───────────────────────────── SSE writer ─────────────────────────────

function chunks(s: string, n: number) {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

async function streamTurn(res: http.ServerResponse, body: Json, turn: Turn, usage: Json) {
  const send = (event: string, data: Json) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "request-id": `req_fake_${Date.now()}` });
  send("message_start", {
    message: { id: `msg_fake_${crypto.randomBytes(6).toString("hex")}`, type: "message", role: "assistant", model: turn.model ?? body.model, content: [], stop_reason: null, stop_sequence: null, stop_details: null, usage: { ...usage, output_tokens: 1 } },
  });
  let outTokens = 0;
  for (let index = 0; index < turn.blocks.length; index++) {
    const b = turn.blocks[index]!;
    if (b.type === "text") {
      send("content_block_start", { index, content_block: { type: "text", text: "", citations: null } });
      for (const c of chunks(String(b.text), 12)) {
        send("content_block_delta", { index, delta: { type: "text_delta", text: c } });
        outTokens += 3;
        await sleep(4);
      }
    } else if (b.type === "thinking") {
      send("content_block_start", { index, content_block: { type: "thinking", thinking: "", signature: "" } });
      for (const c of chunks(String(b.thinking), 24)) send("content_block_delta", { index, delta: { type: "thinking_delta", thinking: c } });
      send("content_block_delta", { index, delta: { type: "signature_delta", signature: b.signature } });
    } else if (b.type === "tool_use") {
      send("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      for (const c of chunks(JSON.stringify(b.input), 9)) send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: c } });
      outTokens += 20;
    } else {
      send("content_block_start", { index, content_block: b });
    }
    send("content_block_stop", { index });
  }
  send("message_delta", { delta: { stop_reason: turn.stop_reason, stop_sequence: null, stop_details: turn.stop_details ?? null }, usage: { output_tokens: outTokens + 1 } });
  send("message_stop", {});
  res.end();
}

function usageFor(body: Json): Json {
  // Pretend-tokenizer: 4 chars per token. The tools+system prefix is "cached" after it was seen once.
  const prefix = JSON.stringify({ tools: body.tools, system: body.system, model: body.model });
  const key = crypto.createHash("sha256").update(prefix).digest("hex");
  const prefixTokens = Math.ceil(prefix.length / 4);
  const rest = Math.ceil(JSON.stringify(body.messages).length / 4);
  const hit = seenPrefixes.has(key);
  seenPrefixes.add(key);
  return { input_tokens: rest, cache_creation_input_tokens: hit ? 0 : prefixTokens, cache_read_input_tokens: hit ? prefixTokens : 0 };
}

export function startFakeAnthropic(port = 4105, host = "127.0.0.1"): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (req.method === "GET" && url.pathname === "/__requests") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(recorded));
    }
    if (req.method === "POST" && url.pathname === "/__reset") {
      recorded.length = 0;
      seenPrefixes.clear();
      res.writeHead(204);
      return res.end();
    }
    if (req.method !== "POST" || url.pathname !== "/v1/messages") {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `fake server: ${req.method} ${url.pathname}` } }));
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      let body: Json;
      try {
        body = JSON.parse(raw) as Json;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "invalid JSON" } }));
      }
      const safeHeaders = { ...req.headers, "x-api-key": req.headers["x-api-key"] ? "[redacted]" : undefined, authorization: undefined };
      recorded.push({ headers: safeHeaders as Json, body, at: Date.now() });
      const err = validate(req.headers, body);
      if (err) {
        const status = err.startsWith("authentication_error") ? 401 : 400;
        res.writeHead(status, { "content-type": "application/json" });
        return res.end(JSON.stringify({ type: "error", error: { type: status === 401 ? "authentication_error" : "invalid_request_error", message: err } }));
      }
      const turn = script(body);
      const usage = usageFor(body);
      if (body.stream) return streamTurn(res, body, turn, usage);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `msg_fake_${Date.now()}`,
          type: "message",
          role: "assistant",
          model: turn.model ?? body.model,
          content: turn.blocks,
          stop_reason: turn.stop_reason,
          stop_sequence: null,
          stop_details: turn.stop_details ?? null,
          usage: { ...usage, output_tokens: 42 },
        }),
      );
    });
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

const isMain = process.argv[1] && /fake-anthropic\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const port = Number(process.argv[2] || process.env.FAKE_ANTHROPIC_PORT || 4105);
  void startFakeAnthropic(port).then(() => console.log(`[fake-anthropic] listening on http://127.0.0.1:${port}`));
}
