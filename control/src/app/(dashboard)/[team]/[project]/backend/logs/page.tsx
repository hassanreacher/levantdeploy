import { requireBackendContext } from "@/lib/base-ui/access";
import { BaseLogsPage } from "@/components/base/pages/logs";

export const metadata = { title: "Backend · Logs" };
export const dynamic = "force-dynamic";

export default async function Page({ params, searchParams }: { params: Promise<{ team: string; project: string }>; searchParams: Promise<{ service?: string }> }) {
  const { team, project } = await params;
  const { service } = await searchParams;
  return <BaseLogsPage ctx={await requireBackendContext(team, project)} service={service} />;
}
