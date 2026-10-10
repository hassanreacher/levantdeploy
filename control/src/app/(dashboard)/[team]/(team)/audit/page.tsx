import Link from "next/link";
import { ScrollText } from "lucide-react";
import { db } from "@/lib/db";
import { getTeamContext } from "@/lib/auth/context";
import { hasRole } from "@/lib/auth/roles";
import { timeAgo } from "@/lib/utils";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { Code } from "@/components/ui/code-block";

export const metadata = { title: "Audit log" };

export default async function AuditPage({ params, searchParams }: { params: Promise<{ team: string }>; searchParams: Promise<{ cursor?: string }> }) {
  const { team } = await params;
  const { cursor } = await searchParams;
  const ctx = await getTeamContext(team);
  if (!hasRole(ctx.role, "ADMIN")) {
    return (
      <>
        <PageHeader title="Audit log" />
        <PageBody>
          <EmptyState title="Admins only" description="Ask a team admin for access to the audit log." />
        </PageBody>
      </>
    );
  }
  const take = 50;
  const rows = await db.auditLog.findMany({
    where: { teamId: ctx.team.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { user: { select: { name: true, email: true, avatar: true } }, apiToken: { select: { name: true } } },
  });
  const hasMore = rows.length > take;
  const items = rows.slice(0, take);
  return (
    <>
      <PageHeader title="Audit log" description="Every change made in this team, by whom and from where." />
      <PageBody>
        {items.length === 0 ? (
          <EmptyState icon={<ScrollText className="h-5 w-5" />} title="Nothing yet" description="Actions like creating projects, deployments and invites will appear here." />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Action</TH>
                <TH>Actor</TH>
                <TH>Target</TH>
                <TH>IP</TH>
                <TH className="text-right">When</TH>
              </tr>
            </THead>
            <TBody>
              {items.map((r) => (
                <TR key={r.id}>
                  <TD>
                    <Code>{r.action}</Code>
                  </TD>
                  <TD>
                    <span className="flex items-center gap-2">
                      <Avatar name={r.user?.name ?? "system"} src={r.user?.avatar} size={20} />
                      <span className="text-[13px]">{r.user?.name ?? "System"}</span>
                      {r.apiToken && <span className="text-[12px] text-subtle">via token “{r.apiToken.name}”</span>}
                    </span>
                  </TD>
                  <TD className="text-[13px] text-muted">{r.targetType ? `${r.targetType}${r.targetId ? ` · ${r.targetId.slice(0, 10)}` : ""}` : "—"}</TD>
                  <TD className="font-mono text-[12px] text-subtle">{r.ip ?? "—"}</TD>
                  <TD className="text-right text-[13px] text-muted" title={r.createdAt.toISOString()}>
                    {timeAgo(r.createdAt)}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        {hasMore && (
          <div className="mt-4 text-center">
            <Link className="link text-sm" href={`/${ctx.team.slug}/audit?cursor=${items[items.length - 1]!.id}`}>
              Older entries →
            </Link>
          </div>
        )}
      </PageBody>
    </>
  );
}
