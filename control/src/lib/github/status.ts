import type { Deployment, DeploymentStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { appUrl } from "@/lib/env";
import { onStatusChange } from "@/lib/hooks";
import { deploymentUrl, hostUrl, projectHost, branchHost } from "@/lib/deployments";
import { ghAsInstallation } from "./installations";
import { GitHubApiError } from "./api";
import { getGitHubApp } from "./config";
import { COMMENT_MARKER, renderPrComment, type CommentRow } from "./status-render";
export { renderPrComment, STATUS_LABEL, type CommentRow } from "./status-render";

/**
 * Reports deployment progress back to GitHub (like the Vercel bot):
 *  1. commit status  (context "LevantDeploy – <project>")
 *  2. GitHub Deployment + deployment statuses (environment "Production" / "Preview")
 *  3. one PR comment per pull request, updated in place with a row per project (status + preview URL)
 *
 * Triggered by setStatus() through the hook registry (src/lib/hooks.ts) and directly by the webhook handler
 * when a deployment is created (QUEUED). Never throws to the caller of the hook.
 */


type Ctx = {
  dep: Deployment;
  installationId: number;
  repo: string;
  projectName: string;
  projectSlug: string;
  teamSlug: string;
};

const COMMIT_STATE: Record<DeploymentStatus, { state: "pending" | "success" | "failure" | "error"; text: string } | null> = {
  QUEUED: { state: "pending", text: "Deployment queued" },
  BUILDING: { state: "pending", text: "Building…" },
  DEPLOYING: { state: "pending", text: "Deploying…" },
  READY: { state: "success", text: "Deployment ready" },
  ERROR: { state: "failure", text: "Deployment failed" },
  CANCELED: { state: "error", text: "Deployment canceled" },
  SUPERSEDED: null,
};
const DEPLOY_STATE: Record<DeploymentStatus, "queued" | "in_progress" | "success" | "failure" | "error" | "inactive"> = {
  QUEUED: "queued",
  BUILDING: "in_progress",
  DEPLOYING: "in_progress",
  READY: "success",
  ERROR: "failure",
  CANCELED: "error",
  SUPERSEDED: "inactive",
};
async function context(depId: string): Promise<Ctx | null> {
  const dep = await db.deployment.findUnique({
    where: { id: depId },
    include: { project: { include: { team: { select: { slug: true } }, githubInstallation: { select: { installationId: true, suspendedAt: true } } } } },
  });
  if (!dep || !dep.commitSha) return null;
  const p = dep.project;
  if (p.sourceType !== "GITHUB" || !p.githubRepoFullName || !p.githubInstallation || p.githubInstallation.suspendedAt) return null;
  const { project: _p, ...plain } = dep;
  return { dep: plain, installationId: p.githubInstallation.installationId, repo: p.githubRepoFullName, projectName: p.name, projectSlug: p.slug, teamSlug: p.team.slug };
}

const inspectUrl = (c: Ctx) => appUrl(`/${c.teamSlug}/${c.projectSlug}/deployments/${c.dep.id}`);
const environmentUrl = (c: Ctx) => (c.dep.target === "PRODUCTION" ? hostUrl(projectHost(c.projectSlug)) : deploymentUrl(c.dep));

// Serialise reports per deployment (status hooks fire quickly one after another).
const chains = new Map<string, Promise<void>>();

export function reportDeploymentStatus(dep: Pick<Deployment, "id">): Promise<void> {
  const prev = chains.get(dep.id) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => doReport(dep.id))
    .catch((e) => console.warn(`[github] report ${dep.id} failed:`, (e as Error).message))
    .finally(() => {
      if (chains.get(dep.id) === next) chains.delete(dep.id);
    });
  chains.set(dep.id, next);
  return next;
}

/** Spec name: exported for other areas; same as reportDeploymentStatus. */
export const onDeploymentStatus = (deployment: Pick<Deployment, "id">) => reportDeploymentStatus(deployment);

async function doReport(depId: string) {
  if (!(await getGitHubApp())) return;
  const c = await context(depId);
  if (!c) return;
  await Promise.allSettled([commitStatus(c), githubDeployment(c), c.dep.prNumber ? prComment(c) : Promise.resolve()]).then((rs) => {
    for (const r of rs) if (r.status === "rejected") console.warn("[github]", (r.reason as Error)?.message);
  });
}

async function commitStatus(c: Ctx) {
  const s = COMMIT_STATE[c.dep.status];
  if (!s) return;
  const description = c.dep.status === "ERROR" && c.dep.errorMessage ? `Failed: ${c.dep.errorMessage}` : s.text;
  await ghAsInstallation(c.installationId, "POST", `/repos/${c.repo}/statuses/${c.dep.commitSha}`, {
    body: { state: s.state, target_url: c.dep.status === "READY" ? environmentUrl(c) : inspectUrl(c), description: description.slice(0, 139), context: `LevantDeploy – ${c.projectName}` },
  });
}

