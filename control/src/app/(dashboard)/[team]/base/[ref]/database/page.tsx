import { standaloneContext } from "@/lib/base-ui/access";
import { BaseDatabasePage } from "@/components/base/pages/database";

export const metadata = { title: "Database" };
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ team: string; ref: string }> }) {
  const { team, ref } = await params;
  return <BaseDatabasePage ctx={await standaloneContext(team, ref, "database")} />;
}
