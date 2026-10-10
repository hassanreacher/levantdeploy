import { getProjectContext } from "@/lib/auth/context";
import { hasRole } from "@/lib/auth/roles";
import { BuildSettingsForm } from "@/components/project/BuildSettingsForm";

export const metadata = { title: "Build & Development Settings" };

/** Build area's form (framework preset, commands, root directory, Dockerfile, build cache). */
export default async function BuildSettingsPage({ params }: { params: Promise<{ team: string; project: string }> }) {
  const { team, project: p } = await params;
  const { project, role } = await getProjectContext(team, p);
  return <BuildSettingsForm projectId={project.id} canEdit={hasRole(role, "MEMBER")} />;
}
