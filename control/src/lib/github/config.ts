import { decryptString, encryptString } from "@/lib/crypto";
import { getSetting, setSetting } from "@/lib/settings";

/**
 * GitHub App credentials. Source of truth: the `github.app` Setting (created by the manifest flow or entered manually,
 * secrets encrypted). Falls back to GITHUB_APP_* env vars. API/web base URLs can be overridden for GitHub Enterprise
 * or tests (GITHUB_API_URL, GITHUB_WEB_URL).
 */
export type GitHubAppConfig = {
  appId: string;
  slug: string;
  privateKey: string;
  webhookSecret: string;
  clientId?: string;
  clientSecret?: string;
  htmlUrl?: string;
  source: "settings" | "env";
};

export const githubApiUrl = () => (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
export const githubWebUrl = () => (process.env.GITHUB_WEB_URL || "https://github.com").replace(/\/$/, "");

/** Normalise a PEM pasted with literal "\n" sequences (env files). */
export function normalizePem(pem: string): string {
  return pem.includes("\\n") && !pem.includes("\n") ? pem.replace(/\\n/g, "\n") : pem.trim() + "\n";
}

export async function getGitHubApp(): Promise<GitHubAppConfig | null> {
  const s = await getSetting("github.app").catch(() => null);
  if (s) {
    const privateKey = decryptString(s.privateKeyEnc);
    const webhookSecret = decryptString(s.webhookSecretEnc);
    if (privateKey && webhookSecret !== null) {
      return {
        appId: s.appId,
        slug: s.slug,
        privateKey: normalizePem(privateKey),
        webhookSecret,
        clientId: s.clientId,
        clientSecret: decryptString(s.clientSecretEnc) ?? undefined,
        htmlUrl: s.htmlUrl,
        source: "settings",
      };
    }
  }
  const e = process.env;
  if (e.GITHUB_APP_ID && e.GITHUB_APP_PRIVATE_KEY && e.GITHUB_APP_WEBHOOK_SECRET) {
    return {
      appId: e.GITHUB_APP_ID,
      slug: e.GITHUB_APP_SLUG || "",
      privateKey: normalizePem(e.GITHUB_APP_PRIVATE_KEY),
      webhookSecret: e.GITHUB_APP_WEBHOOK_SECRET,
      clientId: e.GITHUB_APP_CLIENT_ID,
      clientSecret: e.GITHUB_APP_CLIENT_SECRET,
      source: "env",
    };
  }
  return null;
}

export async function saveGitHubApp(input: {
  appId: string | number;
  slug: string;
  privateKey: string;
  webhookSecret: string;
  clientId?: string | null;
  clientSecret?: string | null;
  htmlUrl?: string | null;
}) {
  await setSetting("github.app", {
    appId: String(input.appId),
    slug: input.slug,
    clientId: input.clientId ?? undefined,
    clientSecretEnc: input.clientSecret ? encryptString(input.clientSecret) : undefined,
    privateKeyEnc: encryptString(normalizePem(input.privateKey)),
    webhookSecretEnc: encryptString(input.webhookSecret),
    htmlUrl: input.htmlUrl ?? undefined,
  });
}

export async function deleteGitHubApp() {
  await setSetting("github.app", null);
}

/** Public, non-secret view for the UI. */
export async function gitHubAppStatus() {
  const app = await getGitHubApp();
  if (!app) return { configured: false as const };
  return {
    configured: true as const,
    appId: app.appId,
    slug: app.slug,
    source: app.source,
    htmlUrl: app.htmlUrl ?? (app.slug ? `${githubWebUrl()}/apps/${app.slug}` : null),
    installUrl: app.slug ? `${githubWebUrl()}/apps/${app.slug}/installations/new` : null,
  };
}
