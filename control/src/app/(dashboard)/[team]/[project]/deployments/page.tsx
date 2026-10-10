import { getProjectContext } from "@/lib/auth/context";
import { hasRole } from "@/lib/auth/roles";
import { listDeployments, recentBranches } from "@/lib/dashboard/deployments";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { DeploymentsList, type DeploymentsFilter } from "@/components/dashboard/deployments-list";
import { DeployButton } from "@/components/dashboard/project-actions";
import type { DeploymentStatusName } from "@/components/ui/status-dot";

export const metadata = { title: "Deployments" };

const STATUSES = new Set(["QUEUED", "BUILDING", "DEPLOYING", "READY", "ERROR", "CANCELED", "SUPERSEDED"]);

export default async function DeploymentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ team: string; project: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { team, project: pslug } = await params;
  const sp = await searchParams;
  const { project, role, team: t } = await getProjectContext(team, pslug);
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
  const filter: DeploymentsFilter = {
    target: one(sp.target) === "PRODUCTION" || one(sp.target) === "PREVIEW" ? (one(sp.target) as DeploymentsFilter["target"]) : undefined,
    branch: one(sp.branch),
    status: one(sp.status)
      ?.split(",")
      .map((s) => s.toUpperCase())
      .filter((s) => STATUSES.has(s)) as DeploymentStatusName[] | undefined,
    q: one(sp.q),
  };
  const [initial, branches] = await Promise.all([listDeployments(project.id, { ...filter, limit: 20 }), recentBranches(project.id)]);
  const canWrite = hasRole(role, "MEMBER");
  return (
    <>
      <PageHeader
        title="Deployments"
        description={
          <>
            Every build of <span className="text-fg">{project.name}</span>. Continuously generated from{" "}
            <span className="font-mono text-fg">{project.githubRepoFullName ?? project.gitUrl?.replace(/^https?:\/\//, "") ?? "uploads"}</span>.
          </>
        }
        actions={canWrite && project.sourceType !== "UPLOAD" ? <DeployButton projectId={project.id} teamSlug={t.slug} projectSlug={project.slug} branch={project.productionBranch} variant="secondary" /> : null}
      />
      <PageBody>
        <DeploymentsList
          projectId={project.id}
          teamSlug={t.slug}
          projectSlug={project.slug}
          repo={project.githubRepoFullName}
          canWrite={canWrite}
          branches={branches}
          initial={initial}
          initialFilter={filter}
        />
      </PageBody>
    </>
  );
}
