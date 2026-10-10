import type { Project } from "@prisma/client";
import { db } from "@/lib/db";
import { decryptString } from "@/lib/crypto";
import type { GitAuth, GitAuthProvider, GitAuthResult } from "@/lib/sources/types";
import { getInstallationToken } from "@/lib/github/installations";
import { githubWebUrl } from "@/lib/github/config";
import { parseGitSettings } from "./settings";
import { defaultTokenUsername, parseGitUrl } from "./url";

/**
 * Git credentials for a project — the hook the build area calls before cloning (see src/lib/sources/types.ts).
 *  - GITHUB:  installation access token (x-access-token) + https://github.com/{fullName}.git
 *  - GIT + token:     HTTPS basic auth with the stored token
 *  - GIT + deploy key: SSH private key
 *  - otherwise null (public repo / build-area fallback)
 */
export const getGitAuth: GitAuthProvider = async (project) => {
  const full = await db.project.findUnique({
    where: { id: project.id },
    select: { sourceType: true, gitUrl: true, gitSettings: true, gitDeployKeyEnc: true, githubRepoFullName: true, githubInstallation: { select: { installationId: true } } },
  });
  if (!full) return null;
  return gitAuthFor(full);
};

type AuthInput = Pick<Project, "sourceType" | "gitUrl" | "gitSettings" | "gitDeployKeyEnc" | "githubRepoFullName"> & {
  githubInstallation: { installationId: number } | null;
};

export async function gitAuthFor(p: AuthInput): Promise<GitAuthResult | null> {
  if (p.sourceType === "GITHUB" && p.githubRepoFullName) {
    const url = `${githubWebUrl()}/${p.githubRepoFullName}.git`;
    if (!p.githubInstallation) return { auth: { kind: "none" }, url };
    const token = await getInstallationToken(p.githubInstallation.installationId);
    return { auth: { kind: "token", token, username: "x-access-token" }, url };
  }
  if (p.sourceType === "GIT" && p.gitUrl) {
    const parsed = parseGitUrl(p.gitUrl);
    if (parsed?.isSsh) {
      const key = decryptString(p.gitDeployKeyEnc);
      return key ? { auth: { kind: "ssh", privateKey: key }, url: p.gitUrl } : null;
    }
    const s = parseGitSettings(p.gitSettings);
    const token = decryptString(s.tokenEnc ?? null);
    if (token) return { auth: { kind: "token", token, username: s.tokenUsername || defaultTokenUsername(parsed?.host ?? "") }, url: p.gitUrl };
    return { auth: { kind: "none" }, url: p.gitUrl };
  }
  return null;
}

/** Auth + URL for ad-hoc operations on a project (ls-remote, polling, detection). */
export async function projectRemote(projectId: string): Promise<{ url: string; auth: GitAuth } | null> {
  const p = await db.project.findUnique({
    where: { id: projectId },
    select: { sourceType: true, gitUrl: true, gitSettings: true, gitDeployKeyEnc: true, githubRepoFullName: true, githubInstallation: { select: { installationId: true } } },
  });
  if (!p) return null;
  const r = await gitAuthFor(p);
  if (!r?.url) return null;
  return { url: r.url, auth: r.auth };
}
