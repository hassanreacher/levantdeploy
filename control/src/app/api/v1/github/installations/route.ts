import { z } from "zod";
import { route, json, query } from "@/lib/http";
import { resolveTeam } from "@/lib/git/team";
import { teamInstallations } from "@/lib/github/installations";
import { gitHubAppStatus } from "@/lib/github/config";

export const dynamic = "force-dynamic";

/** GET /api/v1/github/installations?team= → { app, items: [{ installationId, accountLogin, accountType, accountAvatar, … }] } */
export const GET = route(async (req) => {
  const { team } = query(req, z.object({ team: z.string().max(60).optional() }));
  const access = await resolveTeam(team, "VIEWER", { scope: "projects:read" });
  const rows = await teamInstallations(access.team.id);
  return json({
    app: await gitHubAppStatus(),
    items: rows.map((r) => ({
      id: r.id,
      installationId: r.installationId,
      accountLogin: r.accountLogin,
      accountType: r.accountType,
      accountAvatar: r.accountAvatar,
      repositorySelection: r.repositorySelection,
      suspended: !!r.suspendedAt,
    })),
  });
});
