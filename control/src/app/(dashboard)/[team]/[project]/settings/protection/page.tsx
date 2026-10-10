import { getProjectContext } from "@/lib/auth/context";
import { hasRole } from "@/lib/auth/roles";
import { publicProtection } from "@/lib/dashboard/protection";
import { ProtectionSettings } from "@/components/dashboard/project-settings";

export const metadata = { title: "Deployment Protection" };

export default async function ProtectionPage({ params }: { params: Promise<{ team: string; project: string }> }) {
  const { team, project: p } = await params;
  const { project, role } = await getProjectContext(team, p);
  return <ProtectionSettings projectId={project.id} value={publicProtection(project.protection)} isAdmin={hasRole(role, "ADMIN")} />;
}
