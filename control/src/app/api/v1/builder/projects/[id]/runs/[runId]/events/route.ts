import { route, E } from "@/lib/http";
import { requireBuilderProject } from "@/lib/builder/agents/http-access";
import { getRunDTO, runEventStream } from "@/lib/builder/agents/runs";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/builder/projects/:id/runs/:runId/events[?after=<seq>] — Server-Sent Events (VIEWER).
 * Replays stored events after `after` / Last-Event-ID, then streams live until the run ends.
 * Each message: `id: <seq>`, `event: <type>`, `data: {seq, type, data, at}`.
 */
export const GET = route<{ id: string; runId: string }>(async (req, { params }) => {
  const { id, runId } = await params;
  await requireBuilderProject(id, "VIEWER", "projects:read");
  if (!(await getRunDTO(runId, id))) throw E.notFound("Run not found");
  const url = new URL(req.url);
  const after = Math.max(0, Number(req.headers.get("last-event-id") ?? url.searchParams.get("after") ?? 0) || 0);
  return runEventStream(runId, after, req.signal);
});
