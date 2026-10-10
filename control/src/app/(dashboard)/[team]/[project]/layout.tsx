import { getProjectContext } from "@/lib/auth/context";
import { TopNav } from "@/components/shell/top-nav";
import { SubNav } from "@/components/shell/sub-nav";
import { projectTabs } from "@/components/shell/nav";

export default async function ProjectLayout({ children, params }: { children: React.ReactNode; params: Promise<{ team: string; project: string }> }) {
  const { team, project } = await params;
  const ctx = await getProjectContext(team, project);
  return (
    <div className="min-h-screen">
      <TopNav ctx={ctx} project={ctx.project} />
      <SubNav tabs={projectTabs(ctx.team.slug, ctx.project.slug)} />
      <main>{children}</main>
    </div>
  );
}
