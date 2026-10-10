import { standaloneContext } from "@/lib/base-ui/access";
import { BaseAuthPage } from "@/components/base/pages/auth";

export const metadata = { title: "Authentication" };
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ team: string; ref: string }> }) {
  const { team, ref } = await params;
  return <BaseAuthPage ctx={await standaloneContext(team, ref, "auth")} />;
}
