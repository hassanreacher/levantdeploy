import { getTeamContext } from "@/lib/auth/context";
import { TopNav } from "@/components/shell/top-nav";
import { SubNav } from "@/components/shell/sub-nav";
import { teamTabs } from "@/components/shell/nav";

export default async function TeamPagesLayout({ children, params }: { children: React.ReactNode; params: Promise<{ team: string }> }) {
  const { team } = await params;
  const ctx = await getTeamContext(team);
  return (
    <div className="min-h-screen">
      <TopNav ctx={ctx} />
      <SubNav tabs={teamTabs(ctx.team.slug)} />
      <main>{children}</main>
    </div>
  );
}
