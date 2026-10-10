import { route, json, E } from "@/lib/http";
import { audit } from "@/lib/audit";
import { requireBuilderProject } from "@/lib/builder/agents/http-access";
import { cancelRun, getRunDTO } from "@/lib/builder/agents/runs";

export const dynamic = "force-dynamic";

/** POST /api/v1/builder/projects/:id/runs/:runId/cancel — stop a run (MEMBER). Partial changes stay in the history. */
export const POST = route<{ id: string; runId: string }>(async (_req, { params }) => {
  const { id, runId } = await params;
  const { actor, team } = await requireBuilderProject(id, "MEMBER", "projects:write");
  if (!(await getRunDTO(runId, id))) throw E.notFound("Run not found");
  const run = await cancelRun(runId);
  await audit({ action: "builder.run_cancel", teamId: team.id, actor, targetType: "builder_project", targetId: id, meta: { runId } });
  return json({ run });
});
