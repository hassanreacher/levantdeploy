import { db } from "@/lib/db";
import { getTeamContext } from "@/lib/auth/context";
import { hasRole } from "@/lib/auth/roles";
import { viewEnv } from "@/lib/dashboard/env-api";
import { EnvGroupsManager } from "@/components/dashboard/env-groups";

export const metadata = { title: "Shared Environment Variables" };

export default async function EnvGroupsPage({ params }: { params: Promise<{ team: string }> }) {
  const { team } = await params;
  const ctx = await getTeamContext(team);
  const groups = await db.sharedEnvGroup.findMany({
    where: { teamId: ctx.team.id },
    orderBy: { name: "asc" },
    include: {
      vars: { orderBy: { key: "asc" }, include: { createdBy: { select: { name: true, avatar: true } } } },
      projects: { include: { project: { select: { id: true, name: true, slug: true } } } },
    },
  });
  return (
    <EnvGroupsManager
      teamSlug={ctx.team.slug}
      isAdmin={hasRole(ctx.role, "ADMIN")}
      groups={groups.map((g) => ({ id: g.id, name: g.name, description: g.description, vars: g.vars.map((v) => viewEnv(v, ctx.role)), projects: g.projects.map((p) => p.project) }))}
    />
  );
}
