import { getProjectContext } from "@/lib/auth/context";
import { hasRole } from "@/lib/auth/roles";
import { listChannels } from "@/lib/dashboard/channels";
import { NotificationsManager } from "@/components/dashboard/notifications-manager";

export const metadata = { title: "Notifications" };

export default async function ProjectNotificationsPage({ params }: { params: Promise<{ team: string; project: string }> }) {
  const { team, project: p } = await params;
  const { project, team: t, role } = await getProjectContext(team, p);
  return <NotificationsManager teamSlug={t.slug} projectId={project.id} items={await listChannels(t.id, project.id)} isAdmin={hasRole(role, "ADMIN")} />;
}
