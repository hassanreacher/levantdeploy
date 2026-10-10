import { route, json, E } from "@/lib/http";
import { requireBuilderProject } from "@/lib/builder/agents/http-access";
import { getRunDTO } from "@/lib/builder/agents/runs";
import { prismaStore } from "@/lib/builder/agents/store";

export const dynamic = "force-dynamic";

/** GET /api/v1/builder/projects/:id/runs/:runId[?events=1&after=<seq>] — run status (+ stored events) (VIEWER). */
export const GET = route<{ id: string; runId: string }>(async (req, { params }) => {
  const { id, runId } = await params;
  await requireBuilderProject(id, "VIEWER", "projects:read");
  const run = await getRunDTO(runId, id);
  if (!run) throw E.notFound("Run not found");
  const url = new URL(req.url);
  if (url.searchParams.get("events") === "1") {
    const after = Math.max(0, Number(url.searchParams.get("after") ?? 0) || 0);
    return json({ run, events: await prismaStore().listEvents(runId, after, 1000) });
  }
  return json({ run });
});
