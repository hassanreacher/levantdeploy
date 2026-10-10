import { z } from "zod";
import { route, query, requireTeamRole } from "@/lib/http";
import { teamEventsResponse } from "@/lib/dashboard/events";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/teams/:team/events[?projectId=]  — SSE stream of deployment status changes for the team
 * (`event: status`, data = StatusEvent JSON). Used by the dashboard for live lists/detail pages.
 */
export const GET = route<{ team: string }>(async (req, { params }) => {
  const { team } = await params;
  const { projectId } = query(req, z.object({ projectId: z.string().max(64).optional() }));
  const { team: t } = await requireTeamRole(team, "VIEWER", { scope: "deployments:read" });
  return teamEventsResponse(t.id, { signal: req.signal, projectId });
});
