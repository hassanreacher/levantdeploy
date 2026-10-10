import { getProjectContext } from "@/lib/auth/context";
import { hasRole } from "@/lib/auth/roles";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { db } from "@/lib/db";
import { cronDTO } from "@/lib/runtime/cron-api";
import { CronClient } from "./cron-client";

export const metadata = { title: "Cron" };
export const dynamic = "force-dynamic";

export default async function CronPage({ params }: { params: Promise<{ team: string; project: string }> }) {
  const { team, project } = await params;
  const ctx = await getProjectContext(team, project);
  const jobs = await db.cronJob.findMany({ where: { projectId: ctx.project.id }, orderBy: { createdAt: "asc" } });
  const hasProd = !!(await db.deployment.findFirst({ where: { projectId: ctx.project.id, isCurrentProduction: true }, select: { id: true } }));
  return (
    <>
      <PageHeader title="Cron" description="Scheduled jobs: a command in a one-off container of the production image, or an HTTP GET on your app." />
      <PageBody>
        <CronClient projectId={ctx.project.id} canEdit={hasRole(ctx.role, "MEMBER")} initial={jobs.map(cronDTO)} hasProduction={hasProd} />
      </PageBody>
    </>
  );
}
