/**
 * Local fake OpenAI-compatible server (chat/completions with SSE + /models) for the llm router tests.
 * Behaviour is chosen by the requested MODEL id (so one server can play many providers/models):
 *
 *   ok | ok-*            streams "Hello from <model>" in chunks (+ usage)
 *   tools                native tool_calls, arguments split across chunks
 *   tools-parallel       two native tool calls, both with index 0 and distinct ids (Gemini style)
 *   text-tools           tool call written as <tool_call>{…}</tool_call> text
 *   fenced-tools         tool call in a ```json fence with broken JSON (single quotes, trailing comma)
 *   json                 JSON answer wrapped in prose + fences
 *   bad-json             unrepairable "JSON"
 *   429 | 429-retry-N    HTTP 429 (Retry-After: N seconds, default 7)
 *   quota                HTTP 400 with a "quota exceeded" body
 *   503 | high-demand    HTTP 503 (overloaded / "high demand" body)
 *   500                  HTTP 500
 *   401 | 404            auth error / unknown model
 *   timeout              accepts the request and never answers
 *   stall                sends one chunk, then stalls forever
 *   broken               sends some text then destroys the socket (no [DONE])
 *   empty                completes with no content
 *   flaky                fails with 503 on every odd request to this model, ok on even
 *
 * Usage: `npx tsx scripts/fake-openai.ts [port]` or `startFakeOpenAI()` from tests.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export type FakeRequest = { path: string; model: string; body: Record<string, unknown>; headers: http.IncomingHttpHeaders };
export type FakeServer = { url: string; port: number; requests: FakeRequest[]; close: () => Promise<void> };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startFakeOpenAI(opts: { port?: number; chunkDelayMs?: number } = {}): Promise<FakeServer> {
  const requests: FakeRequest[] = [];
  const counts = new Map<string, number>();
  const sockets = new Set<import("node:net").Socket>();
  const delay = opts.chunkDelayMs ?? 2;

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const path = (req.url ?? "/").replace(/\?.*$/, "");

    if (req.method === "GET" && path.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: ["ok", "tools", "models/fake-vision-vl", "fake-embedding-001", "fake-8b-instant:free"].map((id) => ({ id, object: "model", context_length: 32000 })) }));
      return;
    }
    if (req.method !== "POST" || !path.endsWith("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const model = String(body.model ?? "");
    requests.push({ path, model, body, headers: req.headers });
    const n = (counts.get(model) ?? 0) + 1;
    counts.set(model, n);
    const stream = body.stream === true;
    const kind = model.replace(/^.*\//, "");

    const fail = (status: number, message: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify({ error: { message, code: status } }));
    };
    if (kind.startsWith("429")) return fail(429, "Rate limit reached for requests", { "retry-after": kind.match(/retry-(\d+)/)?.[1] ?? "7" });
    if (kind === "quota") return fail(400, "You exceeded your current quota, please check your plan and billing details.");
    if (kind === "503") return fail(503, "The model is overloaded. Please try again later.");
    if (kind === "high-demand") return fail(503, "This model is currently experiencing high demand. Spikes in demand are usually temporary.");
    if (kind === "500") return fail(500, "Internal error");
    if (kind === "401") return fail(401, "Incorrect API key provided: sk-fake-should-not-leak-1234.");
    if (kind === "404") return fail(404, `The model ${model} does not exist`);
    if (kind === "flaky" && n % 2 === 1) return fail(503, "flaky: try again");
    if (kind === "timeout") return; // never answer

    const id = `chatcmpl-${n}`;
    const usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };
    type Delta = { content?: string; tool_calls?: unknown[] };
    let deltas: Delta[] = [];
    let finish = "stop";
    const toolArgs = JSON.stringify({ path: "app/page.tsx", content: "export default function Page() { return <h1>Hi</h1>; }" });
    switch (kind) {
      case "tools":
        finish = "tool_calls";
        deltas = [
          { tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: "write_file", arguments: "" } }] },
          { tool_calls: [{ index: 0, function: { arguments: toolArgs.slice(0, 20) } }] },
          { tool_calls: [{ index: 0, function: { arguments: toolArgs.slice(20) } }] },
        ];
        break;
      case "tools-parallel":
        finish = "tool_calls";
        deltas = [
          { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' }, extra_content: { google: { thought_signature: "sig-1" } } }] },
          { tool_calls: [{ index: 0, id: "call_2", type: "function", function: { name: "read_file", arguments: '{"path":"b.ts"}' } }] },
        ];
        break;
      case "text-tools":
        deltas = [{ content: "I'll create the page.\n<tool_call>" }, { content: `{"name": "write_file", "arguments": ${toolArgs}}` }, { content: "</tool_call>" }];
        break;
      case "fenced-tools":
        deltas = [{ content: "```json\n{'name': 'write_file', 'arguments': {'path': 'app/page.tsx', 'content': 'x',},}\n```" }];
        break;
      case "json":
        deltas = [{ content: 'Sure! Here is the plan:\n```json\n{"files": ["app/page.tsx"], "steps": 2,}\n```' }];
        break;
      case "bad-json":
        deltas = [{ content: "this is definitely not json at all" }];
        break;
      case "empty":
        deltas = [];
        break;
      default: {
        const text = `Hello from ${model}`;
        deltas = text.split(/(?<= )/).map((content) => ({ content }));
      }
    }

    if (!stream) {
      const content = deltas.map((d) => d.content ?? "").join("");
      const calls: { id?: string; type: string; function: { name: string; arguments: string } }[] = [];
      for (const d of deltas)
        for (const tc of (d.tool_calls ?? []) as { id?: string; function: { name?: string; arguments?: string } }[]) {
          if (tc.id || !calls.length) calls.push({ id: tc.id, type: "function", function: { name: tc.function.name ?? "", arguments: tc.function.arguments ?? "" } });
          else calls[calls.length - 1].function.arguments += tc.function.arguments ?? "";
        }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id,
          object: "chat.completion",
          model,
          choices: [{ index: 0, message: { role: "assistant", content: content || null, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: finish }],
          usage,
        }),
      );
      return;
    }

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const chunk = (delta: Delta, fin: string | null = null) => send({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: fin }] });
    res.write(": keep-alive\n\n");
    if (kind === "stall") {
      chunk({ content: "Hel" });
      return; // never finishes
    }
    if (kind === "broken") {
      chunk({ role: "assistant", content: "Partial ans" } as Delta);
      await sleep(delay);
      chunk({ content: "wer that will be lost" });
      await sleep(delay);
      req.socket.destroy();
      return;
    }
    chunk({ role: "assistant" } as Delta);
    for (const d of deltas) {
      await sleep(delay);
      chunk(d);
    }
    chunk({}, finish);
    if ((body.stream_options as { include_usage?: boolean } | undefined)?.include_usage) send({ id, object: "chat.completion.chunk", model, choices: [], usage });
    res.write("data: [DONE]\n\n");
    res.end();
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

if (process.argv[1] && /fake-openai\.ts$/.test(process.argv[1])) {
  startFakeOpenAI({ port: Number(process.argv[2] ?? 4111), chunkDelayMs: 30 }).then((s) => console.log(`fake OpenAI-compatible server on ${s.url}`));
}
