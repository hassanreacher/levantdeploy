/**
 * git+cli area worker jobs (queue `git`):
 *  - poll:            every 2 min, branch polling for generic Git projects (auto-deploy without webhooks)
 *  - poll-project:    poll one project now
 *  - pr-closed:       PR closed / branch deleted → stop preview deployments, mark GitHub deployments inactive
 *  - uploads-expire:  hourly, delete expired uploads
 * Importing github/status registers the deployment status hook (commit statuses, GitHub deployments, PR comment).
 */
import { registerProcessor, registerSchedule } from "@/lib/queues";
import { pollAll, pollProject } from "@/lib/git/polling";
import { stopPreviews } from "@/lib/git/runtime-adapter";
import { expireUploads } from "@/lib/uploads/storage";
import { markInactive } from "@/lib/github/status";

registerProcessor(
  "git",
  async (job) => {
    const d = job.data;
    switch (d.kind) {
      case "poll": {
        const res = await pollAll();
        return { projects: res.length, deployed: res.reduce((n, r) => n + r.deployed.length, 0) };
      }
      case "poll-project":
        return d.projectId ? pollProject(d.projectId) : null;
      case "pr-closed": {
        if (!d.projectId) return null;
        const stopped = await stopPreviews(d.projectId, d.prNumber ? { prNumber: d.prNumber } : { branch: d.branch });
        await markInactive(stopped);
        return { stopped };
      }
      case "uploads-expire":
        return { expired: await expireUploads() };
      default:
        return null;
    }
  },
  { concurrency: 2, lockDuration: 5 * 60_000 },
);

registerSchedule("git", "git-poll-branches", { every: 120_000 }, { kind: "poll" });
registerSchedule("git", "git-uploads-expire", { pattern: "41 * * * *" }, { kind: "uploads-expire" });
