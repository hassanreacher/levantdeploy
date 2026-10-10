import { requireBackendContext } from "@/lib/base-ui/access";
import { BaseFunctionsPage } from "@/components/base/pages/functions";

export const metadata = { title: "Backend · Edge Functions" };
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ team: string; project: string }> }) {
  const { team, project } = await params;
  return <BaseFunctionsPage ctx={await requireBackendContext(team, project)} />;
}
