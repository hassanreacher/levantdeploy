import { requireBackendContext } from "@/lib/base-ui/access";
import { BaseAuthPage } from "@/components/base/pages/auth";

export const metadata = { title: "Backend · Authentication" };
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ team: string; project: string }> }) {
  const { team, project } = await params;
  return <BaseAuthPage ctx={await requireBackendContext(team, project)} />;
}
