import crypto from "node:crypto";
import { SignJWT } from "jose";
import type { GitHubAppConfig } from "./config";

/**
 * GitHub App JWT (RS256, ≤10 min). GitHub hands out PKCS#1 keys ("BEGIN RSA PRIVATE KEY"), which jose's importPKCS8
 * rejects — node:crypto parses both formats into a KeyObject that jose accepts directly.
 */
const keyCache = new Map<string, crypto.KeyObject>();

export function appPrivateKey(pem: string): crypto.KeyObject {
  let k = keyCache.get(pem);
  if (!k) {
    k = crypto.createPrivateKey({ key: pem, format: "pem" });
    keyCache.set(pem, k);
  }
  return k;
}

export async function createAppJwt(app: Pick<GitHubAppConfig, "appId" | "privateKey">, now = Math.floor(Date.now() / 1000)): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuedAt(now - 60) // clock drift allowance recommended by GitHub
    .setExpirationTime(now + 9 * 60)
    .setIssuer(String(app.appId))
    .sign(appPrivateKey(app.privateKey));
}
