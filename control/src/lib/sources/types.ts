import type { Project } from "@prisma/client";

/**
 * Source-fetching contracts (build area).
 *
 * Git credentials hook — implemented by the git area:
 *
 *   // src/lib/git/auth.ts   (git area)
 *   import type { GitAuthProvider } from "@/lib/sources/types";
 *   export const getGitAuth: GitAuthProvider = async (project) => {
 *     if (project.githubInstallationId) return { auth: { kind: "token", token: await installationToken(...) } };
 *     return null;                                   // → build area falls back to the project's deploy key / anonymous
 *   };
 *
 * The build engine lazily imports `@/lib/git/auth` (if it exports `getGitAuth`) and also honours providers
 * registered at runtime with `registerGitAuthProvider()` (see ./git-auth.ts). Providers are asked in order; the first
 * non-null answer wins. Tokens are passed to git through an `http.extraHeader` (never written to .git/config or logs).
 */

export type GitAuth =
  | { kind: "none" }
  /** HTTPS basic auth. GitHub App installation tokens: username "x-access-token" (default). */
  | { kind: "token"; token: string; username?: string }
  /** SSH private key (OpenSSH/PEM). Written to a 0600 temp file for GIT_SSH_COMMAND, deleted after the clone. */
  | { kind: "ssh"; privateKey: string; knownHosts?: string };

export type GitAuthResult = {
  auth: GitAuth;
  /** override the clone URL (e.g. https://github.com/{fullName}.git for GitHub installs) */
  url?: string;
};

export type GitAuthProject = Pick<
  Project,
  "id" | "teamId" | "sourceType" | "gitUrl" | "githubInstallationId" | "githubRepoFullName" | "gitDeployKeyEnc" | "gitDeployKeyPublic"
>;

export type GitAuthProvider = (project: GitAuthProject) => Promise<GitAuthResult | null>;

/** What a fetched source looks like on disk. */
export type FetchedSource = {
  /** STORAGE_DIR/work/{deploymentId}/src (repo root / extracted upload) */
  repoDir: string;
  /** repoDir + project.rootDirectory (the build context) */
  contextDir: string;
  kind: "git" | "upload" | "image";
  /** resolved commit (git) */
  commitSha?: string | null;
  commitMessage?: string | null;
  commitAuthor?: string | null;
  /** for IMAGE sources */
  image?: string;
  /** total bytes on disk (uploads) */
  bytes?: number;
};

export type SourceLogger = (line: string) => void | Promise<void>;
