import type { Actor } from "@/lib/http";
import type { AiActor } from "./permissions";
import type { AgentEvent } from "./types";

/** HTTP actor (session or API token) → tool actor. */
export const toAiActor = (a: Actor): AiActor => ({ userId: a.user.id, token: a.token });

/**
 * Server-Sent Events response for an agent run: one `data: <AgentEvent JSON>` per event, `: ping` every 15 s.
 * The run keeps going if the client disconnects only until the next model call (the abort signal stops it).
 */
export function agentStream(req: Request, run: (emit: (ev: AgentEvent) => void, signal: AbortSignal) => Promise<unknown>): Response {
  const enc = new TextEncoder();
  const ac = new AbortController();
  req.signal?.addEventListener("abort", () => ac.abort(), { once: true });
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          closed = true;
        }
      };
      const ping = setInterval(() => write(": ping\n\n"), 15_000);
      try {
        await run((ev) => write(`data: ${JSON.stringify(ev)}\n\n`), ac.signal);
      } catch (e) {
        write(`data: ${JSON.stringify({ type: "error", code: "SERVER_ERROR", message: (e as Error).message?.slice(0, 300) || "error" } satisfies AgentEvent)}\n\n`);
        write(`data: ${JSON.stringify({ type: "done", state: "idle" } satisfies AgentEvent)}\n\n`);
      } finally {
        clearInterval(ping);
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {}
        }
      }
    },
    cancel() {
      closed = true;
      ac.abort();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" },
  });
}
