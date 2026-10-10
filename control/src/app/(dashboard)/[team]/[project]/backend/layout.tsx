import { getBackendContext } from "@/lib/base-ui/access";
import { BaseSubNav } from "@/components/base/common";

/** Backend tab of a Deploy project: Base sub-navigation once a backend is attached. */
export default async function BackendLayout({ children, params }: { children: React.ReactNode; params: Promise<{ team: string; project: string }> }) {
  const { team, project } = await params;
  const ctx = await getBackendContext(team, project);
  return (
    <>
      {ctx.base && <BaseSubNav basePath={`/${ctx.team.slug}/${project}/backend`} />}
      {children}
    </>
  );
}
