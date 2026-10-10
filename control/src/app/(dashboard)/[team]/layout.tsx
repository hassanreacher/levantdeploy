import { db } from "@/lib/db";
import { getTeamContext } from "@/lib/auth/context";
import { CommandPaletteProvider, type CommandItem } from "@/components/shell/command-palette";
import { PROJECT_TABS } from "@/components/shell/nav";
import { basePathFor } from "@/lib/base-ui/access";
import { BASE_PAGES } from "@/lib/base-ui/shared";
import { TeamEventsProvider } from "@/components/dashboard/live";
import { AssistantLauncher } from "@/components/ai/assistant-launcher";
import { PlanLimitListener } from "@/components/plans/plan-limit-listener";
import { VerifyEmailBanner } from "@/components/plans/verify-email-banner";
import { getSetting } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * Auth + membership gate for everything under /{team}; provides the command palette (projects, recent deployments,
 * pages, actions + remote deployment search) and the live deployment-status event stream.
 */
export default async function TeamLayout({ children, params }: { children: React.ReactNode; params: Promise<{ team: string }> }) {
  const { team: slug } = await params;
  const ctx = await getTeamContext(slug);
  // plans area: unverified-email banner (only when verification is required)
  const [me, requireVerify] = await Promise.all([
    db.user.findUnique({ where: { id: ctx.user.id }, select: { email: true, emailVerifiedAt: true, isPlatformOwner: true } }),
    getSetting("auth.requireEmailVerification").catch(() => true),
  ]);
  const showVerify = !!me && !me.emailVerifiedAt && !me.isPlatformOwner && requireVerify;
  const [projects, recent, bases] = await Promise.all([
    db.project.findMany({ where: { teamId: ctx.team.id }, select: { name: true, slug: true }, orderBy: { updatedAt: "desc" }, take: 50 }),
    db.deployment.findMany({
      where: { project: { teamId: ctx.team.id } },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { id: true, shortId: true, number: true, status: true, branch: true, commitMessage: true, project: { select: { name: true, slug: true } } },
    }),
    // base-dashboard: Base projects in the palette
    db.baseProject.findMany({ where: { teamId: ctx.team.id, status: { not: "DELETING" } }, select: { ref: true, name: true, status: true, project: { select: { slug: true, name: true } } }, orderBy: { createdAt: "desc" }, take: 30 }),
  ]);
  const t = ctx.team.slug;
  const items: CommandItem[] = [
    ...projects.map((p) => ({ id: `p:${p.slug}`, label: p.name, group: "Projects", href: `/${t}/${p.slug}`, keywords: p.slug })),
    ...recent.map((d) => ({
      id: `d:${d.id}`,
      label: `${d.project.name} #${d.number} · ${d.commitMessage?.split("\n")[0]?.slice(0, 60) ?? d.branch ?? d.shortId}`,
      group: "Recent deployments",
      hint: d.status.toLowerCase(),
      keywords: `${d.shortId} ${d.branch ?? ""}`,
      href: `/${t}/${d.project.slug}/deployments/${d.id}`,
    })),
    ...projects.slice(0, 5).flatMap((p) =>
      PROJECT_TABS.filter((x) => x.seg).map((x) => ({ id: `p:${p.slug}:${x.seg}`, label: `${p.name} → ${x.label}`, group: "Project pages", href: `/${t}/${p.slug}/${x.seg}` })),
    ),
    ...bases.map((b) => ({
      id: `b:${b.ref}`,
      label: b.project ? `${b.name} (backend of ${b.project.name})` : b.name,
      group: "Base projects",
      hint: b.status.toLowerCase(),
      keywords: `${b.ref} base backend supabase database postgres`,
      href: basePathFor(t, b),
    })),
    ...bases.slice(0, 3).flatMap((b) =>
      BASE_PAGES.filter((x) => x.seg).map((x) => ({ id: `b:${b.ref}:${x.seg}`, label: `${b.name} → ${x.label}`, group: "Base pages", href: `${basePathFor(t, b)}/${x.seg}`, keywords: "base backend" })),
    ),
    { id: "act:build", label: "Build an app with AI…", group: "Actions", href: `/${t}/build`, keywords: "builder ai generate app website prompt" }, // builder-ui
    { id: "act:new", label: "Create new project…", group: "Actions", href: `/${t}/new`, keywords: "deploy import add" },
    { id: "act:newbase", label: "Create Base project…", group: "Actions", href: `/${t}/base/new`, keywords: "backend database postgres auth supabase" },
    { id: "act:invite", label: "Invite team member…", group: "Actions", href: `/${t}/members`, keywords: "invite add user" },
    { id: "act:token", label: "Create API token…", group: "Actions", href: `/${t}/tokens`, keywords: "cli ci token" },
    { id: "act:notify", label: "Configure notifications…", group: "Actions", href: `/${t}/settings/notifications`, keywords: "slack telegram email webhook discord alerts" },
    { id: "act:envgroups", label: "Manage shared environment variables…", group: "Actions", href: `/${t}/settings/env-groups`, keywords: "env secrets group" },
    ...ctx.teams.filter((x) => x.slug !== t).map((x) => ({ id: `t:${x.slug}`, label: `Switch to ${x.name}`, group: "Teams", href: `/${x.slug}` })),
    { id: "nav:base", label: "Base (backend projects)", group: "Navigation", href: `/${t}/base`, keywords: "backend database supabase" },
    { id: "nav:activity", label: "Activity", group: "Navigation", href: `/${t}/activity` },
    { id: "nav:usage", label: "Usage", group: "Navigation", href: `/${t}/usage` },
    { id: "nav:plan", label: "Plan & Usage", group: "Navigation", href: `/${t}/settings/plan`, keywords: "limits quota upgrade billing" },
    { id: "nav:members", label: "Team members", group: "Navigation", href: `/${t}/members` },
    { id: "nav:tokens", label: "API tokens", group: "Navigation", href: `/${t}/tokens` },
    { id: "nav:audit", label: "Audit log", group: "Navigation", href: `/${t}/audit` },
    { id: "nav:settings", label: "Team settings", group: "Navigation", href: `/${t}/settings` },
    { id: "nav:account", label: "Account settings", group: "Navigation", href: `/account` },
  ];
  return (
    <TeamEventsProvider team={t}>
      <CommandPaletteProvider items={items} searchUrl={`/api/v1/teams/${t}/search`}>
        {showVerify && <VerifyEmailBanner email={me!.email} />}
        {children}
        <PlanLimitListener team={t} /> {/* plans area: 402 PLAN_LIMIT / 403 EMAIL_UNVERIFIED banner */}
        <AssistantLauncher /> {/* ai area: global agent panel (floating button, ⌘J) */}
      </CommandPaletteProvider>
    </TeamEventsProvider>
  );
}
