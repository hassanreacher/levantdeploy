import { getProjectContext } from "@/lib/auth/context";
import { hasRole } from "@/lib/auth/roles";
import { DangerZone } from "@/components/dashboard/project-settings";
import { db } from "@/lib/db";

export const metadata = { title: "Danger Zone" };

export default async function DangerZonePage({ params }: { params: Promise<{ team: string; project: string }> }) {
  const { team, project: p } = await params;
  const { project, team: t, role, teams } = await getProjectContext(team, p);
  const backend = await db.baseProject.findUnique({ where: { projectId: project.id }, select: { ref: true, name: true } }); // base-dashboard: keep/delete choice
  return (
    <DangerZone
      project={{ id: project.id, name: project.name, slug: project.slug }}
      teamSlug={t.slug}
      backend={backend}
      isAdmin={hasRole(role, "ADMIN")}
      teams={teams.filter((x) => x.id !== t.id && hasRole(x.role, "ADMIN")).map((x) => ({ slug: x.slug, name: x.name }))}
    />
  );
}
