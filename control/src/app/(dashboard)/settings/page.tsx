import { platformOverview, dnsRecords } from "@/lib/ops/platform";
import { GeneralSettings } from "./general-client";

export const metadata = { title: "Platform Settings" };

export default async function PlatformGeneralPage() {
  const o = await platformOverview();
  return <GeneralSettings overview={o} records={dnsRecords(o)} />;
}
