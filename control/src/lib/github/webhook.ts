import type { Deployment } from "@prisma/client";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { queues } from "@/lib/queues";
import { createDeployment } from "@/lib/deployments";
import { audit } from "@/lib/audit";
import { getGitHubApp } from "./config";
import { routeGitHubEvent, verifySignature, type DeployAction, type RouteAction } from "./routing";
import { upsertInstallation, forgetInstallationToken } from "./installations";
import { reportDeploymentStatus } from "./status";

export class WebhookError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const deliveryKey = (id: string) => `ld:gh:delivery:${id}`;

export type WebhookResult = { duplicate?: boolean; event: string; results: Array<{ action: string; projectId?: string | null; deploymentId?: string; reason?: string }> };

/**
 * Inbound GitHub webhook: signature check → idempotency (X-GitHub-Delivery, 7 days) → route → act.
 * When processing throws, the delivery key is released so GitHub's redelivery is processed again.
 */
export async function handleGitHubWebhook(input: { event: string | null; deliveryId: string | null; signature: string | null; rawBody: string }): Promise<WebhookResult> {
  const app = await getGitHubApp();
  if (!app) throw new WebhookError(503, "GitHub App not configured");
  if (!verifySignature(app.webhookSecret, input.rawBody, input.signature)) throw new WebhookError(401, "Invalid signature");
  if (!input.event) throw new WebhookError(400, "Missing X-GitHub-Event");
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    throw new WebhookError(400, "Invalid JSON");
  }
  const r = redis();
  if (input.deliveryId) {
    const fresh = await r.set(deliveryKey(input.deliveryId), "1", "EX", 7 * 86400, "NX");
    if (fresh !== "OK") return { duplicate: true, event: input.event, results: [] };
  }
  try {
    return await processEvent(input.event, payload);
  } catch (e) {
    if (input.deliveryId) await r.del(deliveryKey(input.deliveryId)).catch(() => {});
    throw e;
  }
}

async function processEvent(event: string, payload: Record<string, unknown>): Promise<WebhookResult> {
  const repo = payload.repository as { id: number; full_name: string } | undefined;
  const installationId = (payload.installation as { id?: number } | undefined)?.id;
  const projects = repo
    ? await db.project.findMany({
        where: { sourceType: "GITHUB", githubRepoId: BigInt(repo.id) },
        select: { id: true, teamId: true, productionBranch: true, previewDeployments: true, autoDeploy: true, pausedAt: true, githubRepoFullName: true, githubInstallationId: true },
      })
    : [];
  // Keep the stored repo name fresh (renames / transfers).
  if (repo) {
    const stale = projects.filter((p) => p.githubRepoFullName !== repo.full_name).map((p) => p.id);
    if (stale.length) await db.project.updateMany({ where: { id: { in: stale } }, data: { githubRepoFullName: repo.full_name } });
  }
  const actions = routeGitHubEvent(event, payload, projects);
  const results: WebhookResult["results"] = [];
  for (const a of actions) results.push(await act(a, { installationId }));
  return { event, results };
}

async function act(a: RouteAction, ctx: { installationId?: number }): Promise<WebhookResult["results"][number]> {
  switch (a.type) {
    case "skip":
      return { action: "skip", projectId: a.projectId, reason: a.reason };
    case "deploy": {
      const d = await deployOnce(a);
      return { action: d.created ? "deploy" : "deploy-dedupe", projectId: a.projectId, deploymentId: d.deployment.id };
    }
    case "pr-closed":
      await queues.git.add({ kind: "pr-closed", projectId: a.projectId, prNumber: a.prNumber, branch: a.branch });
      return { action: "pr-closed", projectId: a.projectId };
    case "branch-deleted":
      await queues.git.add({ kind: "pr-closed", projectId: a.projectId, branch: a.branch });
      return { action: "branch-deleted", projectId: a.projectId };
    case "installation":
      await handleInstallation(a);
      return { action: a.action };
  }
  void ctx;
}

/**
 * Creates the deployment unless the same commit is already deploying for this project+target
 * (push + pull_request.synchronize arrive for the same commit → one preview, tagged with the PR number).
 */
async function deployOnce(a: DeployAction): Promise<{ created: boolean; deployment: Deployment }> {
  const r = redis();
  const key = `ld:gh:dep:${a.projectId}:${a.target}:${a.commitSha}`;
  const won = await r.set(key, "pending", "EX", 3600, "NX");
  if (won !== "OK") {
    // Someone else is creating / created it: wait briefly for the row, then attach the PR number.
    for (let i = 0; i < 20; i++) {
      const existing = await db.deployment.findFirst({
        where: { projectId: a.projectId, target: a.target, commitSha: a.commitSha },
        orderBy: { createdAt: "desc" },
      });
      if (existing) {
        if (a.prNumber && !existing.prNumber) {
          const upd = await db.deployment.update({
            where: { id: existing.id },
            data: { prNumber: a.prNumber, trigger: "PULL_REQUEST", meta: { ...((existing.meta as object) ?? {}), prTitle: a.commitMessage } },
          });
          await reportDeploymentStatus(upd).catch(() => {});
          return { created: false, deployment: upd };
        }
        return { created: false, deployment: existing };
      }
      await new Promise((res) => setTimeout(res, 150));
    }
  }
  try {
    const project = await db.project.findUniqueOrThrow({ where: { id: a.projectId }, select: { teamId: true } });
    const dep = await createDeployment({
      projectId: a.projectId,
      target: a.target,
      trigger: a.trigger,
      source: {
        branch: a.branch,
        commitSha: a.commitSha,
        commitMessage: a.commitMessage,
        commitAuthor: a.commitAuthor,
        commitAuthorAvatar: a.commitAuthorAvatar,
        prNumber: a.prNumber,
      },
      meta: { source: "github", ...(a.prNumber ? { prTitle: a.commitMessage } : {}) },
    });
    await r.set(key, dep.id, "EX", 3600).catch(() => {});
    await audit({ action: "deployment.create", teamId: project.teamId, targetType: "deployment", targetId: dep.id, meta: { trigger: a.trigger, branch: a.branch, sha: a.commitSha } });
    await reportDeploymentStatus(dep).catch((e) => console.warn("[github] status report failed:", (e as Error).message));
    return { created: true, deployment: dep };
  } catch (e) {
    await r.del(key).catch(() => {});
    throw e;
  }
}

async function handleInstallation(a: Extract<RouteAction, { type: "installation" }>) {
  const inst = { id: a.installationId, account: a.account, repository_selection: a.repositorySelection };
  switch (a.action) {
    case "installation.deleted":
      await forgetInstallationToken(a.installationId);
      await db.gitHubInstallation.deleteMany({ where: { installationId: a.installationId } });
      return;
    case "installation.suspend":
      await db.gitHubInstallation.updateMany({ where: { installationId: a.installationId }, data: { suspendedAt: new Date() } });
      return;
    case "installation.unsuspend":
      await db.gitHubInstallation.updateMany({ where: { installationId: a.installationId }, data: { suspendedAt: null } });
      return;
    default:
      // created / new_permissions_accepted / installation_repositories.added|removed
      await upsertInstallation(inst);
      await redis().del(`ld:gh:repos:${a.installationId}`).catch(() => {});
  }
}
