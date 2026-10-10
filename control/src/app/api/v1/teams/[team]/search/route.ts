import { z } from "zod";
import { route, json, query, requireTeamRole } from "@/lib/http";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** GET /api/v1/teams/:team/search?q= → { projects, deployments } (command palette) */
export const GET = route<{ team: string }>(async (req, { params }) => {
  const { team } = await params;
  const { q } = query(req, z.object({ q: z.string().trim().min(1).max(100) }));
  const { team: t } = await requireTeamRole(team, "VIEWER", { scope: "projects:read" });
  const lower = q.toLowerCase().replace(/^#/, "");
  const [projects, deployments] = await Promise.all([
    db.project.findMany({
      where: { teamId: t.id, OR: [{ name: { contains: q, mode: "insensitive" } }, { slug: { contains: lower } }, { githubRepoFullName: { contains: q, mode: "insensitive" } }] },
      select: { id: true, name: true, slug: true },
      take: 8,
    }),
    db.deployment.findMany({
      where: {
        project: { teamId: t.id },
        OR: [
          { shortId: { startsWith: lower } },
          { commitSha: { startsWith: lower } },
          { url: { contains: lower } },
          { commitMessage: { contains: q, mode: "insensitive" } },
          { branch: { contains: q, mode: "insensitive" } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, shortId: true, number: true, status: true, target: true, branch: true, commitMessage: true, project: { select: { slug: true, name: true } } },
    }),
  ]);
  const items = [
    ...projects.map((p) => ({ id: `sp:${p.id}`, label: p.name, group: "Projects", href: `/${t.slug}/${p.slug}` })),
    ...deployments.map((d) => ({
      id: `sd:${d.id}`,
      label: `${d.project.name} #${d.number} · ${d.commitMessage?.split("\n")[0]?.slice(0, 60) ?? d.branch ?? d.shortId}`,
      group: "Deployments",
      hint: `${d.shortId} · ${d.status.toLowerCase()}`,
      keywords: `${d.shortId} ${d.branch ?? ""}`,
      href: `/${t.slug}/${d.project.slug}/deployments/${d.id}`,
    })),
  ];
  return json({ projects, deployments, items });
});
