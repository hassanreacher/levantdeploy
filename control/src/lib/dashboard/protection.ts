import { z } from "zod";

/**
 * Deployment protection settings stored in `Project.protection` (dashboard area writes, runtime/proxy applies).
 *   mode "none"      no protection
 *   mode "password"  a password page (proxy sets a signed cookie after the visitor enters the password)
 *   mode "basic"     HTTP Basic Auth (username + password) — Caddy `basic_auth` accepts the bcrypt hash directly
 * scope "previews"  only preview deployment URLs + branch URLs; "all" also protects production domains.
 * The plain password is never stored: `passwordHash` = bcrypt(password, 10).
 */
export const PROTECTION_MODES = ["none", "password", "basic"] as const;
export type ProtectionMode = (typeof PROTECTION_MODES)[number];

export const protectionSchema = z.object({
  mode: z.enum(PROTECTION_MODES).default("none"),
  scope: z.enum(["previews", "all"]).default("previews"),
  username: z.string().max(64).optional(),
  passwordHash: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type Protection = z.infer<typeof protectionSchema>;

export function readProtection(raw: unknown): Protection {
  const p = protectionSchema.safeParse(raw ?? {});
  return p.success ? p.data : { mode: "none", scope: "previews" };
}

/** Public view (no hash). */
export function publicProtection(raw: unknown) {
  const p = readProtection(raw);
  return { mode: p.mode, scope: p.scope, username: p.username ?? null, hasPassword: !!p.passwordHash, updatedAt: p.updatedAt ?? null };
}
