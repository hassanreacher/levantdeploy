import crypto from "node:crypto";

/**
 * Encryption at rest (env var values, DB credentials, deploy keys, TOTP secrets, webhook secrets).
 * AES-256-GCM with a key derived from ENCRYPTION_KEY. Format: v1.<iv>.<tag>.<ciphertext> (base64url).
 * NEVER change the derivation: existing rows would become unreadable.
 */
let _key: Buffer | null = null;
function key() {
  if (_key) return _key;
  const secret = process.env.ENCRYPTION_KEY || (process.env.NODE_ENV !== "production" ? "dev-only-encryption-key-change-me" : "");
  if (!secret || secret.length < 16) throw new Error("ENCRYPTION_KEY must be set (32+ random chars)");
  _key = crypto.createHash("sha256").update(`levantdeploy-enc:${secret}`).digest();
  return _key;
}

export function encryptString(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), enc.toString("base64url")].join(".");
}

/** Returns null when the blob is missing, malformed or was encrypted with another key. */
export function decryptString(blob: string | null | undefined): string | null {
  if (!blob) return null;
  const [v, iv, tag, data] = blob.split(".");
  if (v !== "v1" || !iv || !tag || data === undefined) return null;
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function encryptJson(value: unknown): string {
  return encryptString(JSON.stringify(value));
}

export function decryptJson<T = Record<string, unknown>>(blob: string | null | undefined): T | null {
  const s = decryptString(blob);
  if (s === null) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

export const sha256 = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");
export const hmacSha256 = (secret: string, data: string | Buffer) => crypto.createHmac("sha256", secret).update(data).digest("hex");
/** URL-safe random token (default 32 bytes → 43 chars). */
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
/** Lowercase [a-z0-9] id of the given length (DNS-label safe). */
export function randomId(len = 9): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}
export function timingSafeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
/** Show only the last 4 characters of a secret in the UI. */
export const maskSecret = (s?: string | null) => (s ? `••••${s.slice(-4)}` : "");
