import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { TEAM_COOKIE } from "@/lib/auth/jwt";
import { teamsForUser } from "@/lib/teams";
import { getTeamContext } from "@/lib/auth/context";
import { TopNav } from "@/components/shell/top-nav";
import { CommandPaletteProvider } from "@/components/shell/command-palette";
import { PageHeader } from "@/components/shell/page-header";
import { SettingsNav } from "./settings-nav";
import { SETTINGS_SECTIONS } from "./sections";

export const dynamic = "force-dynamic";

/** Platform settings (ops area) — platform owner only. Other users get a 404 (no existence leak). */
export default async function PlatformSettingsLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser("/settings");
  if (!user.isPlatformOwner) notFound();
  const teams = await teamsForUser(user.id);
  const pref = (await cookies()).get(TEAM_COOKIE)?.value;
  const t = teams.find((x) => x.slug === pref) ?? teams[0];
  if (!t) redirect("/account");
  const ctx = await getTeamContext(t.slug);
  const items = [
    ...teams.map((x) => ({ id: `t:${x.slug}`, label: x.name, group: "Teams", href: `/${x.slug}` })),
    ...SETTINGS_SECTIONS.map((s) => ({ id: `ps:${s.href}`, label: `Platform settings: ${s.label}`, group: "Settings", href: s.href })),
  ];
  return (
    <CommandPaletteProvider items={items}>
      <div className="min-h-screen">
        <TopNav ctx={ctx} extraCrumbs={[{ label: "Platform Settings" }]} />
        <main>
          <PageHeader title="Platform Settings" description="Server-wide configuration for this LevantDeploy instance. Only the platform owner can see this page." />
          <div className="container-page flex flex-col gap-6 py-8 md:flex-row md:gap-10">
            <SettingsNav />
            <div className="min-w-0 max-w-3xl flex-1 space-y-6">{children}</div>
          </div>
        </main>
      </div>
    </CommandPaletteProvider>
  );
}
