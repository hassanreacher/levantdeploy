import { db } from "@/lib/db";
import { getGitHubApp, githubWebUrl } from "@/lib/github/config";
import { getInstallationToken, ghAsInstallation, getRepo, type GhRepo } from "@/lib/github/installations";
import { GitHubApiError } from "@/lib/github/api";
import { archive, gitIn, headSha } from "./git";
import { repoDir } from "./workspace";

/**
 * Export (builder-core):
 *   - ZIP of HEAD (git archive; committed files only — no .env.local, no node_modules)
 *   - "Export to GitHub" through the git area's GitHub App: create a repository under the installation's
 *     organization (or use an existing EMPTY repo the app can access — GitHub doesn't let apps create repos in
 *     personal accounts), then push HEAD to `main` with a short-lived installation token (not stored, not logged).
 * Worker-safe.
 */

export class ExportError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "app";

/** ZIP of a commit (default HEAD) with a top-level folder named after the app. */
export async function exportZip(builderId: string, opts: { ref?: string } = {}): Promise<{ filename: string; bytes: Buffer }> {
  const bp = await db.builderProject.findUnique({ where: { id: builderId }, select: { name: true } });
  if (!bp) throw new ExportError(404, "App not found");
  if (!(await headSha(builderId))) throw new ExportError(409, "The app has no commits yet");
  const name = slug(bp.name);
  const bytes = await archive(builderId, { ref: opts.ref ?? "HEAD", format: "zip", prefix: name });
  return { filename: `${name}.zip`, bytes };
}

export type GitHubExportInput = {
  /** repository name ("my-app") or "owner/name" */
  repo: string;
  private?: boolean;
  /** GitHubInstallation row id or GitHub's numeric installation id; default: the team's only installation */
  installationId?: string | number;
  description?: string;
};

function scrub(s: string, token: string) {
  return token ? s.split(token).join("***") : s;
}

/** Push HEAD to a new (or existing empty) GitHub repository. Returns the repo URL. */
export async function exportToGitHub(builderId: string, input: GitHubExportInput): Promise<{ url: string; repo: string; created: boolean; sha: string }> {
  const bp = await db.builderProject.findUnique({ where: { id: builderId }, select: { teamId: true, name: true, description: true } });
  if (!bp) throw new ExportError(404, "App not found");
  if (!(await getGitHubApp())) throw new ExportError(400, "GitHub is not connected to this LevantDeploy server. The platform owner can set up the GitHub App in Settings → Git, then try again.");
  const sha = await headSha(builderId);
  if (!sha) throw new ExportError(409, "The app has no commits yet");

  const installs = await db.gitHubInstallation.findMany({ where: { teamId: bp.teamId, suspendedAt: null }, orderBy: { createdAt: "asc" } });
  const inst =
    input.installationId !== undefined
      ? installs.find((i) => i.id === String(input.installationId) || String(i.installationId) === String(input.installationId))
      : installs.length === 1
        ? installs[0]
        : undefined;
  if (!inst) {
    throw new ExportError(
      400,
      installs.length ? "Choose the GitHub account or organization to export to (installationId)." : "Install the LevantDeploy GitHub App on your GitHub account or organization first (Team settings → Git).",
    );
  }
  const raw = input.repo.trim();
  const [ownerPart, namePart] = raw.includes("/") ? (raw.split("/", 2) as [string, string]) : [inst.accountLogin, raw];
  if (ownerPart.toLowerCase() !== inst.accountLogin.toLowerCase()) throw new ExportError(400, `The repository must belong to ${inst.accountLogin}`);
  const name = slug(namePart);
  const full = `${inst.accountLogin}/${name}`;

  let repo: GhRepo | null = null;
  let created = false;
  try {
    repo = await getRepo(inst.installationId, full);
  } catch (e) {
    if (!(e instanceof GitHubApiError) || e.status !== 404) throw new ExportError(502, `GitHub: ${(e as Error).message}`);
  }
  if (repo) {
    // an existing repository is only used when it is empty (no branches yet)
    const branches = await ghAsInstallation<unknown[]>(inst.installationId, "GET", `/repos/${full}/branches`, { query: { per_page: 1 } }).catch(() => []);
    if (branches.length) throw new ExportError(409, `${full} already has commits. Choose a new repository name.`);
  } else {
    if (inst.accountType !== "Organization") {
      throw new ExportError(
        400,
        `GitHub only lets apps create repositories in organizations. Create an empty repository "${name}" on GitHub under ${inst.accountLogin}, give the LevantDeploy app access to it, then export again.`,
      );
    }
    try {
      repo = await ghAsInstallation<GhRepo>(inst.installationId, "POST", `/orgs/${inst.accountLogin}/repos`, {
        body: { name, private: input.private ?? true, description: (input.description ?? bp.description ?? `${bp.name} — built with LevantDeploy`).slice(0, 300), auto_init: false },
      });
      created = true;
    } catch (e) {
      const st = e instanceof GitHubApiError ? e.status : 502;
      throw new ExportError(st === 422 ? 409 : 502, st === 422 ? `${full} already exists or the name is invalid` : `GitHub: ${(e as Error).message} (the app needs the "Administration: write" permission to create repositories)`);
    }
  }
  const token = await getInstallationToken(inst.installationId, { force: true });
  const url = new URL(`${githubWebUrl()}/${full}.git`);
  url.username = "x-access-token";
  url.password = token;
  try {
    await gitIn(repoDir(builderId), ["push", "--quiet", url.toString(), `${sha}:refs/heads/main`], { env: { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true" } });
  } catch (e) {
    throw new ExportError(502, `Push to GitHub failed: ${scrub((e as Error).message, token)}`);
  }
  return { url: repo?.html_url ?? `${githubWebUrl()}/${full}`, repo: full, created, sha };
}
