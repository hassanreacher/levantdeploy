import { z } from "zod";
import { route, query, requireProjectRole } from "@/lib/http";
import { readLogs } from "@/lib/logs";
import { stripAnsi } from "@/lib/ansi";
import { findDeployment } from "@/lib/runtime/api";
import { filterLogLines } from "@/lib/runtime/log-filter";

export const dynamic = "force-dynamic";

const q = z.object({
  level: z.enum(["all", "error", "warn", "info", "debug"]).default("all"),
  q: z.string().max(200).optional(),
  replica: z.string().max(40).optional(),
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
});

/**
 * GET /api/v1/deployments/:id/runtime-logs?level=&q=&replica=&since=&until=  → text/plain download (filtered)
 * Live tail: GET /api/v1/deployments/:id/logs?stream=RUNTIME (SSE, foundation).
 */
export const GET = route<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const f = query(req, q);
  const d = await findDeployment(id);
  await requireProjectRole(d.projectId, "VIEWER", { scope: "logs:read" });
  const out: string[] = [];
  let from: string | undefined;
  for (let i = 0; i < 100; i++) {
    const page = await readLogs(d.id, "RUNTIME", { from, limit: 5000 });
    for (const l of filterLogLines(page.lines, f)) out.push(`${new Date(l.ts).toISOString()} ${stripAnsi(l.line)}`);
    if (page.lines.length < 5000 || !page.next) break;
    from = page.next;
  }
  return new Response(out.join("\n") + "\n", {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="${d.project.slug}-${d.shortId}-runtime.log"`,
      "cache-control": "no-store",
    },
  });
});
