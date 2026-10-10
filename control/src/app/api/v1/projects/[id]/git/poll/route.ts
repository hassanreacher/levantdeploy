import { route, json, requireProjectRole, E } from "@/lib/http";
import { pollProject } from "@/lib/git/polling";

export const dynamic = "force-dynamic";

/** POST /api/v1/projects/:id/git/poll — check the remote for new commits now (generic Git projects). */
export const POST = route<{ id: string }>(
  async (_req, { params }) => {
    const { id } = await params;
    const { project } = await requireProjectRole(id, "MEMBER", { scope: "deployments:write" });
    if (project.sourceType !== "GIT") throw E.bad("Polling is only available for Git URL projects");
    return json(await pollProject(project.id));
  },
  { limit: { limit: 20, window: 60 }, key: "git-poll" },
);
