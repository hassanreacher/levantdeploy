import { requireBackendContext } from "@/lib/base-ui/access";
import { BaseFunctionPage } from "@/components/base/pages/functions";

export const metadata = { title: "Backend · Edge Function" };
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ team: string; project: string; slug: string }> }) {
  const { team, project, slug } = await params;
  return <BaseFunctionPage ctx={await requireBackendContext(team, project)} slug={slug} />;
}
