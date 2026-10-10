import { getProjectContext } from "@/lib/auth/context";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { SettingsShell } from "@/components/dashboard/settings-nav";

export default async function ProjectSettingsLayout({ children, params }: { children: React.ReactNode; params: Promise<{ team: string; project: string }> }) {
  const { team, project } = await params;
  const ctx = await getProjectContext(team, project);
  const b = `/${ctx.team.slug}/${ctx.project.slug}/settings`;
  const nav = [
    { href: b, label: "General" },
    { href: `${b}/build`, label: "Build & Development" },
    { href: `${b}/git`, label: "Git" },
    { href: `${b}/runtime`, label: "Runtime" },
    { href: `${b}/protection`, label: "Deployment Protection" },
    { href: `${b}/notifications`, label: "Notifications" },
    { href: `${b}/advanced`, label: "Danger Zone" },
  ];
  return (
    <>
      <PageHeader title="Project Settings" description={`Configure how ${ctx.project.name} is built, run and protected.`} />
      <PageBody>
        <SettingsShell nav={nav}>{children}</SettingsShell>
      </PageBody>
    </>
  );
}
