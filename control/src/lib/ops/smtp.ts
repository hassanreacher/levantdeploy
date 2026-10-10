import { env } from "@/lib/env";
import { getSetting } from "@/lib/settings";
import { decryptString } from "@/lib/crypto";

/**
 * Effective SMTP configuration: the `smtp` setting (Settings → Email) wins over env SMTP_*.
 * Used by src/lib/email.ts. Worker-safe.
 */
export type SmtpConfig = { host: string; port: number; secure: boolean; user: string | null; pass: string | null; from: string; source: "settings" | "env" };

export async function resolveSmtp(): Promise<SmtpConfig | null> {
  const s = await getSetting("smtp").catch(() => null);
  if (s) return { host: s.host, port: s.port, secure: s.secure, user: s.user, pass: s.passEnc ? decryptString(s.passEnc) : null, from: s.from, source: "settings" };
  if (!env.SMTP_HOST) return null;
  return { host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_SECURE, user: env.SMTP_USER ?? null, pass: env.SMTP_PASS ?? null, from: env.SMTP_FROM, source: "env" };
}
