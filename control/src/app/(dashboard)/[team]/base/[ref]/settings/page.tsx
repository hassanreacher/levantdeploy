import { standaloneContext } from "@/lib/base-ui/access";
import { BaseSettingsPage } from "@/components/base/pages/settings";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ team: string; ref: string }> }) {
  const { team, ref } = await params;
  return <BaseSettingsPage ctx={await standaloneContext(team, ref, "settings")} />;
}
