import { db } from "@/lib/db";
import { getTeamContext } from "@/lib/auth/context";
import { hasRole } from "@/lib/auth/roles";
import { listChannels } from "@/lib/dashboard/channels";
import { NotificationsManager } from "@/components/dashboard/notifications-manager";

export const metadata = { title: "Notifications" };

export default async function TeamNotificationsPage({ params }: { params: Promise<{ team: string }> }) {
  const { team } = await params;
  const ctx = await getTeamContext(team);
  const [items, projects] = await Promise.all([listChannels(ctx.team.id), db.project.findMany({ where: { teamId: ctx.team.id }, select: { id: true, name: true }, orderBy: { name: "asc" } })]);
  return <NotificationsManager teamSlug={ctx.team.slug} items={items} projects={projects} isAdmin={hasRole(ctx.role, "ADMIN")} />;
}
