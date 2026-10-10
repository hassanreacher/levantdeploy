import { Lock } from "lucide-react";
import { db } from "@/lib/db";
import { hasRole } from "@/lib/auth/roles";
import type { BasePageContext } from "@/lib/base-ui/access";
import { baseLimits, connectionStrings, internalUrl } from "@/lib/base-ui/adapters";
import { backupDTO } from "@/lib/base-ui/dto";
import { PUBLIC_PORT_SUPPORTED, maskConnString, type ConnectionInfoDTO } from "@/lib/base-ui/shared";
import { EmptyState } from "@/components/ui/empty-state";
import { PageBody } from "@/components/shell/page-header";
import { BaseHeader } from "./header";
import { BackupsCard, ConnectionCard } from "../database-client";
import { OpenStudioButton } from "../home-client";

export async function BaseDatabasePage({ ctx }: { ctx: BasePageContext }) {
  const { base, role } = ctx;
  const canUse = hasRole(role, "MEMBER");
  const isAdmin = hasRole(role, "ADMIN");
  const running = base.status === "ACTIVE";
  if (!canUse) {
    return (
      <>
        <BaseHeader ctx={ctx} title="Database" />
        <PageBody>
          <EmptyState icon={<Lock className="h-5 w-5" />} title="Members only" description="Connection details and backups are available to team members with the member role or higher." />
        </PageBody>
      </>
    );
  }
  const [c, limits, backups] = await Promise.all([
    connectionStrings(base.ref).catch(() => null),
    baseLimits(ctx.team.id),
    db.baseBackup.findMany({ where: { baseProjectId: base.id }, orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  const users = await db.user.findMany({ where: { id: { in: backups.map((b) => b.createdById).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  const names = new Map(users.map((u) => [u.id, u.name]));
  const info: ConnectionInfoDTO | null = c
    ? {
        host: c.host,
        port: c.port,
        database: c.database,
        user: c.pooler ? c.poolerUser : c.user,
        direct: maskConnString(c.direct),
        pooler: c.pooler ? maskConnString(c.pooler) : null,
        poolerSession: c.poolerSession ? maskConnString(c.poolerSession) : null,
        sslRequired: c.sslRequired,
        publicHost: c.publicHost,
        publicUrl: c.public ? maskConnString(c.public) : null,
        publicPort: c.publicPort,
        publicAllowed: limits.publicPort,
        publicSupported: PUBLIC_PORT_SUPPORTED,
      }
    : null;
  return (
    <>
      <BaseHeader ctx={ctx} title="Database" actions={<OpenStudioButton refId={base.ref} disabled={!running} variant="secondary" />} />
      <PageBody>
        <div className="max-w-4xl space-y-6">
        {info ? (
          <ConnectionCard refId={base.ref} initial={info} isAdmin={isAdmin} internalApiUrl={internalUrl(base.ref)} running={running} />
        ) : (
          <EmptyState title="Connection details unavailable" description="They appear once the project is provisioned." />
        )}
        <BackupsCard
          refId={base.ref}
          name={base.name}
          initial={backups.map((b) => backupDTO({ ...b, createdBy: b.createdById ? (names.get(b.createdById) ?? null) : null }))}
          isAdmin={isAdmin}
          running={running}
          backupsKept={limits.backupsKept}
        />
        </div>
      </PageBody>
    </>
  );
}
