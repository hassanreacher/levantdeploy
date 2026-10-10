import type { BasePageContext } from "@/lib/base-ui/access";
import { usageFor } from "@/lib/base-ui/usage";
import { PageBody } from "@/components/shell/page-header";
import { BaseHeader } from "./header";
import { UsageView } from "../usage-view";

export async function BaseUsagePage({ ctx }: { ctx: BasePageContext }) {
  const u = await usageFor(ctx.row, ctx.team.id);
  return (
    <>
      <BaseHeader ctx={ctx} title="Usage" />
      <PageBody>
        <UsageView usage={u} teamSlug={ctx.team.slug} />
      </PageBody>
    </>
  );
}
