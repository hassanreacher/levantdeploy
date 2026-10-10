import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { cached, invalidate } from "@/lib/redis";
import { SESSION_COOKIE, SESSION_DAYS, TWO_FA_COOKIE, signJwt, verifySessionJwt } from "./jwt";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  avatar: string | null;
  isPlatformOwner: boolean;
  totpEnabled: boolean;
};

export type Session = { sessionId: string; user: SessionUser };

async function loadSession(sid: string): Promise<(Session & { expiresAt: string }) | null> {
  const s = await db.session.findUnique({
    where: { id: sid },
    include: { user: { select: { id: true, email: true, name: true, avatar: true, isPlatformOwner: true, totpEnabled: true, disabledAt: true } } },
  });
  if (!s || s.revokedAt || s.expiresAt < new Date() || s.user.disabledAt) return null;
  const { disabledAt: _d, ...user } = s.user;
  return { sessionId: s.id, user, expiresAt: s.expiresAt.toISOString() };
}

/** Cookie session only (API tokens are handled by requireApiTokenOrSession in lib/http). */
export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const payload = await verifySessionJwt(token);
  if (!payload) return null;
  const s = await cached(`sess:${payload.sid}`, 30, () => loadSession(payload.sid));
  if (!s || new Date(s.expiresAt) < new Date()) return null;
  touchSession(s.sessionId);
  return { sessionId: s.sessionId, user: s.user };
}

const touched = new Map<string, number>();
/** Updates Session.lastSeenAt at most every 5 minutes per session (fire-and-forget). */
function touchSession(id: string) {
  const now = Date.now();
  if ((touched.get(id) ?? 0) > now - 300_000) return;
  touched.set(id, now);
  if (touched.size > 20_000) touched.clear();
  void db.session.update({ where: { id }, data: { lastSeenAt: new Date() } }).catch(() => {});
}

export async function getUser(): Promise<SessionUser | null> {
  return (await getSession())?.user ?? null;
}

/** For server components / layouts: redirects to /login when signed out. */
export async function requireUser(nextPath?: string): Promise<SessionUser> {
  const u = await getUser();
  if (!u) redirect(`/login${nextPath ? `?next=${encodeURIComponent(nextPath)}` : ""}`);
  return u;
}

export async function requestMeta() {
  const h = await headers();
  return {
    ip: h.get("cf-connecting-ip") || h.get("x-real-ip") || h.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
    userAgent: h.get("user-agent")?.slice(0, 300) ?? null,
  };
}

export async function createSession(userId: string, opts: { days?: number } = {}) {
  const days = opts.days ?? SESSION_DAYS;
  const meta = await requestMeta();
  const session = await db.session.create({
    data: { userId, ip: meta.ip, userAgent: meta.userAgent, expiresAt: new Date(Date.now() + days * 86400_000) },
  });
  const token = await signJwt({ sid: session.id, uid: userId }, `${days}d`);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.PLATFORM_SCHEME === "https" || (process.env.NODE_ENV === "production" && process.env.PLATFORM_SCHEME !== "http"),
    sameSite: "lax",
    path: "/",
    maxAge: days * 86400,
  });
  jar.delete(TWO_FA_COOKIE);
  await db.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  return { sessionId: session.id };
}

export async function destroySession() {
  const s = await getSession();
  if (s) await revokeSession(s.sessionId);
  (await cookies()).set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
}

export async function revokeSession(sessionId: string) {
  await db.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } }).catch(() => {});
  await invalidate(`sess:${sessionId}`);
}

/** Revoke every session of a user (password change / reset). */
export async function revokeAllSessions(userId: string, exceptSessionId?: string) {
  const list = await db.session.findMany({ where: { userId, revokedAt: null }, select: { id: true } });
  await db.session.updateMany({
    where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    data: { revokedAt: new Date() },
  });
  await invalidate(...list.filter((s) => s.id !== exceptSessionId).map((s) => `sess:${s.id}`));
}

/** Refresh cached session data after profile changes. */
export async function refreshUserSessions(userId: string) {
  const list = await db.session.findMany({ where: { userId, revokedAt: null }, select: { id: true } });
  await invalidate(...list.map((s) => `sess:${s.id}`));
}
