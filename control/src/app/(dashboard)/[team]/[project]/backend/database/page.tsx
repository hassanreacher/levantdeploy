import { requireBackendContext } from "@/lib/base-ui/access";
import { BaseDatabasePage } from "@/components/base/pages/database";

export const metadata = { title: "Backend · Database" };
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ team: string; project: string }> }) {
  const { team, project } = await params;
  return <BaseDatabasePage ctx={await requireBackendContext(team, project)} />;
}
