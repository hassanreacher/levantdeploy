import { standaloneContext } from "@/lib/base-ui/access";
import { BaseHomePage } from "@/components/base/pages/home";

export const metadata = { title: "Base project" };
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ team: string; ref: string }> }) {
  const { team, ref } = await params;
  return <BaseHomePage ctx={await standaloneContext(team, ref)} />;
}
