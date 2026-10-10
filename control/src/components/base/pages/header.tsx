import type { ReactNode } from "react";
import { PageHeader } from "@/components/shell/page-header";
import type { BasePageContext } from "@/lib/base-ui/access";
import { BaseStatusBadge } from "../common";

/** Page header for Base sub-pages: title + "name · ref · status". */
export function BaseHeader({ ctx, title, actions, description }: { ctx: BasePageContext; title: ReactNode; actions?: ReactNode; description?: ReactNode }) {
  return (
    <PageHeader
      title={title}
      description={
        description ?? (
          <span className="inline-flex flex-wrap items-center gap-2">
            {title !== ctx.base.name && (
              <>
                <span>{ctx.base.name}</span>
                <span className="text-subtle">·</span>
              </>
            )}
            <span className="font-mono text-[12px]">{ctx.base.ref}</span>
            <BaseStatusBadge status={ctx.base.status} />
          </span>
        )
      }
      actions={actions}
    />
  );
}
