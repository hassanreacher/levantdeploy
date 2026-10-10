import { standaloneContext } from "@/lib/base-ui/access";
import { BaseUsagePage } from "@/components/base/pages/usage";

export const metadata = { title: "Usage" };
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ team: string; ref: string }> }) {
  const { team, ref } = await params;
  return <BaseUsagePage ctx={await standaloneContext(team, ref, "usage")} />;
}
