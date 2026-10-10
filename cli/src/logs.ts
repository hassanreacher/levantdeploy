import type { Client } from "./api.js";

export type LogLine = { id: string; ts: number; line: string };

/**
 * Streams a deployment log over SSE (`GET /api/v1/deployments/:id/logs?stream=BUILD|RUNTIME`).
 * Resolves when the server sends `event: end` (or when `follow` is false and the backlog is read).
 * Reconnects with Last-Event-ID on network errors.
 */
export async function streamLogs(client: Client, deploymentId: string, opts: { stream?: "BUILD" | "RUNTIME"; follow?: boolean; onLine: (l: LogLine) => void; signal?: AbortSignal }): Promise<void> {
  let lastId: string | null = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    const url = new URL(`${client.server}/api/v1/deployments/${deploymentId}/logs`);
    url.searchParams.set("stream", opts.stream ?? "BUILD");
    if (opts.follow === false) url.searchParams.set("follow", "0");
    if (lastId) url.searchParams.set("from", lastId);
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${client.token}`, accept: "text/event-stream", ...(lastId ? { "last-event-id": lastId } : {}) }, signal: opts.signal });
      if (!res.ok || !res.body) throw Object.assign(new Error(`logs: HTTP ${res.status}`), { fatal: res.status >= 400 && res.status < 500 });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = "message";
          let data = "";
          let id: string | null = null;
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) continue;
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trimStart();
            else if (line.startsWith("id:")) id = line.slice(3).trim();
          }
          if (event === "end") return;
          if (event === "message" && data) {
            try {
              const l = JSON.parse(data) as LogLine;
              lastId = id ?? l.id ?? lastId;
              opts.onLine(l);
            } catch {}
          }
        }
      }
      if (opts.follow === false) return;
    } catch (e) {
      if (opts.signal?.aborted) return;
      if ((e as { fatal?: boolean }).fatal) throw e;
      await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 10_000)));
    }
  }
}
