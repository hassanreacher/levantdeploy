import { Lock } from "lucide-react";
import { hasRole } from "@/lib/auth/roles";
import type { BasePageContext } from "@/lib/base-ui/access";
import { authSettingsView } from "@/lib/base-ui/settings";
import { EmptyState } from "@/components/ui/empty-state";
import { PageBody } from "@/components/shell/page-header";
import { BaseHeader } from "./header";
import { AuthSettingsClient } from "../auth-client";

export function BaseAuthPage({ ctx }: { ctx: BasePageContext }) {
  const canSee = hasRole(ctx.role, "MEMBER");
  return (
    <>
      <BaseHeader ctx={ctx} title="Authentication" />
      <PageBody>
        {canSee ? (
          <AuthSettingsClient refId={ctx.base.ref} apiUrl={ctx.base.apiUrl} initial={authSettingsView(ctx.row.settings)} canEdit={hasRole(ctx.role, "ADMIN")} />
        ) : (
          <EmptyState icon={<Lock className="h-5 w-5" />} title="Members only" description="Authentication settings are visible to members and editable by admins." />
        )}
      </PageBody>
    </>
  );
}
