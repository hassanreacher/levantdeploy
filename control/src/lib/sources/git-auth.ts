import { decryptString } from "@/lib/crypto";
import type { GitAuthProject, GitAuthProvider, GitAuthResult } from "./types";

/**
 * Resolution of git credentials for a project:
 *   1. providers registered with registerGitAuthProvider() (in-process)
 *   2. the git area's module `@/lib/git/auth` (export `getGitAuth`) — loaded lazily, optional
 *   3. fallback: the project's SSH deploy key (Project.gitDeployKeyEnc) for ssh URLs, else anonymous
 */
const g = globalThis as unknown as { __ldGitAuthProviders?: GitAuthProvider[] };
const providers = (g.__ldGitAuthProviders ??= []);

export function registerGitAuthProvider(fn: GitAuthProvider) {
  if (!providers.includes(fn)) providers.push(fn);
}

/** Lazily-imported modules that export `getGitAuth` (the git area implements it in src/lib/git/auth.ts). */
const PROVIDER_MODULES: Array<() => Promise<{ getGitAuth?: GitAuthProvider } | null>> = [
  () => import("@/lib/git/auth").catch((e) => (console.warn("[sources] git auth module failed to load:", (e as Error).message), null)),
];

export function isSshUrl(url: string | null | undefined): boolean {
  return !!url && (/^git@[^:]+:/.test(url) || url.startsWith("ssh://"));
}

export async function getGitAuth(project: GitAuthProject): Promise<GitAuthResult | null> {
  for (const p of providers) {
    const r = await p(project);
    if (r) return r;
  }
  for (const load of PROVIDER_MODULES) {
    const mod = await load();
    if (mod?.getGitAuth) {
      const r = await mod.getGitAuth(project);
      if (r) return r;
    }
  }
  if (project.gitDeployKeyEnc && (isSshUrl(project.gitUrl) || !project.githubInstallationId)) {
    const key = decryptString(project.gitDeployKeyEnc);
    if (key) return { auth: { kind: "ssh", privateKey: key } };
  }
  return null;
}
