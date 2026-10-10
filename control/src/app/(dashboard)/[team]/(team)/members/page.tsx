import { db } from "@/lib/db";
import { getTeamContext } from "@/lib/auth/context";
import { hasRole } from "@/lib/auth/roles";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { MembersClient } from "./members-client";

export const metadata = { title: "Members" };

export default async function MembersPage({ params }: { params: Promise<{ team: string }> }) {
  const { team } = await params;
  const ctx = await getTeamContext(team);
  const isAdmin = hasRole(ctx.role, "ADMIN");
  const [members, invites] = await Promise.all([
    db.membership.findMany({ where: { teamId: ctx.team.id }, orderBy: { createdAt: "asc" }, include: { user: { select: { id: true, name: true, email: true, avatar: true } } } }),
    isAdmin
      ? db.invite.findMany({ where: { teamId: ctx.team.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } })
      : Promise.resolve([]),
  ]);
  return (
    <>
      <PageHeader title="Members" description={`People with access to ${ctx.team.name}.`} />
      <PageBody>
        <MembersClient
          team={ctx.team.slug}
          meId={ctx.user.id}
          myRole={ctx.role}
          members={members.map((m) => ({ userId: m.user.id, name: m.user.name, email: m.user.email, avatar: m.user.avatar, role: m.role, joinedAt: m.createdAt.toISOString() }))}
          invites={invites.map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt.toISOString() }))}
        />
      </PageBody>
    </>
  );
}
