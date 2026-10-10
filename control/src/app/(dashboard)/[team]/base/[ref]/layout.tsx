import { Database } from "lucide-react";
import { getBaseContext } from "@/lib/base-ui/access";
import { TopNav } from "@/components/shell/top-nav";
import { BaseSubNav } from "@/components/base/common";

/** Standalone Base project (not attached to a Deploy project): /{team}/base/{ref}/… */
export default async function BaseProjectLayout({ children, params }: { children: React.ReactNode; params: Promise<{ team: string; ref: string }> }) {
  const { team, ref } = await params;
  const ctx = await getBaseContext(team, ref);
  return (
    <div className="min-h-screen">
      <TopNav
        ctx={ctx}
        extraCrumbs={[
          { label: "Base", href: `/${ctx.team.slug}/base` },
          { label: ctx.base.name, href: ctx.basePath, icon: <Database className="h-4 w-4 text-muted" /> },
        ]}
      />
      <BaseSubNav basePath={ctx.basePath} sticky />
      <main>{children}</main>
    </div>
  );
}
