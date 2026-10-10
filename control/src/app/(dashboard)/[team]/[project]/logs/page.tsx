import { getProjectContext } from "@/lib/auth/context";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { db } from "@/lib/db";
import { RuntimeLogs } from "./runtime-logs";

export const metadata = { title: "Logs" };
export const dynamic = "force-dynamic";

export default async function LogsPage({ params, searchParams }: { params: Promise<{ team: string; project: string }>; searchParams: Promise<{ deployment?: string }> }) {
  const { team, project } = await params;
  const sp = await searchParams;
  const ctx = await getProjectContext(team, project);
  const deployments = await db.deployment.findMany({
    where: { projectId: ctx.project.id, status: { in: ["READY", "SUPERSEDED", "DEPLOYING", "ERROR"] }, imageTag: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { id: true, number: true, shortId: true, target: true, status: true, branch: true, isCurrentProduction: true, stoppedAt: true, createdAt: true },
  });
  const current = deployments.find((d) => d.id === sp.deployment || d.shortId === sp.deployment) ?? deployments.find((d) => d.isCurrentProduction) ?? deployments[0] ?? null;
  return (
    <>
      <PageHeader title="Logs" description="Live runtime output of your containers (stdout and stderr of every replica)." />
      <PageBody>
        <RuntimeLogs
          deployments={deployments.map((d) => ({ ...d, stoppedAt: d.stoppedAt?.toISOString() ?? null, createdAt: d.createdAt.toISOString() }))}
          initialId={current?.id ?? null}
        />
      </PageBody>
    </>
  );
}
