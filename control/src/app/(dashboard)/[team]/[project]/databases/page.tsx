import { getProjectContext } from "@/lib/auth/context";
import { hasRole } from "@/lib/auth/roles";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { db } from "@/lib/db";
import { databaseDTO, ENGINE_OPTIONS } from "@/lib/runtime/database-api";
import { DatabasesClient } from "./databases-client";

export const metadata = { title: "Databases" };
export const dynamic = "force-dynamic";

export default async function DatabasesPage({ params }: { params: Promise<{ team: string; project: string }> }) {
  const { team, project } = await params;
  const ctx = await getProjectContext(team, project);
  const include = { project: { select: { id: true, slug: true, name: true } }, backups: { orderBy: { createdAt: "desc" as const }, take: 1 } };
  const [items, available] = await Promise.all([
    db.database.findMany({ where: { projectId: ctx.project.id }, include, orderBy: { createdAt: "asc" } }),
    db.database.findMany({ where: { teamId: ctx.team.id, OR: [{ projectId: null }, { projectId: { not: ctx.project.id } }] }, include, orderBy: { createdAt: "asc" } }),
  ]);
  return (
    <>
      <PageHeader title="Databases" description="Managed PostgreSQL, MySQL, Redis and MongoDB containers next to your app, with backups." />
      <PageBody>
        <DatabasesClient
          team={ctx.team.slug}
          projectId={ctx.project.id}
          canEdit={hasRole(ctx.role, "ADMIN")}
          initial={items.map(databaseDTO)}
          available={available.map(databaseDTO)}
          engines={ENGINE_OPTIONS}
        />
      </PageBody>
    </>
  );
}
