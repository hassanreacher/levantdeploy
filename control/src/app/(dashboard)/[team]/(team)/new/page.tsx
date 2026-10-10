import { getTeamContext } from "@/lib/auth/context";
import { hasRole } from "@/lib/auth/roles";
import { PageHeader, PageBody } from "@/components/shell/page-header";
import { gitHubAppStatus } from "@/lib/github/config";
import { teamInstallations } from "@/lib/github/installations";
import { listTemplates } from "@/lib/git/templates";
import { EmptyState } from "@/components/ui";
import { Lock } from "lucide-react";
import { NewProjectClient, type Tab } from "./new-project-client";

export const metadata = { title: "New Project" };
export const dynamic = "force-dynamic";

const TABS: Tab[] = ["github", "git", "upload", "image", "template"];

export default async function NewProjectPage({ params, searchParams }: { params: Promise<{ team: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { team: teamSlug } = await params;
  const sp = await searchParams;
  const { team, role, user } = await getTeamContext(teamSlug);
  if (!hasRole(role, "MEMBER")) {
    return (
      <>
        <PageHeader title="New Project" />
        <PageBody>
          <EmptyState icon={<Lock className="h-5 w-5" />} title="You can't create projects in this team" description="Viewers can browse projects but not create them. Ask a team admin for the member role." />
        </PageBody>
      </>
    );
  }
  const [app, installations] = await Promise.all([gitHubAppStatus(), teamInstallations(team.id)]);
  const templates = listTemplates();
  const tab = TABS.includes(sp.tab as Tab) ? (sp.tab as Tab) : "github";
  return (
    <>
      <PageHeader title="Let's build something new." description="Import a Git repository, upload a folder from your computer, run a Docker image or start from a template." />
      <PageBody>
        <NewProjectClient
          team={{ id: team.id, slug: team.slug, name: team.name }}
          isOwner={user.isPlatformOwner}
          app={app}
          installations={installations.map((i) => ({ installationId: i.installationId, accountLogin: i.accountLogin, accountType: i.accountType, accountAvatar: i.accountAvatar, suspended: !!i.suspendedAt }))}
          templates={templates}
          initialTab={tab}
          initialTemplate={sp.template ?? null}
          flash={sp.github_error ? { tone: "error", text: sp.github_error } : sp.github_installed ? { tone: "success", text: "GitHub App installed — pick a repository to import." } : null}
        />
      </PageBody>
    </>
  );
}
