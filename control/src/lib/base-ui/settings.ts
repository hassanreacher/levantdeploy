/**
 * Auth / SMTP / provider / email-template settings of a Base project as the dashboard sees them.
 * The stored shape is base-runtime's `BaseSettings` (src/lib/base/settings.ts), incl. `templates` (served to GoTrue by
 * the gateway) and `customDomain` (routed by Caddy when ACTIVE). Worker-safe.
 */
import { z } from "zod";
import { baseSettingsPatchSchema, publicSettings, readSettings, type BaseSettingsPatch } from "@/lib/base/settings";
import { decryptString } from "@/lib/crypto";
import { EMAIL_TEMPLATES, type AuthSettingsView } from "./shared";

type Extra = {
  customDomain?: { hostname: string; verifyToken: string; status: string; lastError?: string | null } | null;
  [k: string]: unknown;
};

/** Raw JSON object (for the dashboard-owned extra keys). */
export const readStored = (settings: unknown): Extra => (settings && typeof settings === "object" && !Array.isArray(settings) ? (settings as Extra) : {});

export function authSettingsView(raw: unknown): AuthSettingsView {
  const p = publicSettings(readSettings(raw));
  const stored = readSettings(raw);
  const providers: AuthSettingsView["providers"] = {};
  for (const [id, v] of Object.entries(p.providers)) {
    if (!v) continue;
    providers[id] = { enabled: !!v.enabled, clientId: v.clientId ?? "", hasSecret: !!v.hasSecret, ...(v.url ? { url: v.url } : {}), ...(v.redirectUri ? { redirectUri: v.redirectUri } : {}) };
  }
  const templates: AuthSettingsView["templates"] = {};
  for (const t of EMAIL_TEMPLATES) {
    const v = stored.templates?.[t.id];
    if (v) templates[t.id] = { subject: v.subject ?? "", body: v.body ?? "" };
  }
  return {
    auth: p.auth,
    smtp: {
      host: p.smtp.host ?? "",
      port: p.smtp.port ?? 587,
      user: p.smtp.user ?? "",
      hasPassword: p.smtp.hasPassword,
      adminEmail: p.smtp.adminEmail ?? "",
      senderName: p.smtp.senderName ?? "",
    },
    providers,
    templates,
    functions: p.functions,
  };
}

/** PATCH body of /api/v1/base/projects/:ref/auth = the runtime's settings patch (auth, smtp, providers, templates, …). */
export const dashboardSettingsPatchSchema = baseSettingsPatchSchema;
export type DashboardSettingsPatch = BaseSettingsPatch;

/** Decrypted SMTP config (for the SMTP test). */
export function smtpConfig(raw: unknown) {
  const s = readSettings(raw).smtp;
  if (!s.host) return null;
  return { host: s.host, port: s.port ?? 587, user: s.user ?? "", pass: decryptString(s.passEnc) ?? "", adminEmail: s.adminEmail ?? "", senderName: s.senderName ?? "" };
}

export class SettingsError extends Error {
  constructor(
    public field: string,
    message: string,
  ) {
    super(message);
  }
}
