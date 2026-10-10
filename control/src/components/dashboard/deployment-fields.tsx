import type { ReactNode } from "react";
import { GitBranch, GitCommitHorizontal, GitPullRequest } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { StatusDot, type DeploymentStatusName } from "@/components/ui/status-dot";
import { cn, formatDuration } from "@/lib/utils";
import type { DeploymentDTO } from "@/lib/dashboard/deployments";
import { TimeAgo, Elapsed } from "./time-ago";

export function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <p className="mb-1 text-[12px] font-medium text-subtle">{label}</p>
      <div className="min-w-0 text-[13px] text-fg">{children}</div>
    </div>
  );
}

export function commitUrl(repo: string | null | undefined, sha: string | null | undefined) {
  return repo && sha ? `https://github.com/${repo}/commit/${sha}` : null;
}

/** Branch + short sha + message (+ PR) block. */
export function SourceInfo({ d, repo, compact }: { d: Pick<DeploymentDTO, "branch" | "commitSha" | "commitMessage" | "prNumber" | "commitAuthor" | "commitAuthorAvatar">; repo?: string | null; compact?: boolean }) {
  const cu = commitUrl(repo, d.commitSha);
  return (
    <div className="min-w-0 space-y-1">
      {d.branch && (
        <p className="flex min-w-0 items-center gap-1.5">
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted" />
          <span className="truncate font-mono text-[13px]">{d.branch}</span>
          {d.prNumber ? (
            <a href={repo ? `https://github.com/${repo}/pull/${d.prNumber}` : undefined} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-0.5 text-[12px] text-muted hover:text-fg">
              <GitPullRequest className="h-3 w-3" />#{d.prNumber}
            </a>
          ) : null}
        </p>
      )}
      {(d.commitSha || d.commitMessage) && (
        <p className="flex min-w-0 items-center gap-1.5">
          <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0 text-muted" />
          {d.commitSha &&
            (cu ? (
              <a href={cu} target="_blank" rel="noreferrer" className="shrink-0 font-mono text-[13px] hover:underline">
                {d.commitSha.slice(0, 7)}
              </a>
            ) : (
              <span className="shrink-0 font-mono text-[13px]">{d.commitSha.slice(0, 7)}</span>
            ))}
          {d.commitMessage && <span className={cn("truncate text-muted", compact && "text-[12px]")}>{d.commitMessage.split("\n")[0]}</span>}
        </p>
      )}
      {!d.branch && !d.commitSha && !d.commitMessage && <p className="text-muted">Uploaded files</p>}
    </div>
  );
}

/** "Ready · 2m ago by Lina" status line. */
export function StatusLine({ d }: { d: DeploymentDTO }) {
  const who = d.createdBy?.name ?? d.commitAuthor;
  const avatar = d.createdBy?.avatar ?? d.commitAuthorAvatar;
  const running = ["QUEUED", "BUILDING", "DEPLOYING"].includes(d.status);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <StatusDot status={d.status as DeploymentStatusName} withLabel />
      <span className="text-muted">
        {running ? (
          <>
            <Elapsed from={d.createdAt} /> elapsed
          </>
        ) : (
          <>
            {formatDuration(d.duration)} · <TimeAgo date={d.createdAt} />
          </>
        )}
      </span>
      {who && (
        <span className="inline-flex min-w-0 items-center gap-1.5 text-muted">
          by <Avatar name={who} src={avatar} size={16} /> <span className="truncate">{who}</span>
        </span>
      )}
    </div>
  );
}
