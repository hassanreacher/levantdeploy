import { platformOverview } from "@/lib/ops/platform";
import { LimitsSettings } from "./limits-client";

export const metadata = { title: "Limits · Platform Settings" };

export default async function PlatformLimitsPage() {
  const o = await platformOverview();
  return <LimitsSettings limits={o.limits} />;
}
