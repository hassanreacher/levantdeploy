import { githubApiUrl } from "./config";

export class GitHubApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

/**
 * Minimal GitHub REST client (no Octokit dependency).
 *   await gh("GET", "/repos/o/r", { token })
 *   await gh("POST", "/repos/o/r/statuses/sha", { token, body: {...} })
 * `token` is an installation token ("token" auth) or an app JWT (`jwt`, "Bearer").
 */
export async function gh<T = unknown>(
  method: string,
  path: string,
  opts: { token?: string; jwt?: string; body?: unknown; query?: Record<string, string | number | undefined>; timeoutMs?: number } = {},
): Promise<T> {
  const url = new URL(githubApiUrl() + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "LevantDeploy",
  };
  if (opts.jwt) headers.authorization = `Bearer ${opts.jwt}`;
  else if (opts.token) headers.authorization = `token ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = (data as { message?: string } | null)?.message ?? `GitHub API ${method} ${path} failed (${res.status})`;
    throw new GitHubApiError(res.status, msg, data);
  }
  return data as T;
}
