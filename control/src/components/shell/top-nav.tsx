import Link from "next/link";
import type { Project } from "@prisma/client";
import { Breadcrumbs, type Crumb } from "@/components/ui/breadcrumbs";
import { Avatar } from "@/components/ui/avatar";
import type { TeamContext } from "@/lib/auth/context";
import { Logo } from "./logo";
import { TeamSwitcher } from "./team-switcher";
import { UserMenu } from "./user-menu";
import { CommandTrigger } from "./command-palette";
import { NotificationBell } from "@/components/dashboard/notification-bell";

/** Sticky header: logo / team switcher / project breadcrumb … search, docs, account. */
export function TopNav({ ctx, project, extraCrumbs = [] }: { ctx: TeamContext; project?: Pick<Project, "name" | "slug"> | null; extraCrumbs?: Crumb[] }) {
  const current = ctx.teams.find((t) => t.id === ctx.team.id)!;
  const crumbs: Crumb[] = [];
  if (project) crumbs.push({ label: project.name, href: `/${ctx.team.slug}/${project.slug}`, icon: <Avatar name={project.slug} size={18} square /> });
  crumbs.push(...extraCrumbs);
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-bg/80 backdrop-blur-md">
      <div className="flex h-14 items-center gap-2 px-4 sm:px-6">
        <Link href={`/${ctx.team.slug}`} className="mr-1 shrink-0" aria-label="LevantDeploy home">
          <Logo />
        </Link>
        <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-border-strong" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <path d="M16.88 3.549L7.12 20.451" />
        </svg>
        <TeamSwitcher teams={ctx.teams} current={current} />
        {crumbs.length > 0 && <Breadcrumbs items={crumbs} className="ml-0" />}
        <div className="ml-auto flex items-center gap-3">
          <CommandTrigger />
          <NotificationBell />
          <a href="https://github.com" className="hidden text-[13px] text-muted transition-colors hover:text-fg sm:block" target="_blank" rel="noreferrer">
            Docs
          </a>
          <UserMenu user={ctx.user} teamSlug={ctx.team.slug} />
        </div>
      </div>
    </header>
  );
}
