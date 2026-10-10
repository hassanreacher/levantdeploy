import { getTeamContext } from "@/lib/auth/context";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { SettingsShell } from "@/components/dashboard/settings-nav";

export default async function TeamSettingsLayout({ children, params }: { children: React.ReactNode; params: Promise<{ team: string }> }) {
  const { team } = await params;
  const ctx = await getTeamContext(team);
  const b = `/${ctx.team.slug}/settings`;
  return (
    <>
      <PageHeader title="Team Settings" description={`Settings for ${ctx.team.name}.`} />
      <PageBody>
        <SettingsShell
          nav={[
            { href: b, label: "General" },
            { href: `${b}/plan`, label: "Plan & Usage" },
            { href: `${b}/notifications`, label: "Notifications" },
            { href: `${b}/env-groups`, label: "Environment Variables" },
            { href: `/${ctx.team.slug}/members`, label: "Members" },
            { href: `/${ctx.team.slug}/tokens`, label: "Tokens" },
          ]}
        >
          {children}
        </SettingsShell>
      </PageBody>
    </>
  );
}
