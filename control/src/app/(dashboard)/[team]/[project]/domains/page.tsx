import { getProjectContext } from "@/lib/auth/context";
import { hasRole } from "@/lib/auth/roles";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { dnsConfig, listDomains } from "@/lib/domains/service";
import { db } from "@/lib/db";
import { DomainsClient } from "./domains-client";

export const metadata = { title: "Domains" };
export const dynamic = "force-dynamic";

export default async function DomainsPage({ params }: { params: Promise<{ team: string; project: string }> }) {
  const { team, project } = await params;
  const ctx = await getProjectContext(team, project);
  const [domains, branches] = await Promise.all([
    listDomains(ctx.project),
    db.deployment.findMany({ where: { projectId: ctx.project.id, branch: { not: null } }, distinct: ["branch"], select: { branch: true }, take: 100 }),
  ]);
  return (
    <>
      <PageHeader title="Domains" description="The free platform domain, custom domains with automatic HTTPS, redirects and branch domains." />
      <PageBody>
        <DomainsClient
          projectId={ctx.project.id}
          productionBranch={ctx.project.productionBranch}
          canEdit={hasRole(ctx.role, "ADMIN")}
          initial={domains}
          config={dnsConfig()}
          branches={branches.map((b) => b.branch!).filter(Boolean)}
        />
      </PageBody>
    </>
  );
}
