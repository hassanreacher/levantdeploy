import { db } from "@/lib/db";
import { newRedis } from "@/lib/redis";
import { STATUS_CHANNEL, type StatusEvent } from "@/lib/deployments";

/**
 * Team-wide live events as Server-Sent Events: every deployment status change (STATUS_CHANNEL) of the
 * team's projects. Format:
 *   event: status
 *   data: {"deploymentId","projectId","status","from","at"}
 * plus `: ping` every 15 s. The route handler does the access check.
 */
export function teamEventsResponse(teamId: string, opts: { signal?: AbortSignal; projectId?: string | null } = {}): Response {
  const enc = new TextEncoder();
  let closed = false;
  const sub = newRedis();
  const known = new Map<string, boolean>(); // projectId → belongs to team

  const belongs = async (projectId: string) => {
    if (known.has(projectId)) return known.get(projectId)!;
    const p = await db.project.findUnique({ where: { id: projectId }, select: { teamId: true } });
    const ok = p?.teamId === teamId;
    known.set(projectId, ok);
    return ok;
  };

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
        clearInterval(ping);
        void sub.quit().catch(() => {});
        try {
          controller.close();
        } catch {}
      };
      const ping = setInterval(() => send(`: ping\n\n`), 15_000);
      opts.signal?.addEventListener("abort", close);
      const projects = await db.project.findMany({ where: { teamId }, select: { id: true } });
      for (const p of projects) known.set(p.id, true);
      send(`retry: 3000\n: connected\n\n`);
      sub.on("message", (_ch: string, raw: string) => {
        void (async () => {
          try {
            const ev = JSON.parse(raw) as StatusEvent;
            if (opts.projectId && ev.projectId !== opts.projectId) return;
            if (!(await belongs(ev.projectId))) return;
            send(`event: status\ndata: ${JSON.stringify(ev)}\n\n`);
          } catch {}
        })();
      });
      try {
        await sub.subscribe(STATUS_CHANNEL);
      } catch {
        send(`event: error\ndata: {"message":"live updates unavailable"}\n\n`);
        close();
      }
    },
    cancel() {
      closed = true;
      void sub.quit().catch(() => {});
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
