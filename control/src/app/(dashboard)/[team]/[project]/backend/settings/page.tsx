import { requireBackendContext } from "@/lib/base-ui/access";
import { BaseSettingsPage } from "@/components/base/pages/settings";

export const metadata = { title: "Backend · Settings" };
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ team: string; project: string }> }) {
  const { team, project } = await params;
  return <BaseSettingsPage ctx={await requireBackendContext(team, project)} />;
}
