import { gitHubAppStatus } from "@/lib/github/config";
import { requireUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { GitHubAppCard } from "@/components/github/GitHubAppCard";
import { Card, CardBody, CardHeader, Code } from "@/components/ui";
import { appUrl } from "@/lib/env";

export const metadata = { title: "GitHub – Platform Settings" };
export const dynamic = "force-dynamic";

/** Platform Settings → GitHub (git+cli area): the GitHub App used for imports, push deploys, PR previews and comments. */
export default async function GitHubSettingsPage() {
  const user = await requireUser("/settings/github");
  const status = await gitHubAppStatus();
  const installs = await db.gitHubInstallation.findMany({ include: { team: { select: { slug: true, name: true } } }, orderBy: { createdAt: "asc" } });
  return (
    <>
      <GitHubAppCard status={status} isOwner={user.isPlatformOwner} />
      <Card>
        <CardHeader title="Installations" description="GitHub accounts and organizations that installed the app, and the team they deploy into." />
        <CardBody>
          {installs.length === 0 ? (
            <p className="text-sm text-muted">No installations yet. Teams install the app from New Project → Import Git Repository.</p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border text-sm">
              {installs.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <span className="font-medium text-fg">
                    {i.accountLogin} <span className="font-normal text-muted">({i.accountType})</span>
                  </span>
                  <span className="text-[13px] text-muted">{i.team ? `→ ${i.team.name}` : "not linked to a team"}{i.suspendedAt ? " · suspended" : ""}</span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Webhook endpoint" description="Configured automatically by the manifest flow." />
        <CardBody>
          <Code>{appUrl("/api/v1/webhooks/github")}</Code>
        </CardBody>
      </Card>
    </>
  );
}
