import { z } from "zod";
import { route, json, query, E } from "@/lib/http";
import { db } from "@/lib/db";
import { resolveTeam } from "@/lib/git/team";
import { getInstallationToken, getRepo } from "@/lib/github/installations";
import { githubWebUrl } from "@/lib/github/config";
import { detectRemote } from "@/lib/git/detect";

export const dynamic = "force-dynamic";

const q = z.object({
  team: z.string().max(60).optional(),
  installationId: z.coerce.number().int().positive(),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  branch: z.string().max(250).optional(),
  rootDirectory: z.string().max(500).default(""),
});

/** GET /api/v1/github/repos/detect?installationId&repo=owner/name&branch&rootDirectory → { repo, detection } (shallow clone + build detector) */
export const GET = route(
  async (req) => {
    const f = query(req, q);
    const access = await resolveTeam(f.team, "MEMBER", { scope: "projects:read" });
    const inst = await db.gitHubInstallation.findUnique({ where: { installationId: f.installationId } });
    if (!inst || inst.teamId !== access.team.id) throw E.notFound("Installation not found");
    const repo = await getRepo(inst.installationId, f.repo).catch(() => {
      throw E.notFound("Repository not found");
    });
    const token = await getInstallationToken(inst.installationId);
    const detection = await detectRemote(`${githubWebUrl()}/${repo.full_name}.git`, f.branch || repo.default_branch, { kind: "token", token, username: "x-access-token" }, f.rootDirectory);
    return json({ repo: { id: repo.id, fullName: repo.full_name, defaultBranch: repo.default_branch, private: repo.private }, detection });
  },
  { limit: { limit: 30, window: 60 }, key: "detect" },
);
