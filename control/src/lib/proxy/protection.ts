import { hmacSha256, timingSafeEqual } from "@/lib/crypto";
import { readProtection, type Protection } from "@/lib/dashboard/protection";
import { db } from "@/lib/db";
import { resolveHost } from "./hosts";

/**
 * Deployment protection, "password" mode (control side of the forward-auth done by Caddy, see proxy/config.ts):
 *   cookie `__levant_auth` = `<projectId>.<expiresUnix>.<sig>`, sig = HMAC(SESSION_SECRET, projectId.exp.hashFingerprint)
 *   → changing the password (new hash) invalidates every cookie. Host-only cookie, 7 days.
 */
export const AUTH_COOKIE = "__levant_auth";
export const AUTH_TTL_SEC = 7 * 86400;

function secret() {
  return process.env.SESSION_SECRET || "dev-only-session-secret-change-me-dev-only-secret";
}
const fingerprint = (hash: string) => hash.slice(-16);

export function signAuthCookie(projectId: string, passwordHash: string, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + AUTH_TTL_SEC;
  return `${projectId}.${exp}.${hmacSha256(secret(), `${projectId}.${exp}.${fingerprint(passwordHash)}`)}`;
}

export function verifyAuthCookie(value: string | null | undefined, projectId: string, passwordHash: string, now = Date.now()): boolean {
  if (!value) return false;
  const [pid, exp, sig] = value.split(".");
  if (!pid || !exp || !sig || pid !== projectId) return false;
  if (Number(exp) * 1000 < now) return false;
  return timingSafeEqual(sig, hmacSha256(secret(), `${pid}.${exp}.${fingerprint(passwordHash)}`));
}

export function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** Only same-site relative paths (no open redirects). */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next.slice(0, 2000);
}

// small in-process cache: host → { projectId, protection } (proxy calls this on every protected request)
const cache = new Map<string, { at: number; v: { projectId: string; protection: Protection } | null }>();

export async function protectionForHost(host: string): Promise<{ projectId: string; protection: Protection } | null> {
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < 10_000) return hit.v;
  const r = await resolveHost(host);
  let v: { projectId: string; protection: Protection } | null = null;
  if (r.kind === "deployment" || r.kind === "domain" || r.kind === "branch") {
    const p = await db.project.findUnique({ where: { id: r.project.id }, select: { id: true, protection: true } });
    if (p) v = { projectId: p.id, protection: readProtection(p.protection) };
  }
  if (cache.size > 5000) cache.clear();
  cache.set(host, { at: Date.now(), v });
  return v;
}
