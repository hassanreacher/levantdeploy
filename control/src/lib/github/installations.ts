import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { decryptString, encryptString } from "@/lib/crypto";
import { getGitHubApp } from "./config";
import { createAppJwt } from "./jwt";
import { gh, GitHubApiError } from "./api";

export type GhAccount = { login: string; type: string; avatar_url?: string; id?: number };
export type GhInstallation = { id: number; account: GhAccount | null; repository_selection?: string; suspended_at?: string | null; app_slug?: string };
export type GhRepo = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  html_url: string;
  clone_url: string;
  pushed_at: string | null;
  updated_at?: string;
  description: string | null;
  language?: string | null;
  owner: { login: string; avatar_url?: string };
};

const tokenKey = (installationId: number) => `ld:gh:itoken:${installationId}`;

async function appJwt() {
  const app = await getGitHubApp();
  if (!app) throw new Error("The GitHub App is not configured");
  return createAppJwt(app);
}

/**
 * Installation access token, cached (encrypted) in Redis until 5 minutes before it expires (GitHub: 1 h).
 * Optionally scoped to repositories (not cached).
 */
export async function getInstallationToken(installationId: number, opts: { force?: boolean; repositoryIds?: number[] } = {}): Promise<string> {
  const r = redis();
  if (!opts.force && !opts.repositoryIds) {
    const hit = decryptString(await r.get(tokenKey(installationId)).catch(() => null));
    if (hit) return hit;
  }
  const res = await gh<{ token: string; expires_at: string }>("POST", `/app/installations/${installationId}/access_tokens`, {
    jwt: await appJwt(),
    body: opts.repositoryIds ? { repository_ids: opts.repositoryIds } : undefined,
  });
  if (!opts.repositoryIds) {
    const ttl = Math.floor((new Date(res.expires_at).getTime() - Date.now()) / 1000) - 300;
    if (ttl > 30) await r.set(tokenKey(installationId), encryptString(res.token), "EX", ttl).catch(() => {});
  }
  return res.token;
}

export async function forgetInstallationToken(installationId: number) {
  await redis().del(tokenKey(installationId)).catch(() => {});
}

/** Calls the API with an installation token; retries once with a fresh token on 401. */
export async function ghAsInstallation<T>(installationId: number, method: string, path: string, opts: Parameters<typeof gh>[2] = {}): Promise<T> {
  try {
    return await gh<T>(method, path, { ...opts, token: await getInstallationToken(installationId) });
  } catch (e) {
    if (e instanceof GitHubApiError && e.status === 401) {
      return gh<T>(method, path, { ...opts, token: await getInstallationToken(installationId, { force: true }) });
    }
    throw e;
  }
}

export async function getInstallation(installationId: number): Promise<GhInstallation> {
  return gh<GhInstallation>("GET", `/app/installations/${installationId}`, { jwt: await appJwt() });
}

/** Upserts the GitHubInstallation row from GitHub (and links it to a team when given). */
export async function syncInstallation(installationId: number, teamId?: string | null) {
  const inst = await getInstallation(installationId);
  return upsertInstallation(inst, teamId);
}

export async function upsertInstallation(inst: GhInstallation, teamId?: string | null) {
  const data = {
    accountLogin: inst.account?.login ?? "unknown",
    accountType: inst.account?.type ?? "User",
    accountAvatar: inst.account?.avatar_url ?? null,
    repositorySelection: inst.repository_selection ?? null,
    suspendedAt: inst.suspended_at ? new Date(inst.suspended_at) : null,
  };
  return db.gitHubInstallation.upsert({
    where: { installationId: inst.id },
    create: { installationId: inst.id, teamId: teamId ?? null, ...data },
    update: { ...data, ...(teamId ? { teamId } : {}) },
  });
}

/**
 * Repositories accessible to an installation. GitHub has no server-side search for installation repos,
 * so pages are fetched (max 10 × 100) and cached 60 s, then filtered by `q`.
 */
