import type { Deployment, EnvVar, Project } from "@prisma/client";
import { db } from "@/lib/db";
import { decryptString } from "@/lib/crypto";
import { branchHost, deploymentHost, hostUrl, projectHost } from "@/lib/deployments";

/**
 * Environment for a deployment (build time; the runtime area can reuse `resolveEnv` / `systemEnv`).
 * Precedence (later wins): shared env groups < project vars < branch-specific project vars (preview) < LEVANT_* system vars.
 */
export type ResolvedVar = { key: string; value: string; isSecret: boolean; source: "group" | "project" | "branch" | "system" };

type Dep = Pick<Deployment, "id" | "projectId" | "target" | "branch" | "commitSha" | "commitMessage" | "commitAuthor" | "prNumber" | "shortId" | "url">;
type Proj = Pick<Project, "id" | "slug" | "teamId" | "githubRepoFullName">;

export function systemEnv(dep: Dep, project: Proj): Record<string, string> {
  const env: Record<string, string> = {
    LEVANT: "1",
    LEVANT_ENV: dep.target === "PRODUCTION" ? "production" : "preview",
    LEVANT_TARGET_ENV: dep.target === "PRODUCTION" ? "production" : "preview",
    LEVANT_URL: dep.url || deploymentHost(project.slug, dep.shortId),
    LEVANT_DEPLOYMENT_URL: hostUrl(dep.url || deploymentHost(project.slug, dep.shortId)),
    LEVANT_PROJECT_PRODUCTION_URL: projectHost(project.slug),
    LEVANT_DEPLOYMENT_ID: dep.id,
    LEVANT_PROJECT_ID: project.id,
  };
  if (dep.branch) {
    env.LEVANT_GIT_COMMIT_REF = dep.branch;
    env.LEVANT_BRANCH_URL = branchHost(project.slug, dep.branch);
  }
  if (dep.commitSha) env.LEVANT_GIT_COMMIT_SHA = dep.commitSha;
  if (dep.commitMessage) env.LEVANT_GIT_COMMIT_MESSAGE = dep.commitMessage.slice(0, 1000);
  if (dep.commitAuthor) env.LEVANT_GIT_COMMIT_AUTHOR_NAME = dep.commitAuthor;
  if (dep.prNumber) env.LEVANT_GIT_PULL_REQUEST_ID = String(dep.prNumber);
  if (project.githubRepoFullName) {
    const [owner, slug] = project.githubRepoFullName.split("/");
    env.LEVANT_GIT_PROVIDER = "github";
    env.LEVANT_GIT_REPO_OWNER = owner ?? "";
    env.LEVANT_GIT_REPO_SLUG = slug ?? "";
  }
  return env;
}

function applies(v: Pick<EnvVar, "targets" | "branch">, dep: Dep) {
  if (!v.targets.includes(dep.target)) return false;
  if (v.branch) return dep.target === "PREVIEW" && v.branch === dep.branch;
  return true;
}

/** Decrypted env vars applying to the deployment's target (+ branch overrides) and the LEVANT_* system vars. */
export async function resolveEnv(dep: Dep, project: Proj): Promise<ResolvedVar[]> {
  const [own, links] = await Promise.all([
    db.envVar.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "asc" } }),
    db.projectSharedEnvGroup.findMany({ where: { projectId: project.id }, include: { group: { include: { vars: true } } } }),
  ]);
  const out = new Map<string, ResolvedVar>();
  const put = (v: EnvVar, source: ResolvedVar["source"]) => {
    const value = decryptString(v.valueEnc);
    if (value == null) return;
    out.set(v.key, { key: v.key, value, isSecret: v.isSecret, source });
  };
  for (const l of links) for (const v of l.group.vars) if (applies(v, dep)) put(v, "group");
  for (const v of own) if (!v.branch && applies(v, dep)) put(v, "project");
  for (const v of own) if (v.branch && applies(v, dep)) put(v, "branch");
  for (const [k, value] of Object.entries(systemEnv(dep, project))) out.set(k, { key: k, value, isSecret: false, source: "system" });
  return [...out.values()];
}

/** keys that must never be forwarded as build args (they'd break the build environment) */
export const RESERVED_BUILD_KEYS = new Set(["PATH", "HOME", "HOSTNAME", "PWD", "SHELL", "USER", "DOCKER_HOST", "BUILDKIT_INLINE_CACHE"]);
