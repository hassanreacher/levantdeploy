import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { TEAM_COOKIE } from "@/lib/auth/jwt";
import { teamsForUser } from "@/lib/teams";
import { getTeamContext } from "@/lib/auth/context";
import { TopNav } from "@/components/shell/top-nav";
import { CommandPaletteProvider } from "@/components/shell/command-palette";

export const dynamic = "force-dynamic";

export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser("/account");
  const teams = await teamsForUser(user.id);
  const pref = (await cookies()).get(TEAM_COOKIE)?.value;
  const t = teams.find((x) => x.slug === pref) ?? teams[0];
  if (!t) redirect("/login");
  const ctx = await getTeamContext(t.slug);
  return (
    <CommandPaletteProvider items={teams.map((x) => ({ id: `t:${x.slug}`, label: x.name, group: "Teams", href: `/${x.slug}` }))}>
      <div className="min-h-screen">
        <TopNav ctx={ctx} extraCrumbs={[{ label: "Account" }]} />
        <main>{children}</main>
      </div>
    </CommandPaletteProvider>
  );
}
