import { appUrl } from "@/lib/env";
import { redis } from "@/lib/redis";
import { randomToken } from "@/lib/crypto";
import { getSetting } from "@/lib/settings";
import { githubApiUrl, githubWebUrl, saveGitHubApp } from "./config";
import { gh } from "./api";

/** Permissions + events the LevantDeploy GitHub App needs. */
export const APP_PERMISSIONS = {
  contents: "read",
  metadata: "read",
  pull_requests: "write",
  statuses: "write",
  deployments: "write",
  checks: "write",
} as const;
/** `installation` / `installation_repositories` are always delivered to GitHub Apps and are not valid manifest events. */
export const APP_EVENTS = ["push", "pull_request", "delete"] as const;
export const HANDLED_EVENTS = ["push", "pull_request", "delete", "installation", "installation_repositories", "ping"] as const;

export function buildManifest(opts: { name?: string; baseUrl?: string; platformName?: string } = {}) {
  const base = (opts.baseUrl || appUrl()).replace(/\/$/, "");
  return {
    name: (opts.name || `${opts.platformName || "LevantDeploy"} ${new URL(base).hostname}`).slice(0, 34),
    url: base,
    description: "Deploys your repositories to a self-hosted LevantDeploy server (previews, commit statuses, PR comments).",
    hook_attributes: { url: `${base}/api/v1/webhooks/github`, active: true },
    redirect_url: `${base}/api/v1/github/app/callback`,
    callback_urls: [`${base}/api/v1/github/callback`],
    setup_url: `${base}/api/v1/github/callback`,
    setup_on_update: true,
    request_oauth_on_install: true,
    public: false,
    default_permissions: APP_PERMISSIONS,
    default_events: APP_EVENTS,
  };
}

// ───────────── short-lived state tokens (manifest + install flows) ─────────────

export type GitHubFlowState = { kind: "manifest" | "install"; userId: string; teamSlug?: string | null; teamId?: string | null };

export async function createFlowState(s: GitHubFlowState, ttlSec = 3600): Promise<string> {
  const token = randomToken(24);
  await redis().set(`ld:gh:state:${token}`, JSON.stringify(s), "EX", ttlSec);
  return token;
}

export async function readFlowState(token: string | null | undefined, opts: { consume?: boolean } = {}): Promise<GitHubFlowState | null> {
  if (!token || !/^[A-Za-z0-9_-]{10,64}$/.test(token)) return null;
  const key = `ld:gh:state:${token}`;
  const raw = await redis().get(key);
  if (raw && opts.consume) await redis().del(key);
  return raw ? (JSON.parse(raw) as GitHubFlowState) : null;
}

/** URL + manifest JSON for the "Create GitHub App" form POST (personal account or organization). */
export async function manifestFormTarget(userId: string, opts: { org?: string | null; teamSlug?: string | null } = {}) {
  const platformName = await getSetting("platform.name").catch(() => "LevantDeploy");
  const state = await createFlowState({ kind: "manifest", userId, teamSlug: opts.teamSlug ?? null });
  const web = githubWebUrl();
  const action = opts.org
    ? `${web}/organizations/${encodeURIComponent(opts.org)}/settings/apps/new?state=${state}`
    : `${web}/settings/apps/new?state=${state}`;
  return { action, manifest: buildManifest({ platformName }), state };
}

type ManifestConversion = {
  id: number;
  slug: string;
  client_id: string;
  client_secret: string;
  webhook_secret: string;
  pem: string;
  html_url: string;
  owner?: { login: string };
};

/** Exchanges the temporary manifest `code` for the app credentials and stores them (encrypted). */
export async function convertManifest(code: string) {
  if (!/^[A-Za-z0-9_-]{4,128}$/.test(code)) throw new Error("Invalid manifest code");
  const res = await gh<ManifestConversion>("POST", `/app-manifests/${code}/conversions`);
  await saveGitHubApp({
    appId: res.id,
    slug: res.slug,
    privateKey: res.pem,
    webhookSecret: res.webhook_secret,
    clientId: res.client_id,
    clientSecret: res.client_secret,
    htmlUrl: res.html_url,
  });
  return { appId: res.id, slug: res.slug, htmlUrl: res.html_url };
}

/** Exchanges a user OAuth code (request_oauth_on_install) for a user token. */
export async function exchangeUserCode(clientId: string, clientSecret: string, code: string): Promise<string | null> {
  const res = await fetch(`${githubWebUrl()}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => null)) as { access_token?: string } | null;
  return data?.access_token ?? null;
}

/** True when the GitHub user behind `userToken` can access the installation. */
export async function userCanAccessInstallation(userToken: string, installationId: number): Promise<boolean> {
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(`${githubApiUrl()}/user/installations?per_page=100&page=${page}`, {
      headers: { authorization: `token ${userToken}`, accept: "application/vnd.github+json", "user-agent": "LevantDeploy" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { installations: Array<{ id: number }> };
    if (data.installations.some((i) => i.id === installationId)) return true;
    if (data.installations.length < 100) break;
  }
  return false;
}
