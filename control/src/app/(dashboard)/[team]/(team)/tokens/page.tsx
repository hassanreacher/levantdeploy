import { db } from "@/lib/db";
import { getTeamContext } from "@/lib/auth/context";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { TokensClient } from "./tokens-client";

export const metadata = { title: "Tokens" };

export default async function TokensPage({ params }: { params: Promise<{ team: string }> }) {
  const { team } = await params;
  const ctx = await getTeamContext(team);
  const tokens = await db.apiToken.findMany({
    where: { userId: ctx.user.id, revokedAt: null, OR: [{ teamId: ctx.team.id }, { teamId: null }] },
    orderBy: { createdAt: "desc" },
  });
  return (
    <>
      <PageHeader title="Tokens" description="Personal API tokens for the levant CLI, CI pipelines and the REST API (Authorization: Bearer …)." />
      <PageBody>
        <TokensClient
          team={ctx.team.slug}
          teamName={ctx.team.name}
          tokens={tokens.map((t) => ({
            id: t.id,
            name: t.name,
            prefix: t.prefix,
            scopes: t.scopes,
            teamScoped: !!t.teamId,
            lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
            expiresAt: t.expiresAt?.toISOString() ?? null,
            createdAt: t.createdAt.toISOString(),
          }))}
        />
      </PageBody>
    </>
  );
}
