import { getProjectContext } from "@/lib/auth/context";
import { hasRole } from "@/lib/auth/roles";
import { GitSettings } from "@/components/project/GitSettings";

export const metadata = { title: "Git Settings" };

export default async function GitSettingsPage({ params }: { params: Promise<{ team: string; project: string }> }) {
  const { team, project: p } = await params;
  const { project, team: t, role } = await getProjectContext(team, p);
  return <GitSettings projectId={project.id} teamSlug={t.slug} canEdit={hasRole(role, "ADMIN")} />;
}
