import type { Deployment, DeploymentTrigger, Project } from "@prisma/client";
import { db } from "@/lib/db";
import { createDeployment } from "@/lib/deployments";
import { getBranchHead } from "@/lib/github/installations";
import { reportDeploymentStatus } from "@/lib/github/status";
import { lsRemote } from "./exec";
import { projectRemote } from "./auth";

export class TriggerError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type P = Pick<Project, "id" | "sourceType" | "productionBranch" | "githubRepoFullName" | "previewDeployments"> & { githubInstallation?: { installationId: number } | null };

/** Resolves the head commit of a branch (GitHub API for GitHub projects, ls-remote otherwise). */
export async function resolveBranchHead(p: P, branch: string): Promise<{ sha: string | null; message: string | null; author: string | null; avatar: string | null }> {
  if (p.sourceType === "GITHUB" && p.githubRepoFullName) {
    const inst = p.githubInstallation ?? (await db.project.findUnique({ where: { id: p.id }, select: { githubInstallation: { select: { installationId: true } } } }))?.githubInstallation;
    if (!inst) throw new TriggerError(400, "The project's GitHub installation was removed — reconnect the repository");
    try {
      return await getBranchHead(inst.installationId, p.githubRepoFullName, branch);
    } catch (e) {
      throw new TriggerError(400, `Branch "${branch}" not found: ${(e as Error).message}`);
    }
  }
  if (p.sourceType === "GIT") {
    const remote = await projectRemote(p.id);
    if (!remote) throw new TriggerError(400, "The project has no Git URL");
    const { heads } = await lsRemote(remote.url, remote.auth).catch((e) => {
      throw new TriggerError(400, `Could not reach the repository: ${(e as Error).message}`);
    });
    if (!heads[branch]) throw new TriggerError(400, `Branch "${branch}" not found`);
    return { sha: heads[branch]!, message: null, author: null, avatar: null };
  }
  throw new TriggerError(400, "Only Git projects can be deployed from a branch");
}

/** Creates a deployment for the head of a branch (production branch → PRODUCTION, others → PREVIEW). */
export async function deployBranch(
  projectId: string,
  branch: string | null,
  opts: { trigger: DeploymentTrigger; createdById?: string | null; meta?: Record<string, string | number | boolean | null>; skipIfSameSha?: boolean } = { trigger: "MANUAL" },
): Promise<Deployment | null> {
  const p = await db.project.findUnique({ where: { id: projectId }, include: { githubInstallation: { select: { installationId: true } } } });
  if (!p) throw new TriggerError(404, "Project not found");
  const b = branch || p.productionBranch;
  const target = b === p.productionBranch ? "PRODUCTION" : "PREVIEW";
  const head = await resolveBranchHead(p, b);
  if (opts.skipIfSameSha && head.sha) {
    const dup = await db.deployment.findFirst({ where: { projectId, target, commitSha: head.sha, status: { in: ["QUEUED", "BUILDING", "DEPLOYING", "READY"] } } });
    if (dup) return null;
  }
  const dep = await createDeployment({
    projectId,
    target,
    trigger: opts.trigger,
    createdById: opts.createdById ?? null,
    source: { branch: b, commitSha: head.sha, commitMessage: head.message, commitAuthor: head.author, commitAuthorAvatar: head.avatar },
    meta: opts.meta ?? {},
  });
  await reportDeploymentStatus(dep).catch(() => {});
  return dep;
}
