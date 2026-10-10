import { db } from "@/lib/db";
import { getProjectContext } from "@/lib/auth/context";
import { toDTO } from "@/lib/dashboard/deployments";
import { envChangedSinceDeploy, listEnv, viewEnv } from "@/lib/dashboard/env-api";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { EnvVarsManager } from "@/components/dashboard/env-vars";
import { ConnectBaseCard } from "@/components/base/connect-card";
import { hasRole } from "@/lib/auth/roles";
import { connectionStrings } from "@/lib/base-ui/adapters";

export const metadata = { title: "Environment Variables" };

export default async function EnvironmentPage({ params }: { params: Promise<{ team: string; project: string }> }) {
  const { team, project: pslug } = await params;
  const { project, role, team: t } = await getProjectContext(team, pslug);
  const [rows, links, groups, pending, prod, bases] = await Promise.all([
    listEnv({ projectId: project.id }),
    db.projectSharedEnvGroup.findMany({ where: { projectId: project.id }, include: { group: { include: { _count: { select: { vars: true } } } } } }),
    db.sharedEnvGroup.findMany({ where: { teamId: t.id }, orderBy: { name: "asc" }, include: { _count: { select: { vars: true } } } }),
    envChangedSinceDeploy(project.id),
    db.deployment.findFirst({ where: { projectId: project.id, isCurrentProduction: true } }),
    // base-dashboard area: "Connect a Base project"
    db.baseProject.findMany({ where: { teamId: t.id, status: { not: "DELETING" } }, select: { ref: true, name: true, status: true, projectId: true, dbPublicPort: true, project: { select: { name: true } } }, orderBy: { createdAt: "desc" } }),
  ]);
  // DATABASE_URL is offered when the backend's pooler is reachable from apps (plan)
  const poolers = await Promise.all(bases.map((b) => (b.status === "DELETING" ? null : connectionStrings(b.ref).then((c) => !!c.pooler).catch(() => false))));
  const g = (x: (typeof groups)[number]) => ({ id: x.id, name: x.name, description: x.description, varCount: x._count.vars });
  return (
    <>
      <PageHeader
        title="Environment Variables"
        description="Configure values per environment — Production, Preview (optionally per branch) and Development (levant env pull). Changes apply to new deployments."
      />
      <PageBody className="space-y-8">
        <EnvVarsManager
          projectId={project.id}
          teamSlug={t.slug}
          projectSlug={project.slug}
          items={rows.map((r) => viewEnv(r, role))}
          linkedGroups={links.map((l) => g(l.group))}
          teamGroups={groups.map(g)}
          pending={pending}
          production={prod ? toDTO(prod) : null}
          role={role}
        />
        {hasRole(role, "MEMBER") && (
          <ConnectBaseCard
            projectId={project.id}
            teamSlug={t.slug}
            projectSlug={project.slug}
            bases={bases.map((b, i) => ({ ref: b.ref, name: b.name, status: b.status, attachedTo: b.projectId && b.projectId !== project.id ? (b.project?.name ?? null) : null, dbUrl: !!poolers[i] }))}
            attachedRef={bases.find((b) => b.projectId === project.id)?.ref ?? null}
            canWrite={hasRole(role, "MEMBER")}
            isAdmin={hasRole(role, "ADMIN")}
          />
        )}
      </PageBody>
    </>
  );
}
