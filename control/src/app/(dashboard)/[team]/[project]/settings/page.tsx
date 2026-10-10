import { getProjectContext } from "@/lib/auth/context";
import { hasRole } from "@/lib/auth/roles";
import { GeneralSettings } from "@/components/dashboard/project-settings";

export const metadata = { title: "Project Settings" };

export default async function GeneralSettingsPage({ params }: { params: Promise<{ team: string; project: string }> }) {
  const { team, project: p } = await params;
  const { project, role } = await getProjectContext(team, p);
  return (
    <GeneralSettings
      project={{ id: project.id, name: project.name, slug: project.slug, description: project.description }}
      canWrite={hasRole(role, "MEMBER")}
      isAdmin={hasRole(role, "ADMIN")}
      platformDomain={(process.env.PLATFORM_DOMAIN || "levant.localhost").toLowerCase()}
    />
  );
}
