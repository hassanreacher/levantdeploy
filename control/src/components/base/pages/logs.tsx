import type { BasePageContext } from "@/lib/base-ui/access";
import { PageBody } from "@/components/shell/page-header";
import { BaseHeader } from "./header";
import { BaseLogsClient } from "../logs-client";

export function BaseLogsPage({ ctx, service }: { ctx: BasePageContext; service?: string }) {
  return (
    <>
      <BaseHeader ctx={ctx} title="Logs" />
      <PageBody>
        <BaseLogsClient refId={ctx.base.ref} initialService={service} paused={ctx.base.status === "PAUSED"} />
      </PageBody>
    </>
  );
}
