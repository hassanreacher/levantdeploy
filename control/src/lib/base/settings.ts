import { z } from "zod";
import { decryptString, encryptString } from "@/lib/crypto";
import type { BaseLimits } from "./limits";

/**
 * BaseProject.settings (Json). The dashboard edits it through `updateBaseSettings(ref, patch)` (service.ts), which
 * validates with `baseSettingsPatchSchema`, encrypts secrets (SMTP password, provider secrets, function secrets) and
 * enqueues a "settings" job (re-render + recreate only the services whose configuration changed).
 */

export const OAUTH_PROVIDERS = [
  "apple", "azure", "bitbucket", "discord", "facebook", "figma", "github", "gitlab", "google", "kakao", "keycloak",
  "linkedin_oidc", "notion", "slack_oidc", "spotify", "twitch", "twitter", "workos", "zoom",
] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];
export const MAIL_TEMPLATES = ["confirmation", "invite", "magic_link", "recovery", "email_change"] as const;
export type MailTemplateId = (typeof MAIL_TEMPLATES)[number];

export type ProviderSettings = { enabled: boolean; clientId?: string; secretEnc?: string; redirectUri?: string; url?: string; skipNonceCheck?: boolean };

export type BaseSettings = {
  auth: {
    siteUrl: string;
    additionalRedirectUrls: string[];
    disableSignup: boolean;
    enableEmailSignup: boolean;
    emailAutoconfirm: boolean;
    enableAnonymousUsers: boolean;
    enablePhoneSignup: boolean;
    phoneAutoconfirm: boolean;
    jwtExpiry: number;
  };
  smtp: { host?: string; port?: number; user?: string; passEnc?: string; adminEmail?: string; senderName?: string };
  providers: Partial<Record<OAuthProvider, ProviderSettings>>;
  /** extra GOTRUE_* variables (MFA, hooks, rate limits …) — passed through to auth.env */
  authExtra: Record<string, string>;
  api: { schemas: string[]; maxRows: number; extraSearchPath: string[] };
  functions: { verifyJwt: boolean; secretsEnc?: string };
  /** platform-owner overrides of the plan limits for this project */
  limits?: Partial<BaseLimits>;
  /** dashboard: email templates {confirmation|invite|magic_link|recovery|email_change: {subject, body}} → served to GoTrue */
  templates?: Partial<Record<MailTemplateId, { subject?: string; body?: string }>>;
  /** dashboard: custom API hostname; ACTIVE → routed to the gateway + allowed by tls-ask */
  customDomain?: { hostname: string; verifyToken?: string; status: "PENDING" | "ACTIVE" | "FAILED"; lastError?: string | null };
  [k: string]: unknown;
};


export const DEFAULT_SETTINGS: BaseSettings = {
  auth: {
    siteUrl: "http://localhost:3000",
    additionalRedirectUrls: [],
    disableSignup: false,
    enableEmailSignup: true,
    // no SMTP configured by default → confirm emails automatically, otherwise nobody could sign up
    emailAutoconfirm: true,
    enableAnonymousUsers: false,
    enablePhoneSignup: false,
    phoneAutoconfirm: false,
    jwtExpiry: 3600,
  },
  smtp: {},
  providers: {},
  authExtra: {},
  api: { schemas: ["public", "graphql_public"], maxRows: 1000, extraSearchPath: ["public", "extensions"] },
  functions: { verifyJwt: true },
};

export function readSettings(raw: unknown): BaseSettings {
  const s = (raw && typeof raw === "object" ? raw : {}) as Partial<BaseSettings>;
  return {
    // unknown top-level keys (dashboard: templates, customDomain, …) are preserved on re-save
    ...(s as Record<string, unknown>),
    auth: { ...DEFAULT_SETTINGS.auth, ...(s.auth ?? {}) },
    smtp: { ...(s.smtp ?? {}) },
    providers: { ...(s.providers ?? {}) },
    authExtra: { ...(s.authExtra ?? {}) },
    api: { ...DEFAULT_SETTINGS.api, ...(s.api ?? {}) },
    functions: { ...DEFAULT_SETTINGS.functions, ...(s.functions ?? {}) },
    ...(s.limits ? { limits: s.limits } : {}),
  };
}

const url = z.string().trim().url().max(500);
const ident = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);

/** What the dashboard may send (secrets in plain text — they are encrypted by applySettingsPatch). */
export const baseSettingsPatchSchema = z
  .object({
    auth: z
      .object({
        siteUrl: url,
        additionalRedirectUrls: z.array(z.string().trim().min(1).max(500)).max(100),
        disableSignup: z.boolean(),
        enableEmailSignup: z.boolean(),
        emailAutoconfirm: z.boolean(),
        enableAnonymousUsers: z.boolean(),
        enablePhoneSignup: z.boolean(),
        phoneAutoconfirm: z.boolean(),
        jwtExpiry: z.number().int().min(300).max(604_800),
      })
      .partial(),
    smtp: z
      .object({
        host: z.string().trim().max(253),
        port: z.number().int().min(1).max(65535),
        user: z.string().max(200),
        pass: z.string().max(500).nullable(),
        adminEmail: z.string().trim().email(),
        senderName: z.string().max(100),
      })
      .partial()
      .nullable(),
    providers: z.record(
      z.enum(OAUTH_PROVIDERS),
      z
        .object({ enabled: z.boolean(), clientId: z.string().max(500), secret: z.string().max(4000).nullable(), redirectUri: url, url: url, skipNonceCheck: z.boolean() })
        .partial()
        .nullable(),
    ),
    authExtra: z.record(z.string().regex(/^GOTRUE_[A-Z0-9_]+$/), z.string().max(4000).nullable()),
    api: z.object({ schemas: z.array(ident).min(1).max(20), maxRows: z.number().int().min(1).max(100_000), extraSearchPath: z.array(ident).max(20) }).partial(),
    functions: z.object({ verifyJwt: z.boolean(), secrets: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(10_000).nullable()) }).partial(),
    templates: z.record(z.enum(MAIL_TEMPLATES), z.object({ subject: z.string().max(300), body: z.string().max(200_000) }).partial().nullable()),
  })
  .partial();
