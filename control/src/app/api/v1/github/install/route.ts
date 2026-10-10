import { NextResponse } from "next/server";
import { z } from "zod";
import { route, query, requireTeamRole, E } from "@/lib/http";
import { getGitHubApp, githubWebUrl } from "@/lib/github/config";
import { createFlowState } from "@/lib/github/manifest";

export const dynamic = "force-dynamic";

/** GET /api/v1/github/install?team=<slug> → 302 to github.com/apps/<slug>/installations/new (state ties it to the team). */
export const GET = route(async (req) => {
  const { team } = query(req, z.object({ team: z.string().min(1).max(60) }));
  const access = await requireTeamRole(team, "MEMBER");
  const app = await getGitHubApp();
  if (!app?.slug) throw E.bad("The GitHub App is not configured");
  const state = await createFlowState({ kind: "install", userId: access.user.id, teamSlug: access.team.slug, teamId: access.team.id });
  return NextResponse.redirect(`${githubWebUrl()}/apps/${app.slug}/installations/new?state=${state}`);
});
