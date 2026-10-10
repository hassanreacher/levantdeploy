import { db } from "@/lib/db";
import { hasRole } from "@/lib/auth/roles";
import type { BasePageContext } from "@/lib/base-ui/access";
import { availableVersions } from "@/lib/base-ui/adapters";
import { readStored } from "@/lib/base-ui/settings";
import { dnsInstructions } from "@/lib/domains/verify";
import { PageBody } from "@/components/shell/page-header";
import { BaseHeader } from "./header";
import { BaseSettingsClient } from "../settings-client";

export async function BaseSettingsPage({ ctx }: { ctx: BasePageContext }) {
  const { base, role } = ctx;
  const adminTeams = ctx.teams.filter((t) => t.id !== ctx.team.id && (t.role === "ADMIN" || t.role === "OWNER"));
  const [projects, versions] = await Promise.all([
    db.project.findMany({ where: { teamId: ctx.team.id, baseProject: null }, select: { id: true, slug: true, name: true }, orderBy: { name: "asc" } }),
    availableVersions(base.ref).catch(() => ({ current: base.versions, latest: {}, upgradeAvailable: false })),
  ]);
  const c = readStored(ctx.row.settings).customDomain;
  const domain = c ? { hostname: c.hostname, status: c.status, lastError: c.lastError ?? null, records: dnsInstructions({ hostname: c.hostname, verifyToken: c.verifyToken }) } : null;
  return (
    <>
      <BaseHeader ctx={ctx} title="Settings" />
      <PageBody>
        <BaseSettingsClient
          base={base}
          teamSlug={ctx.team.slug}
          isAdmin={hasRole(role, "ADMIN")}
          canUse={hasRole(role, "MEMBER")}
          transferTeams={adminTeams.map((t) => ({ slug: t.slug, name: t.name }))}
          attachable={projects}
          domain={domain}
          versions={{ current: Object.keys(versions.current).length ? versions.current : base.versions, latest: versions.latest, upgradeAvailable: versions.upgradeAvailable }}
          standalonePath={`/${ctx.team.slug}/base/${base.ref}/settings`}
        />
      </PageBody>
    </>
  );
}
