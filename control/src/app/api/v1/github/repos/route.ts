import { z } from "zod";
import { route, json, query, E } from "@/lib/http";
import { db } from "@/lib/db";
import { resolveTeam } from "@/lib/git/team";
import { listInstallationRepos } from "@/lib/github/installations";

export const dynamic = "force-dynamic";

const q = z.object({
  team: z.string().max(60).optional(),
  installationId: z.coerce.number().int().positive(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  fresh: z.enum(["0", "1"]).optional(),
});

/** GET /api/v1/github/repos?installationId&q → { items: [{ id, fullName, private, defaultBranch, pushedAt, imported: [{projectId, slug}] }] } */
export const GET = route(async (req) => {
  const f = query(req, q);
  const access = await resolveTeam(f.team, "MEMBER", { scope: "projects:read" });
  const inst = await db.gitHubInstallation.findUnique({ where: { installationId: f.installationId } });
  if (!inst || inst.teamId !== access.team.id) throw E.notFound("Installation not found");
  const repos = await listInstallationRepos(inst.installationId, { q: f.q, limit: f.limit, fresh: f.fresh === "1" }).catch((e) => {
    throw E.unavailable(`GitHub: ${(e as Error).message}`);
  });
  const existing = await db.project.findMany({
    where: { teamId: access.team.id, githubRepoId: { in: repos.map((r) => BigInt(r.id)) } },
    select: { id: true, slug: true, githubRepoId: true },
  });
  return json({
    items: repos.map((r) => ({
      id: r.id,
      name: r.name,
      fullName: r.full_name,
      owner: r.owner.login,
      ownerAvatar: r.owner.avatar_url ?? null,
      private: r.private,
      defaultBranch: r.default_branch,
      pushedAt: r.pushed_at,
      description: r.description,
      language: r.language ?? null,
      htmlUrl: r.html_url,
      imported: existing.filter((p) => p.githubRepoId === BigInt(r.id)).map((p) => ({ projectId: p.id, slug: p.slug })),
    })),
  });
});
