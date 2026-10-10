import crypto from "node:crypto";
import { SignJWT, jwtVerify, decodeJwt } from "jose";
import { decryptJson, encryptJson } from "@/lib/crypto";

/**
 * Per-project secrets, generated once at create time and stored encrypted (BaseProject.secretsEnc).
 * Nothing here ever uses upstream's example values (.env.example): every value is random per project.
 */
export type BaseSecrets = {
  postgresPassword: string;
  /** HS256 secret shared by auth/rest/realtime/storage/functions (≥ 40 chars) */
  jwtSecret: string;
  anonKey: string;
  serviceRoleKey: string;
  /** realtime + supavisor (≥ 64 chars) */
  secretKeyBase: string;
  /** supavisor vault key (exactly 32 chars) */
  vaultEncKey: string;
  /** postgres-meta / studio connection-string encryption (≥ 32 chars) */
  pgMetaCryptoKey: string;
  /** realtime tenant secret encryption (AES-128 → exactly 16 chars) */
  realtimeDbEncKey: string;
  s3ProtocolAccessKeyId: string;
  s3ProtocolAccessKeySecret: string;
  /** upstream envoy basic auth (Studio route removed in our template — random, unused) */
  dashboardPassword: string;
  /** header Caddy adds after SSO forward-auth, required by the gateway's Studio listener (:8001) */
  studioGateSecret: string;
  logflarePublicToken: string;
  logflarePrivateToken: string;
};

export const JWT_ISSUER = "levantbase";
/** API keys are long lived (like upstream's ~5 year demo keys); rotate by re-generating secrets. */
export const API_KEY_TTL_SEC = 10 * 365 * 86400;

const alnum = (len: number) => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  while (out.length < len) {
    for (const b of crypto.randomBytes(len * 2)) {
      if (b < 248 && out.length < len) out += alphabet[b % 62]; // 248 = 4*62 → unbiased
    }
  }
  return out;
};
const hex = (bytes: number) => crypto.randomBytes(bytes).toString("hex");

/** Passwords end up in URLs (postgres://user:pw@…) and compose .env files → letters and digits only. */
export const DB_PASSWORD_RE = /^[A-Za-z0-9]{16,128}$/;

export async function signApiKey(jwtSecret: string, role: "anon" | "service_role", ref: string, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  return new SignJWT({ role, ref })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(JWT_ISSUER)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + API_KEY_TTL_SEC)
    .sign(new TextEncoder().encode(jwtSecret));
}

export async function verifyApiKey(token: string, jwtSecret: string): Promise<{ role: string; ref?: string; iss?: string; exp?: number }> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(jwtSecret), { algorithms: ["HS256"] });
  return payload as { role: string; ref?: string; iss?: string; exp?: number };
}

export const apiKeyRole = (token: string) => String(decodeJwt(token).role ?? "");

export async function generateSecrets(ref: string, opts: { dbPassword?: string } = {}): Promise<BaseSecrets> {
  if (opts.dbPassword !== undefined && !DB_PASSWORD_RE.test(opts.dbPassword)) {
    throw new Error("Database password must be 16–128 letters and digits");
  }
  const jwtSecret = alnum(64);
  return {
    postgresPassword: opts.dbPassword ?? alnum(40),
    jwtSecret,
    anonKey: await signApiKey(jwtSecret, "anon", ref),
    serviceRoleKey: await signApiKey(jwtSecret, "service_role", ref),
    secretKeyBase: alnum(64),
    vaultEncKey: alnum(32),
    pgMetaCryptoKey: alnum(48),
    realtimeDbEncKey: alnum(16),
    s3ProtocolAccessKeyId: hex(16),
    s3ProtocolAccessKeySecret: hex(32),
    dashboardPassword: alnum(40),
    studioGateSecret: alnum(48),
    logflarePublicToken: alnum(40),
    logflarePrivateToken: alnum(40),
  };
}

export const encryptSecrets = (s: BaseSecrets) => encryptJson(s);
export function decryptSecrets(blob: string): BaseSecrets {
  const s = decryptJson<BaseSecrets>(blob);
  if (!s?.jwtSecret) throw new Error("Base project secrets cannot be decrypted (ENCRYPTION_KEY changed?)");
  return s;
}