export async function listInstallationRepos(installationId: number, opts: { q?: string; limit?: number; fresh?: boolean } = {}): Promise<GhRepo[]> {
  const r = redis();
  const key = `ld:gh:repos:${installationId}`;
  let repos: GhRepo[] | null = null;
  if (!opts.fresh) {
    const hit = await r.get(key).catch(() => null);
    if (hit) repos = JSON.parse(hit) as GhRepo[];
  }
  if (!repos) {
    repos = [];
    for (let page = 1; page <= 10; page++) {
      const res = await ghAsInstallation<{ total_count: number; repositories: GhRepo[] }>(installationId, "GET", "/installation/repositories", {
        query: { per_page: 100, page },
      });
      repos.push(...res.repositories);
      if (res.repositories.length < 100 || repos.length >= res.total_count) break;
    }
    repos.sort((a, b) => (b.pushed_at ?? "").localeCompare(a.pushed_at ?? ""));
    const slim = repos.map((x) => ({
      id: x.id,
      name: x.name,
      full_name: x.full_name,
      private: x.private,
      default_branch: x.default_branch,
      html_url: x.html_url,
      clone_url: x.clone_url,
      pushed_at: x.pushed_at,
      description: x.description,
      language: x.language ?? null,
      owner: { login: x.owner.login, avatar_url: x.owner.avatar_url },
    }));
    repos = slim;
    await r.set(key, JSON.stringify(slim), "EX", 60).catch(() => {});
  }
  const q = opts.q?.trim().toLowerCase();
  const out = q ? repos.filter((x) => x.full_name.toLowerCase().includes(q)) : repos;
  return out.slice(0, opts.limit ?? 100);
}

export async function getRepo(installationId: number, fullNameOrId: string | number): Promise<GhRepo> {
  const path = typeof fullNameOrId === "number" || /^\d+$/.test(String(fullNameOrId)) ? `/repositories/${fullNameOrId}` : `/repos/${fullNameOrId}`;
  return ghAsInstallation<GhRepo>(installationId, "GET", path);
}

export async function getBranchHead(installationId: number, fullName: string, branch: string) {
  const b = await ghAsInstallation<{ commit: { sha: string; commit: { message: string; author: { name: string } | null }; author: { login: string; avatar_url: string } | null } }>(
    installationId,
    "GET",
    `/repos/${fullName}/branches/${encodeURIComponent(branch)}`,
  );
  return {
    sha: b.commit.sha,
    message: b.commit.commit.message,
    author: b.commit.author?.login ?? b.commit.commit.author?.name ?? null,
    avatar: b.commit.author?.avatar_url ?? null,
  };
}

/** Root-level file names + selected file contents (for framework detection before import). */
export async function repoFiles(installationId: number, fullName: string, ref: string | undefined, dir = ""): Promise<{ files: string[]; read: (name: string) => Promise<string | null> }> {
  const clean = dir.replace(/^\/+|\/+$/g, "");
  let entries: Array<{ name: string; type: string; path: string }> = [];
  try {
    entries = await ghAsInstallation(installationId, "GET", `/repos/${fullName}/contents/${clean}`, { query: { ref } });
    if (!Array.isArray(entries)) entries = [];
  } catch (e) {
    if (!(e instanceof GitHubApiError && e.status === 404)) throw e;
  }
  return {
    files: entries.map((e) => (e.type === "dir" ? e.name + "/" : e.name)),
    read: async (name: string) => {
      try {
        const f = await ghAsInstallation<{ content?: string; encoding?: string }>(installationId, "GET", `/repos/${fullName}/contents/${clean ? clean + "/" : ""}${name}`, {
          query: { ref },
        });
        return f.content && f.encoding === "base64" ? Buffer.from(f.content, "base64").toString("utf8") : null;
      } catch {
        return null;
      }
    },
  };
}

/** Installations of a team (DB rows). */
export function teamInstallations(teamId: string) {
  return db.gitHubInstallation.findMany({ where: { teamId }, orderBy: { createdAt: "asc" } });
}
