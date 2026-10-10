import { requireBackendContext } from "@/lib/base-ui/access";
import { BaseUsagePage } from "@/components/base/pages/usage";

export const metadata = { title: "Backend · Usage" };
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ team: string; project: string }> }) {
  const { team, project } = await params;
  return <BaseUsagePage ctx={await requireBackendContext(team, project)} />;
}
