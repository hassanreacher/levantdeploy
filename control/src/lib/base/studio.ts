import { db } from "@/lib/db";
import { hmacSha256, randomToken, sha256, timingSafeEqual } from "@/lib/crypto";
import { redis } from "@/lib/redis";
import { hasRole } from "@/lib/auth/roles";
import { queues } from "@/lib/queues";
import { STUDIO_LAST_KEY, STUDIO_RUNNING_KEY, studioUrl } from "./config";

/**
 * Studio SSO (Studio itself has no auth — it must never be reachable without this):
 *   1. dashboard: `issueStudioToken(ref, userId)` → one-time token (Redis, 60 s) → redirect the browser to
 *      https://studio-{ref}.{BASE_DOMAIN}/__levant/sso?t=<token>
 *   2. Caddy routes that path to control `/api/internal/base/studio-sso` → `redeemStudioToken` → host-only cookie
 *      `__levant_studio` (HttpOnly, Secure over https, SameSite=Lax, 12 h) → 303 /project/default
 *   3. every other request: Caddy forward_auth → `/api/internal/base/studio-auth` → `checkStudioCookie` (signature,
 *      expiry, ref = host, user still a MEMBER+ of the team) → 2xx continues to the gateway's Studio listener with
 *      the per-project gate header; otherwise 401 page.
 */
export const STUDIO_COOKIE = "__levant_studio";
export const STUDIO_TOKEN_TTL_SEC = 60;
export const STUDIO_COOKIE_TTL_SEC = 12 * 3600;
const TOKEN_KEY = (t: string) => `lb:studio:sso:${sha256(t)}`;

function secret() {
  return `${process.env.SESSION_SECRET || "dev-only-session-secret-change-me-dev-only-secret"}:levantbase-studio`;
}

/** May this user open Studio for this project? (team role ≥ MEMBER) */
export async function canOpenStudio(ref: string, userId: string): Promise<boolean> {
  const p = await db.baseProject.findUnique({ where: { ref }, select: { teamId: true } });
  if (!p) return false;
  const m = await db.membership.findUnique({ where: { teamId_userId: { teamId: p.teamId, userId } }, select: { role: true } });
  const u = await db.user.findUnique({ where: { id: userId }, select: { disabledAt: true } });
  return !!m && !!u && !u.disabledAt && hasRole(m.role, "MEMBER");
}

/** One-time SSO URL for the dashboard's "Open Studio" button (also starts Studio if it isn't running). */
export async function issueStudioToken(ref: string, userId: string): Promise<{ url: string; token: string; expiresIn: number }> {
  if (!(await canOpenStudio(ref, userId))) throw new Error("not allowed to open Studio for this project");
  const token = randomToken(32);
  await redis().set(TOKEN_KEY(token), JSON.stringify({ ref, userId }), "EX", STUDIO_TOKEN_TTL_SEC);
  await ensureStudioRunning(ref, userId);
  return { url: `${studioUrl(ref)}/__levant/sso?t=${encodeURIComponent(token)}`, token, expiresIn: STUDIO_TOKEN_TTL_SEC };
}

/** GETDEL the token; must belong to this ref. */
export async function redeemStudioToken(token: string, ref: string): Promise<{ userId: string } | null> {
  if (!token || token.length > 200) return null;
  const raw = await redis().getdel(TOKEN_KEY(token));
  if (!raw) return null;
  const v = JSON.parse(raw) as { ref: string; userId: string };
  if (v.ref !== ref) return null;
  if (!(await canOpenStudio(ref, v.userId))) return null;
  return { userId: v.userId };
}

export function signStudioCookie(ref: string, userId: string, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + STUDIO_COOKIE_TTL_SEC;
  return `${userId}.${ref}.${exp}.${hmacSha256(secret(), `${userId}.${ref}.${exp}`)}`;
}

/** Signature + expiry + ref only (pure, tested). */
export function parseStudioCookie(value: string | null | undefined, ref: string, now = Date.now()): { userId: string } | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const [userId, r, exp, sig] = parts as [string, string, string, string];
  if (r !== ref || !/^\d+$/.test(exp) || Number(exp) * 1000 < now) return null;
  if (!timingSafeEqual(sig, hmacSha256(secret(), `${userId}.${r}.${exp}`))) return null;
  return { userId };
}

const memberCache = new Map<string, { at: number; ok: boolean }>();

/** Full check used by forward-auth (membership re-checked, cached 30 s). Also records Studio activity. */
export async function checkStudioCookie(value: string | null | undefined, ref: string): Promise<{ userId: string } | null> {
  const c = parseStudioCookie(value, ref);
  if (!c) return null;
  const key = `${c.userId}:${ref}`;
  const hit = memberCache.get(key);
  let ok: boolean;
  if (hit && Date.now() - hit.at < 30_000) ok = hit.ok;
  else {
    ok = await canOpenStudio(ref, c.userId);
    if (memberCache.size > 5000) memberCache.clear();
    memberCache.set(key, { at: Date.now(), ok });
  }
  if (!ok) return null;
  void touchStudio(ref);
  return c;
}

let lastTouch = new Map<string, number>();
async function touchStudio(ref: string) {
  const now = Date.now();
  if (now - (lastTouch.get(ref) ?? 0) < 15_000) return;
  if (lastTouch.size > 5000) lastTouch = new Map();
  lastTouch.set(ref, now);
  await redis().set(STUDIO_LAST_KEY(ref), String(now)).catch(() => {});
  await ensureStudioRunning(ref).catch(() => {});
}

export async function studioRunning(ref: string): Promise<boolean> {
  return (await redis().get(STUDIO_RUNNING_KEY(ref)).catch(() => null)) === "1";
}

/** Enqueue studio-start once (deduped by job id) when it isn't running. */
export async function ensureStudioRunning(ref: string, byUserId?: string | null) {
  if (await studioRunning(ref)) return false;
  const jobId = `base-studio-start-${ref}`;
  const existing = await queues.base.raw.getJob(jobId);
  if (existing) {
    const st = await existing.getState();
    if (st === "waiting" || st === "active" || st === "delayed") return true;
    await existing.remove().catch(() => {});
  }
  await queues.base.add({ action: "studio-start", ref, byUserId: byUserId ?? null }, { jobId });
  return true;
}
