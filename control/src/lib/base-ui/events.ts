import { db } from "@/lib/db";
import { eventDTO } from "./dto";

/**
 * SSE stream of a Base project's lifecycle: `event: status` ({status, statusMessage}) whenever it changes and
 * `event: event` (BaseEventDTO) for every new BaseEvent. Backed by DB polling (1.5 s) so it works no matter
 * which process (worker / control) wrote the event. Ends after 30 min (client reconnects).
 */
export function baseEventsResponse(baseProjectId: string, opts: { signal?: AbortSignal; since?: Date | null; backlog?: number } = {}): Response {
  const enc = new TextEncoder();
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {}
      };
      opts.signal?.addEventListener("abort", close);
      send(`retry: 3000\n: connected\n\n`);
      const started = Date.now();
      let lastStatus = "";
      let lastMsg: string | null = "";
      let cursor: { at: Date; id: string } | null = null;
      // backlog
      const backlog = await db.baseEvent.findMany({
        where: { baseProjectId, ...(opts.since ? { createdAt: { gt: opts.since } } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: opts.backlog ?? 50,
      });
      for (const e of backlog.reverse()) {
        send(`event: event\ndata: ${JSON.stringify(eventDTO(e))}\n\n`);
        cursor = { at: e.createdAt, id: e.id };
      }
      let ticks = 0;
      while (!closed && Date.now() - started < 30 * 60_000) {
        const b = await db.baseProject.findUnique({ where: { id: baseProjectId }, select: { status: true, statusMessage: true } }).catch(() => null);
        if (!b) {
          send(`event: status\ndata: ${JSON.stringify({ status: "DELETED", statusMessage: null })}\n\n`);
          break;
        }
        if (b.status !== lastStatus || b.statusMessage !== lastMsg) {
          lastStatus = b.status;
          lastMsg = b.statusMessage;
          send(`event: status\ndata: ${JSON.stringify(b)}\n\n`);
        }
        const fresh = await db.baseEvent
          .findMany({
            where: { baseProjectId, ...(cursor ? { OR: [{ createdAt: { gt: cursor.at } }, { createdAt: cursor.at, id: { gt: cursor.id } }] } : {}) },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: 200,
          })
          .catch(() => []);
        for (const e of fresh) {
          send(`event: event\ndata: ${JSON.stringify(eventDTO(e))}\n\n`);
          cursor = { at: e.createdAt, id: e.id };
        }
        if (++ticks % 10 === 0) send(`: ping\n\n`);
        await new Promise((r) => setTimeout(r, 1500));
      }
      close();
    },
    cancel() {
      closed = true;
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}
