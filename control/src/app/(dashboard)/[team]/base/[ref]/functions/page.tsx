import { standaloneContext } from "@/lib/base-ui/access";
import { BaseFunctionsPage } from "@/components/base/pages/functions";

export const metadata = { title: "Edge Functions" };
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ team: string; ref: string }> }) {
  const { team, ref } = await params;
  return <BaseFunctionsPage ctx={await standaloneContext(team, ref, "functions")} />;
}
