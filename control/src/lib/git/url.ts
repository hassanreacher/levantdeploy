/**
 * Git URL helpers (pure, client-safe).
 * Accepted: https://host/path(.git), http:// (dev), ssh://[user@]host[:port]/path, scp-like user@host:path,
 * git://host/path, file:// (only when GIT_ALLOW_FILE_URLS=1 — tests / local dev).
 */
export type ParsedGitUrl = {
  protocol: "https" | "http" | "ssh" | "git" | "file";
  host: string;
  /** owner/repo (without .git) — best effort */
  path: string;
  /** URL without credentials */
  clean: string;
  isSsh: boolean;
  user?: string;
};

const SCP_RE = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(?!\/\/)([^\s]+)$/;

export function parseGitUrl(input: string): ParsedGitUrl | null {
  const s = input.trim();
  if (!s || s.startsWith("-") || /\s/.test(s)) return null;
  const scp = SCP_RE.exec(s);
  if (scp) {
    const path = scp[3]!.replace(/^\/+/, "").replace(/\.git$/, "");
    return { protocol: "ssh", host: scp[2]!.toLowerCase(), path, clean: s, isSsh: true, user: scp[1] };
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const proto = u.protocol.replace(/:$/, "");
  if (!["https", "http", "ssh", "git", "file"].includes(proto)) return null;
  const path = decodeURIComponent(u.pathname).replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  if (proto !== "file" && (!u.hostname || !path)) return null;
  const user = u.username || undefined;
  if (proto !== "ssh") {
    u.username = "";
    u.password = "";
  }
  return { protocol: proto as ParsedGitUrl["protocol"], host: u.hostname.toLowerCase(), path, clean: u.toString(), isSsh: proto === "ssh", user };
}

/** Remove any credentials from a URL (for logs / display). */
export function redactGitUrl(url: string): string {
  return url.replace(/(https?:\/\/)[^@/\s]+@/i, "$1");
}

/** Default HTTPS username for token auth per host (GitHub accepts anything; GitLab wants oauth2; Bitbucket x-token-auth). */
export function defaultTokenUsername(host: string): string {
  if (host.includes("gitlab")) return "oauth2";
  if (host.includes("bitbucket")) return "x-token-auth";
  if (host.includes("github")) return "x-access-token";
  return "git";
}

/** Suggest a project name from a repo URL. */
export function repoNameFromUrl(url: string): string {
  const p = parseGitUrl(url);
  const last = (p?.path ?? url).split("/").filter(Boolean).pop() ?? "app";
  return last.replace(/\.git$/, "");
}

/** `https://github.com/o/r` style URL → "o/r" when the host is github.com. */
export function githubFullName(url: string): string | null {
  const p = parseGitUrl(url);
  if (!p || p.host !== "github.com") return null;
  const parts = p.path.split("/");
  return parts.length === 2 ? `${parts[0]}/${parts[1]}` : null;
}
