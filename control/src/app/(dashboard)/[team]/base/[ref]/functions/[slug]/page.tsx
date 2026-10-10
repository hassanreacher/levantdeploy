import { standaloneContext } from "@/lib/base-ui/access";
import { BaseFunctionPage } from "@/components/base/pages/functions";

export const metadata = { title: "Edge Function" };
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ team: string; ref: string; slug: string }> }) {
  const { team, ref, slug } = await params;
  return <BaseFunctionPage ctx={await standaloneContext(team, ref, `functions/${slug}`)} slug={slug} />;
}
