import { db } from "@/lib/db";
import { randomToken, sha256 } from "@/lib/crypto";

/** API tokens: `ld_<43 chars>`; only sha256 is stored. Sent as `Authorization: Bearer ld_…`. */
export const TOKEN_PREFIX = "ld_";

export const TOKEN_SCOPES = [
  "*",
  "projects:read",
  "projects:write",
  "deployments:read",
  "deployments:write",
  "env:read",
  "env:write",
  "domains:read",
  "domains:write",
  "logs:read",
  "base:read",
  "base:write",
] as const;

export async function createApiToken(input: { userId: string; teamId?: string | null; name: string; scopes?: string[]; expiresAt?: Date | null }) {
  const plain = TOKEN_PREFIX + randomToken(32);
  const row = await db.apiToken.create({
    data: {
      userId: input.userId,
      teamId: input.teamId ?? null,
      name: input.name,
      tokenHash: sha256(plain),
      prefix: plain.slice(0, 9),
      scopes: input.scopes?.length ? input.scopes : ["*"],
      expiresAt: input.expiresAt ?? null,
    },
  });
  return { token: plain, row };
}

export async function verifyApiToken(plain: string, ip?: string | null) {
  if (!plain.startsWith(TOKEN_PREFIX)) return null;
  const row = await db.apiToken.findUnique({
    where: { tokenHash: sha256(plain) },
    include: { user: { select: { id: true, email: true, name: true, avatar: true, isPlatformOwner: true, totpEnabled: true, disabledAt: true } } },
  });
  if (!row || row.revokedAt || (row.expiresAt && row.expiresAt < new Date()) || row.user.disabledAt) return null;
  if (!row.lastUsedAt || row.lastUsedAt.getTime() < Date.now() - 60_000) {
    void db.apiToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date(), lastUsedIp: ip ?? null } }).catch(() => {});
  }
  return row;
}

export function tokenHasScope(scopes: string[], needed?: string) {
  if (!needed) return true;
  if (scopes.includes("*")) return true;
  if (scopes.includes(needed)) return true;
  // "x:write" implies "x:read"
  const [res, op] = needed.split(":");
  return op === "read" && scopes.includes(`${res}:write`);
}
