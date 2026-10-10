import { getTeamContext } from "@/lib/auth/context";
import { TeamSettingsClient } from "./settings-client";

export const metadata = { title: "Team Settings" };

export default async function TeamSettingsPage({ params }: { params: Promise<{ team: string }> }) {
  const { team } = await params;
  const ctx = await getTeamContext(team);
  return <TeamSettingsClient team={{ name: ctx.team.name, slug: ctx.team.slug, isPersonal: ctx.team.isPersonal, id: ctx.team.id }} role={ctx.role} />;
}
