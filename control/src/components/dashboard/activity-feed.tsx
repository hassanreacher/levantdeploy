import Link from "next/link";
import { GitBranch, Settings2 } from "lucide-react";
import type { ActivityItem } from "@/lib/dashboard/activity";
import { Avatar } from "@/components/ui/avatar";
import { StatusDot, type DeploymentStatusName } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";
import { TimeAgo } from "./time-ago";

/** Vertical activity timeline (server component). `compact` for sidebars. */
export function ActivityFeed({ items, team, compact }: { items: ActivityItem[]; team: string; compact?: boolean }) {
  return (
    <ol className="relative">
      {items.map((it, i) => {
        const href = it.deployment && it.project ? `/${team}/${it.project.slug}/deployments/${it.deployment.id}` : it.project ? `/${team}/${it.project.slug}` : undefined;
        return (
          <li key={it.id} className={cn("relative flex gap-3", compact ? "pb-4" : "pb-5")}>
            {i < items.length - 1 && <span className="absolute left-[11px] top-7 h-[calc(100%-24px)] w-px bg-border" aria-hidden />}
            <span className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-surface">
              {it.kind === "deployment" ? (
                it.status === "QUEUED" && it.actor ? (
                  <Avatar name={it.actor.name} src={it.actor.avatar} size={22} />
                ) : (
                  <StatusDot status={(it.status === "QUEUED" ? "QUEUED" : it.status) as DeploymentStatusName} />
                )
              ) : it.actor ? (
                <Avatar name={it.actor.name} src={it.actor.avatar} size={22} />
              ) : (
                <Settings2 className="h-3 w-3 text-muted" />
              )}
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <p className="text-[13px] leading-snug text-muted">
                {it.actor && <span className="font-medium text-fg">{it.actor.name} </span>}
                {href ? (
                  <Link href={href} className="hover:text-fg">
                    {it.text}
                  </Link>
                ) : (
                  it.text
                )}
                {it.project && (
                  <>
                    {" "}
                    in{" "}
                    <Link href={`/${team}/${it.project.slug}`} className="font-medium text-fg hover:underline">
                      {it.project.name}
                    </Link>
                  </>
                )}
              </p>
              {it.deployment && !compact && (it.deployment.commitMessage || it.deployment.branch) && (
                <p className="mt-1 flex min-w-0 items-center gap-1.5 text-[12px] text-subtle">
                  {it.deployment.branch && (
                    <span className="inline-flex shrink-0 items-center gap-1 font-mono">
                      <GitBranch className="h-3 w-3" />
                      {it.deployment.branch}
                    </span>
                  )}
                  {it.deployment.commitMessage && <span className="truncate">· {it.deployment.commitMessage.split("\n")[0]}</span>}
                </p>
              )}
              <TimeAgo date={it.at} className="mt-0.5 block text-[12px] text-subtle" />
            </div>
          </li>
        );
      })}
    </ol>
  );
}
