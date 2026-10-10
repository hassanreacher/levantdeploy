import { z } from "zod";
import { route, json, query, requireProjectRole, E } from "@/lib/http";
import { db } from "@/lib/db";
import { logStreamResponse, readLogs } from "@/lib/logs";

export const dynamic = "force-dynamic";

const q = z.object({
  stream: z.enum(["BUILD", "RUNTIME"]).default("BUILD"),
  /** "json" → paginated JSON (readLogs); default SSE */
  format: z.enum(["sse", "json"]).default("sse"),
  from: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(10_000).optional(),
  follow: z.enum(["0", "1"]).default("1"),
});

/**
 * GET /api/v1/deployments/:id/logs?stream=BUILD|RUNTIME[&format=json&from=<id>&limit=]
 * SSE by default (resumes from Last-Event-ID). Works with session cookies and API tokens (scope logs:read).
 */
export const GET = route<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const opts = query(req, q);
  const dep = await db.deployment.findUnique({ where: { id }, select: { id: true, projectId: true } });
  if (!dep) throw E.notFound("Deployment not found");
  await requireProjectRole(dep.projectId, "VIEWER", { scope: "logs:read" });
  if (opts.format === "json") return json(await readLogs(dep.id, opts.stream, { from: opts.from, limit: opts.limit }));
  const from = req.headers.get("last-event-id") || opts.from || null;
  return logStreamResponse(dep.id, opts.stream, { signal: req.signal, from, follow: opts.follow === "1" });
});
