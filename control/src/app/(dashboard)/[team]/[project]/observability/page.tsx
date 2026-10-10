import { getProjectContext } from "@/lib/auth/context";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { querySeries } from "@/lib/runtime/metrics";
import { Observability } from "./observability-client";

export const metadata = { title: "Observability" };
export const dynamic = "force-dynamic";

export default async function ObservabilityPage({ params }: { params: Promise<{ team: string; project: string }> }) {
  const { team, project } = await params;
  const ctx = await getProjectContext(team, project);
  const initial = await querySeries(ctx.project.id, "1h");
  return (
    <>
      <PageHeader title="Observability" description="Traffic, errors and latency from the edge proxy, CPU and memory of your containers." />
      <PageBody>
        <Observability projectId={ctx.project.id} initial={initial} />
      </PageBody>
    </>
  );
}
