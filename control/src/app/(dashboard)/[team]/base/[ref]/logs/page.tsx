import { standaloneContext } from "@/lib/base-ui/access";
import { BaseLogsPage } from "@/components/base/pages/logs";

export const metadata = { title: "Logs" };
export const dynamic = "force-dynamic";

export default async function Page({ params, searchParams }: { params: Promise<{ team: string; ref: string }>; searchParams: Promise<{ service?: string }> }) {
  const { team, ref } = await params;
  const { service } = await searchParams;
  return <BaseLogsPage ctx={await standaloneContext(team, ref, "logs")} service={service} />;
}
