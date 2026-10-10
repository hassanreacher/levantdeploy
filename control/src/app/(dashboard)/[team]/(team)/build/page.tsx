import { Suspense } from "react";
import { getTeamContext } from "@/lib/auth/context";
import { hasRole } from "@/lib/auth/roles";
import { BuildHome } from "@/components/builder/build-home";

export const metadata = { title: "Build" };

/** /{team}/build — AI app Builder home (builder-ui). */
export default async function BuildPage({ params }: { params: Promise<{ team: string }> }) {
  const { team } = await params;
  const ctx = await getTeamContext(team);
  return (
    <Suspense>
      <BuildHome team={ctx.team.slug} canCreate={hasRole(ctx.role, "MEMBER")} />
    </Suspense>
  );
}
