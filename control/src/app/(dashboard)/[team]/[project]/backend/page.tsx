import { Database } from "lucide-react";
import { db } from "@/lib/db";
import { hasRole } from "@/lib/auth/roles";
import { getBackendContext, type BasePageContext } from "@/lib/base-ui/access";
import { basePlanSummary } from "@/lib/base-ui/adapters";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { BaseHomePage } from "@/components/base/pages/home";
import { AddBackend } from "@/components/base/add-backend";

export const metadata = { title: "Backend" };
export const dynamic = "force-dynamic";

export default async function BackendPage({ params }: { params: Promise<{ team: string; project: string }> }) {
  const { team, project } = await params;
  const ctx = await getBackendContext(team, project);
  if (ctx.base) return <BaseHomePage ctx={ctx as BasePageContext} />;
  const [candidates, plan] = await Promise.all([
    db.baseProject.findMany({ where: { teamId: ctx.team.id, projectId: null, status: { not: "DELETING" } }, select: { ref: true, name: true, status: true }, orderBy: { createdAt: "desc" } }),
    basePlanSummary(ctx.team.id, ctx.team.slug),
  ]);
  return (
    <>
      <PageHeader
        title="Backend"
        description="A dedicated Postgres database with Auth, an instant REST API, Realtime, Storage and Edge Functions for this project — running on this server."
      />
      <PageBody>
        <div className="mx-auto mb-8 flex max-w-2xl flex-col items-center text-center">
          <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full border border-border bg-surface text-muted">
            <Database className="h-5 w-5" />
          </div>
          <h2 className="text-lg font-semibold tracking-tight">Add a backend to {ctx.project.name}</h2>
          <p className="mt-1 text-[13px] text-muted">Compatible with the Supabase client libraries. Its URL and keys are added to this project&apos;s environment variables automatically.</p>
        </div>
        <AddBackend
          teamSlug={ctx.team.slug}
          project={ctx.project}
          candidates={candidates}
          canUse={hasRole(ctx.role, "MEMBER")}
          isAdmin={hasRole(ctx.role, "ADMIN")}
          plan={plan}
        />
      </PageBody>
    </>
  );
}
