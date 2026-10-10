import { redirect } from "next/navigation";
import { getTeamContext } from "@/lib/auth/context";
import { hasRole } from "@/lib/auth/roles";
import { basePlanSummary } from "@/lib/base-ui/adapters";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { CreateBaseForm } from "@/components/base/create-form";

export const metadata = { title: "New Base project" };
export const dynamic = "force-dynamic";

export default async function NewBasePage({ params }: { params: Promise<{ team: string }> }) {
  const { team } = await params;
  const ctx = await getTeamContext(team);
  if (!hasRole(ctx.role, "MEMBER")) redirect(`/${ctx.team.slug}/base`);
  const plan = await basePlanSummary(ctx.team.id, ctx.team.slug);
  return (
    <>
      <PageHeader title="New Base project" description="A standalone backend. To give a Deploy project its own backend, use the project's Backend tab instead." />
      <PageBody>
        <div className="max-w-2xl">
          <CreateBaseForm teamSlug={ctx.team.slug} isAdmin={hasRole(ctx.role, "ADMIN")} plan={plan} />
        </div>
      </PageBody>
    </>
  );
}
