// Edge-safe JWT helpers (used by middleware and server). No Node APIs here.
import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "ld_session";
export const TWO_FA_COOKIE = "ld_2fa";
export const TEAM_COOKIE = "ld_team";
export const SESSION_DAYS = 30;
const ISSUER = "levantdeploy";

export type SessionJwt = { sid: string; uid: string };
export type TwoFactorJwt = { uid: string; purpose: "2fa"; remember?: boolean };

function key() {
  const s = process.env.SESSION_SECRET || (process.env.NODE_ENV !== "production" ? "dev-only-session-secret-change-me-dev-only-secret" : "");
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be at least 32 chars");
  return new TextEncoder().encode(s);
}

export async function signJwt(payload: Record<string, unknown>, expires: string) {
  return new SignJWT(payload).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setIssuer(ISSUER).setExpirationTime(expires).sign(key());
}

async function verify(token: string): Promise<Record<string, unknown> | null> {
  try {
    const { payload } = await jwtVerify(token, key(), { issuer: ISSUER, algorithms: ["HS256"] });
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function verifySessionJwt(token: string): Promise<SessionJwt | null> {
  const p = await verify(token);
  if (!p || typeof p.sid !== "string" || typeof p.uid !== "string" || p.purpose) return null;
  return { sid: p.sid, uid: p.uid };
}

export async function verifyTwoFactorJwt(token: string): Promise<TwoFactorJwt | null> {
  const p = await verify(token);
  if (!p || p.purpose !== "2fa" || typeof p.uid !== "string") return null;
  return { uid: p.uid, purpose: "2fa", remember: !!p.remember };
}