export type BaseSettingsPatch = z.infer<typeof baseSettingsPatchSchema>;

/** Keys a user may never override through function secrets / authExtra (they would break or leak the stack). */
const RESERVED_FN_SECRETS = /^(SUPABASE_|JWT_SECRET$|VERIFY_JWT$|LEVANT_|DENO_|HTTP_PROXY$|HTTPS_PROXY$|NO_PROXY$)/;
const RESERVED_GOTRUE = new Set(["GOTRUE_JWT_SECRET", "GOTRUE_DB_DATABASE_URL", "GOTRUE_DB_DRIVER", "GOTRUE_API_HOST", "GOTRUE_API_PORT", "GOTRUE_JWT_ADMIN_ROLES"]);

export function functionSecrets(s: BaseSettings): Record<string, string> {
  if (!s.functions.secretsEnc) return {};
  try {
    return JSON.parse(decryptString(s.functions.secretsEnc) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

/** Merge a validated patch into the stored settings. Returns the new settings + which groups changed. */
export function applySettingsPatch(current: BaseSettings, patch: BaseSettingsPatch): { settings: BaseSettings; changed: string[] } {
  const next: BaseSettings = JSON.parse(JSON.stringify(current));
  const changed = new Set<string>();
  if (patch.auth) {
    next.auth = { ...next.auth, ...patch.auth };
    changed.add("auth");
  }
  if (patch.smtp === null) {
    next.smtp = {};
    changed.add("auth");
  } else if (patch.smtp) {
    const { pass, ...rest } = patch.smtp;
    next.smtp = { ...next.smtp, ...rest };
    if (pass === null) delete next.smtp.passEnc;
    else if (pass !== undefined) next.smtp.passEnc = encryptString(pass);
    changed.add("auth");
  }
  if (patch.providers) {
    for (const [name, p] of Object.entries(patch.providers)) {
      const key = name as OAuthProvider;
      if (p === null) {
        delete next.providers[key];
        continue;
      }
      if (!p) continue;
      const { secret, ...rest } = p;
      const cur: ProviderSettings = { enabled: false, ...(next.providers[key] ?? {}), ...rest };
      if (secret === null) delete cur.secretEnc;
      else if (secret !== undefined) cur.secretEnc = encryptString(secret);
      next.providers[key] = cur;
    }
    changed.add("auth");
  }
  if (patch.authExtra) {
    for (const [k, v] of Object.entries(patch.authExtra)) {
      if (RESERVED_GOTRUE.has(k)) throw new Error(`${k} cannot be overridden`);
      if (v === null) delete next.authExtra[k];
      else next.authExtra[k] = v;
    }
    changed.add("auth");
  }
  if (patch.templates) {
    const cur = { ...(next.templates ?? {}) };
    for (const [id, t] of Object.entries(patch.templates)) {
      if (t === null) delete cur[id as MailTemplateId];
      else if (t) cur[id as MailTemplateId] = { ...(cur[id as MailTemplateId] ?? {}), ...t };
    }
    next.templates = cur;
    changed.add("auth");
  }
  if (patch.api) {
    next.api = { ...next.api, ...patch.api };
    changed.add("api");
  }
  if (patch.functions) {
    if (patch.functions.verifyJwt !== undefined) next.functions.verifyJwt = patch.functions.verifyJwt;
    if (patch.functions.secrets) {
      const cur = functionSecrets(next);
      for (const [k, v] of Object.entries(patch.functions.secrets)) {
        if (RESERVED_FN_SECRETS.test(k)) throw new Error(`${k} is reserved`);
        if (v === null) delete cur[k];
        else cur[k] = v;
      }
      next.functions.secretsEnc = Object.keys(cur).length ? encryptString(JSON.stringify(cur)) : undefined;
      if (!next.functions.secretsEnc) delete next.functions.secretsEnc;
    }
    changed.add("functions");
  }
  return { settings: next, changed: [...changed] };
}

/** Settings without secrets (for the dashboard). */
export function publicSettings(s: BaseSettings) {
  return {
    ...s,
    smtp: { ...s.smtp, passEnc: undefined, hasPassword: !!s.smtp.passEnc },
    providers: Object.fromEntries(Object.entries(s.providers).map(([k, p]) => [k, { ...p, secretEnc: undefined, hasSecret: !!p?.secretEnc }])),
    functions: { verifyJwt: s.functions.verifyJwt, secretNames: Object.keys(functionSecrets(s)) },
  };
}