async function githubDeployment(c: Ctx) {
  const r = redis();
  const key = `ld:gh:ghdep:${c.dep.id}`;
  let ghId = await r.get(key);
  if (!ghId) {
    const lock = await r.set(`${key}:lock`, "1", "EX", 60, "NX");
    if (lock !== "OK") {
      for (let i = 0; i < 20 && !ghId; i++) {
        await new Promise((res) => setTimeout(res, 200));
        ghId = await r.get(key);
      }
      if (!ghId) return;
    } else {
      const isProd = c.dep.target === "PRODUCTION";
      const created = await ghAsInstallation<{ id: number }>(c.installationId, "POST", `/repos/${c.repo}/deployments`, {
        body: {
          ref: c.dep.commitSha,
          environment: isProd ? "Production" : `Preview – ${c.projectName}`,
          description: `LevantDeploy #${c.dep.number}`,
          auto_merge: false,
          required_contexts: [],
          transient_environment: !isProd,
          production_environment: isProd,
          payload: { levantDeploymentId: c.dep.id },
        },
      });
      ghId = String(created.id);
      await r.set(key, ghId, "EX", 30 * 86400);
      await db
        .$executeRaw`UPDATE "Deployment" SET meta = jsonb_set(COALESCE(meta, '{}'::jsonb), '{githubDeploymentId}', to_jsonb(${created.id}::bigint)) WHERE id = ${c.dep.id}`
        .catch(() => {});
    }
  }
  await ghAsInstallation(c.installationId, "POST", `/repos/${c.repo}/deployments/${ghId}/statuses`, {
    body: {
      state: DEPLOY_STATE[c.dep.status],
      log_url: inspectUrl(c),
      environment_url: c.dep.status === "READY" ? environmentUrl(c) : undefined,
      description: (COMMIT_STATE[c.dep.status]?.text ?? c.dep.status).slice(0, 139),
      auto_inactive: c.dep.target === "PRODUCTION",
    },
  });
}

// ───────────────────────────── PR comment ─────────────────────────────

async function prComment(c: Ctx) {
  const pr = c.dep.prNumber!;
  // Only the newest deployment of this PR may update the row (older ones finishing late must not overwrite it).
  const newest = await db.deployment.findFirst({ where: { projectId: c.dep.projectId, prNumber: pr }, orderBy: { number: "desc" }, select: { id: true } });
  if (newest && newest.id !== c.dep.id) return;
  const r = redis();
  const base = `ld:gh:pr:${c.repo}:${pr}`;
  const row: CommentRow = {
    project: c.projectName,
    status: c.dep.status,
    inspectUrl: inspectUrl(c),
    previewUrl: deploymentUrl(c.dep),
    branchUrl: c.dep.branch ? hostUrl(branchHost(c.projectSlug, c.dep.branch)) : null,
    updatedAt: Date.now(),
  };
  await r.hset(`${base}:rows`, c.dep.projectId, JSON.stringify(row));
  await r.expire(`${base}:rows`, 90 * 86400);
  const rows = Object.values(await r.hgetall(`${base}:rows`)).map((x) => JSON.parse(x) as CommentRow);
  const body = renderPrComment(rows, appUrl());

  let commentId = await r.get(`${base}:comment`);
  if (!commentId) commentId = await findExistingComment(c.installationId, c.repo, pr);
  if (commentId) {
    try {
      await ghAsInstallation(c.installationId, "PATCH", `/repos/${c.repo}/issues/comments/${commentId}`, { body: { body } });
      await r.set(`${base}:comment`, commentId, "EX", 90 * 86400);
      return;
    } catch (e) {
      if (!(e instanceof GitHubApiError && e.status === 404)) throw e;
      await r.del(`${base}:comment`);
    }
  }
  const lock = await r.set(`${base}:lock`, "1", "EX", 30, "NX");
  if (lock !== "OK") {
    // another process is creating it — retry the update a moment later
    await new Promise((res) => setTimeout(res, 1500));
    const id = await r.get(`${base}:comment`);
    if (id) await ghAsInstallation(c.installationId, "PATCH", `/repos/${c.repo}/issues/comments/${id}`, { body: { body } });
    return;
  }
  try {
    const created = await ghAsInstallation<{ id: number }>(c.installationId, "POST", `/repos/${c.repo}/issues/${pr}/comments`, { body: { body } });
    await r.set(`${base}:comment`, String(created.id), "EX", 90 * 86400);
  } finally {
    await r.del(`${base}:lock`);
  }
}

async function findExistingComment(installationId: number, repo: string, pr: number): Promise<string | null> {
  try {
    const list = await ghAsInstallation<Array<{ id: number; body?: string }>>(installationId, "GET", `/repos/${repo}/issues/${pr}/comments`, { query: { per_page: 100 } });
    const hit = list.find((x) => x.body?.includes(COMMENT_MARKER));
    return hit ? String(hit.id) : null;
  } catch {
    return null;
  }
}

/** Marks the GitHub deployments of stopped previews inactive (PR closed / branch deleted). */
export async function markInactive(deploymentIds: string[]) {
  for (const id of deploymentIds) {
    const c = await context(id).catch(() => null);
    const ghId = await redis().get(`ld:gh:ghdep:${id}`);
    if (!c || !ghId) continue;
    await ghAsInstallation(c.installationId, "POST", `/repos/${c.repo}/deployments/${ghId}/statuses`, { body: { state: "inactive" } }).catch(() => {});
  }
}

// Register with the status hook registry (loaded lazily by src/lib/hooks.ts).
onStatusChange((d) => reportDeploymentStatus(d));
