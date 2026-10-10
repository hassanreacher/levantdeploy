/**
 * LevantBase dashboard — client-safe types, constants and pure helpers (no server imports).
 * Used by the Base pages (`/{team}/base/[ref]/**`, `/{team}/{project}/backend/**`), the public API
 * (`/api/v1/base/**`) and the AI tools.
 */

export const BASE_STATUSES = ["PROVISIONING", "ACTIVE", "PAUSING", "PAUSED", "RESTORING", "UPGRADING", "ERROR", "DELETING"] as const;
export type BaseStatus = (typeof BASE_STATUSES)[number];

export const BASE_STATUS_STYLE: Record<BaseStatus, { label: string; tone: "success" | "warning" | "danger" | "neutral"; busy?: boolean }> = {
  PROVISIONING: { label: "Provisioning", tone: "warning", busy: true },
  ACTIVE: { label: "Healthy", tone: "success" },
  PAUSING: { label: "Pausing", tone: "warning", busy: true },
  PAUSED: { label: "Paused", tone: "neutral" },
  RESTORING: { label: "Restoring", tone: "warning", busy: true },
  UPGRADING: { label: "Upgrading", tone: "warning", busy: true },
  ERROR: { label: "Error", tone: "danger" },
  DELETING: { label: "Deleting", tone: "neutral", busy: true },
};
export const isBusy = (s: string) => !!BASE_STATUS_STYLE[s as BaseStatus]?.busy;

/** Region label (single server today; the field exists for multi-server later). */
export const BASE_REGION = "This server";

export type BaseProjectDTO = {
  id: string;
  ref: string;
  name: string;
  status: BaseStatus;
  region: string;
  apiUrl: string;
  studioUrl: string;
  createdAt: string;
  lastActivityAt: string | null;
  versions: Record<string, string>;
  /** the Deploy project this backend is attached to ("Backend" tab) */
  project: { id: string; slug: string; name: string } | null;
  dbPublicPort: number | null;
  customDomain: string | null;
  createdBy: { name: string; avatar: string | null } | null;
  errorMessage: string | null;
};

export type BaseEventDTO = { id: string; type: string; level: "info" | "success" | "warning" | "error" | string; message: string; createdAt: string; meta?: Record<string, unknown> | null };

/** Services of one stack (order = health grid order). `logs` = has a log stream in the Logs page. */
export const BASE_SERVICES = [
  { id: "api-gw", label: "API Gateway", desc: "Routes /auth, /rest, /realtime, /storage, /functions", logs: true },
  { id: "db", label: "Database", desc: "Postgres", logs: true },
  { id: "auth", label: "Auth", desc: "Users, sessions, OAuth, email", logs: true },
  { id: "rest", label: "REST", desc: "Auto-generated REST API", logs: true },
  { id: "realtime", label: "Realtime", desc: "Broadcast, presence, DB changes", logs: true },
  { id: "storage", label: "Storage", desc: "Files and buckets", logs: true },
  { id: "functions", label: "Edge Functions", desc: "Deno edge runtime", logs: true },
  { id: "meta", label: "Meta", desc: "Schema introspection", logs: false },
  { id: "imgproxy", label: "Image transforms", desc: "Image resizing", logs: false },
  { id: "pooler", label: "Pooler", desc: "Connection pooler", logs: false },
  { id: "studio", label: "Studio", desc: "Started on demand", logs: false },
] as const;
export type BaseServiceId = (typeof BASE_SERVICES)[number]["id"];
export const LOG_SERVICES = BASE_SERVICES.filter((s) => s.logs).map((s) => s.id);

export type ServiceHealth = { service: string; state: "running" | "starting" | "stopped" | "unhealthy" | "missing"; detail?: string | null };

export type BaseKeysDTO = { url: string; anonKey: string; serviceRoleKey?: string | null };

/** Runtime capability (base-runtime: setPublicPort throws "not available yet"). Flip when it ships. */
export const PUBLIC_PORT_SUPPORTED = true;

export type ConnectionInfoDTO = {
  host: string;
  port: number;
  database: string;
  user: string;
  /** direct, internal network — for LevantDeploy apps (password masked unless revealed) */
  direct: string;
  /** pooled (transaction mode) — private network of this server (base-{ref}:6543) */
  pooler: string | null;
  /** pooled (session mode) — base-{ref}:5432 */
  poolerSession: string | null;
  /** public connections require TLS (sslmode=require) */
  sslRequired: boolean;
  publicHost: string | null;
  /** public port (plan-gated) */
  publicUrl: string | null;
  publicPort: number | null;
  publicAllowed: boolean;
  /** the runtime can publish a public pooler port (not in this release) */
  publicSupported: boolean;
};

export type BackupDTO = { id: string; status: string; kind: string; sizeBytes: number | null; storageSizeBytes: number | null; hasStorage: boolean; createdAt: string; finishedAt: string | null; error: string | null; createdBy: string | null };

export type FunctionDTO = { id: string; name: string; slug: string; verifyJwt: boolean; version: number; status: string; updatedAt: string; createdAt: string; url: string };

export type UsageMetric = { key: "db" | "storage" | "mau" | "egress" | "invocations" | "functions"; label: string; used: number; limit: number | null; unit: "bytes" | "count" };
export type UsageDTO = { periodStart: string; metrics: UsageMetric[]; series?: { ts: string; dbBytes: number; storageBytes: number; egressBytes: number; invocations: number }[] };

// ───────────────────────────── Auth settings ─────────────────────────────

export const OAUTH_PROVIDERS = [
  { id: "google", label: "Google", needsUrl: false },
  { id: "github", label: "GitHub", needsUrl: false },
  { id: "apple", label: "Apple", needsUrl: false },
  { id: "azure", label: "Azure (Microsoft)", needsUrl: true },
  { id: "gitlab", label: "GitLab", needsUrl: true },
  { id: "discord", label: "Discord", needsUrl: false },
  { id: "bitbucket", label: "Bitbucket", needsUrl: false },
  { id: "facebook", label: "Facebook", needsUrl: false },
  { id: "twitter", label: "Twitter (X)", needsUrl: false },
  { id: "slack_oidc", label: "Slack", needsUrl: false },
  { id: "linkedin_oidc", label: "LinkedIn", needsUrl: false },
  { id: "spotify", label: "Spotify", needsUrl: false },
  { id: "twitch", label: "Twitch", needsUrl: false },
  { id: "notion", label: "Notion", needsUrl: false },
  { id: "figma", label: "Figma", needsUrl: false },
  { id: "zoom", label: "Zoom", needsUrl: false },
  { id: "kakao", label: "Kakao", needsUrl: false },
  { id: "workos", label: "WorkOS", needsUrl: true },
  { id: "keycloak", label: "Keycloak", needsUrl: true },
] as const;
export type OAuthProviderId = (typeof OAUTH_PROVIDERS)[number]["id"];

export const EMAIL_TEMPLATES = [
  { id: "confirmation", label: "Confirm signup", vars: "{{ .ConfirmationURL }} {{ .Email }} {{ .SiteURL }}" },
  { id: "invite", label: "Invite user", vars: "{{ .ConfirmationURL }} {{ .Email }} {{ .SiteURL }}" },
  { id: "magic_link", label: "Magic link", vars: "{{ .ConfirmationURL }} {{ .Token }} {{ .Email }}" },
  { id: "recovery", label: "Reset password", vars: "{{ .ConfirmationURL }} {{ .Token }} {{ .Email }}" },
  { id: "email_change", label: "Change email address", vars: "{{ .ConfirmationURL }} {{ .NewEmail }} {{ .Email }}" },
] as const;
export type EmailTemplateId = (typeof EMAIL_TEMPLATES)[number]["id"];

/**
 * Auth settings as the dashboard sees them (from `BaseProject.settings`, base-runtime's `BaseSettings`).
 * Secrets (OAuth client secrets, SMTP password, function secrets) are never returned — only `has*` flags / names.
 */
export type AuthSettingsView = {
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
  smtp: { host: string; port: number; user: string; hasPassword: boolean; adminEmail: string; senderName: string };
  providers: Record<string, { enabled: boolean; clientId: string; hasSecret: boolean; url?: string; redirectUri?: string }>;
  templates: Record<string, { subject: string; body: string }>;
  functions: { verifyJwt: boolean; secretNames: string[] };
};

// ───────────────────────────── Pure helpers ─────────────────────────────

/** 20-char lowercase ref (spec). */
export const REF_RE = /^[a-z0-9]{20}$/;
export const isRef = (s: string) => REF_RE.test(s);

export const BASE_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,62}$/u;

/** Database passwords end up in connection URLs and compose .env files → letters and digits only (runtime rule). */
export const DB_PASSWORD_RE = /^[A-Za-z0-9]{16,128}$/;

/** Password strength 0–4 + hints (UI meter; the server requires DB_PASSWORD_RE and score ≥ 3). */
export function passwordStrength(pw: string): { score: 0 | 1 | 2 | 3 | 4; hints: string[] } {
  const hints: string[] = [];
  if (/[^A-Za-z0-9]/.test(pw)) hints.push("Use letters and digits only (it is embedded in connection URLs)");
  if (pw.length < 16) hints.push("Use at least 16 characters");
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) => r.test(pw)).length;
  if (classes < 3) hints.push("Mix upper case, lower case and digits");
  if (/(.)\1{3,}/.test(pw)) hints.push("Avoid repeated characters");
  if (/^(password|postgres|admin|qwerty|123456|letmein)/i.test(pw)) hints.push("Avoid common passwords");
  let score = 0;
  if (pw.length >= 10) score++;
  if (pw.length >= 16) score++;
  if (pw.length >= 20) score++;
  if (classes === 3) score++;
  if (hints.length >= 2) score = Math.min(score, 1);
  else if (hints.length === 1) score = Math.min(score, 2);
  return { score: Math.min(4, score) as 0 | 1 | 2 | 3 | 4, hints };
}

/** Strong alphanumeric password (browser or node crypto). */
export function generatePassword(len = 24): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const buf = new Uint8Array(len);
  globalThis.crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += chars[b % chars.length];
  // guarantee every class so the strength check passes
  return `${out.slice(0, len - 3)}Ab3`;
}

/**
 * Is this SQL read-only (safe to run without approval)? Conservative: comments and string literals are
 * stripped, every statement must start with SELECT / WITH / EXPLAIN (no ANALYZE) / SHOW / VALUES / TABLE,
 * and no data-modifying or privileged keyword may appear anywhere.
 */
export function isReadOnlySql(sql: string): boolean {
  const cleaned = stripSql(sql);
  const stmts = cleaned
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!stmts.length) return false;
  const forbidden =
    /\b(insert|update|delete|merge|upsert|create|alter|drop|truncate|grant|revoke|comment|copy|vacuum|analyze|cluster|reindex|refresh|lock|call|do|set|reset|begin|commit|rollback|savepoint|prepare|execute|deallocate|listen|notify|discard|load|security|import|into|nextval|setval|pg_sleep|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_read_file|pg_read_binary_file|pg_ls_dir|lo_import|lo_export|dblink|set_config|pg_advisory_lock|for\s+update|for\s+share|for\s+no\s+key\s+update|for\s+key\s+share)\b/i;
  for (const s of stmts) {
    if (!/^(select|with|explain|show|values|table)\b/i.test(s)) return false;
    if (/^explain\b/i.test(s) && /\banalyze\b/i.test(s)) return false;
    if (forbidden.test(s)) return false;
  }
  return true;
}

/** Remove comments, string literals, quoted identifiers and dollar-quoted bodies (keeps statement structure). */
export function stripSql(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const n = sql[i + 1];
    if (c === "-" && n === "-") {
      const e = sql.indexOf("\n", i);
      i = e < 0 ? sql.length : e;
      out += " ";
    } else if (c === "/" && n === "*") {
      const e = sql.indexOf("*/", i + 2);
      i = e < 0 ? sql.length : e + 2;
      out += " ";
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c && sql[j + 1] === c) j += 2;
        else if (sql[j] === c) break;
        else j++;
      }
      i = j + 1;
      out += c === "'" ? " '' " : ' "x" ';
    } else if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const e = sql.indexOf(tag, i + tag.length);
        i = e < 0 ? sql.length : e + tag.length;
        out += " $$ ";
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Usage percentage (null when unlimited). */
export const usagePct = (used: number, limit: number | null) => (limit && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : null);

/** Connection string with the password masked. */
export function maskConnString(url: string): string {
  return url.replace(/^(\w+:\/\/[^:/@]+:)([^@]+)(@)/, (_m, a: string, _p: string, c: string) => `${a}••••••••${c}`);
}

export const FUNCTION_SLUG_RE = /^[a-z][a-z0-9-]{0,62}$/;

export const FUNCTION_TEMPLATES: { id: string; label: string; description: string; code: string }[] = [
  {
    id: "hello-world",
    label: "Hello world",
    description: "Returns a JSON greeting.",
    code: `// Edge Function (Deno). Invoke: POST {API_URL}/functions/v1/<name>
Deno.serve(async (req) => {
  const { name } = await req.json().catch(() => ({ name: "world" }));
  return new Response(JSON.stringify({ message: \`Hello \${name}!\` }), {
    headers: { "Content-Type": "application/json" },
  });
});
`,
  },
  {
    id: "database",
    label: "Query the database",
    description: "Uses supabase-js with the caller's JWT (RLS applies).",
    code: `import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data, error } = await supabase.from("todos").select("*").limit(10);
  return new Response(JSON.stringify(error ?? data), {
    status: error ? 400 : 200,
    headers: { "Content-Type": "application/json" },
  });
});
`,
  },
  {
    id: "cors",
    label: "CORS-enabled API",
    description: "Handles preflight requests for browser calls.",
    code: `const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const body = await req.json().catch(() => ({}));
  return new Response(JSON.stringify({ received: body, at: new Date().toISOString() }), {
    headers: { ...cors, "Content-Type": "application/json" },
  });
});
`,
  },
  {
    id: "webhook",
    label: "Webhook receiver",
    description: "Verifies a shared secret header and stores the payload.",
    code: `import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  if (req.headers.get("x-webhook-secret") !== Deno.env.get("WEBHOOK_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const payload = await req.json();
  const { error } = await admin.from("webhook_events").insert({ payload });
  return new Response(error ? error.message : "ok", { status: error ? 500 : 200 });
});
`,
  },
];

/** Quick-start snippets (Home page). Uses the anon key only — never the service key. */
export function quickstartSnippets(url: string, anonKey: string): { id: string; label: string; lang: string; code: string }[] {
  return [
    {
      id: "js",
      label: "supabase-js",
      lang: "ts",
      code: `npm install @supabase/supabase-js

import { createClient } from "@supabase/supabase-js";

const supabase = createClient("${url}", "${anonKey}");

const { data, error } = await supabase.from("todos").select("*");`,
    },
    {
      id: "next",
      label: "Next.js",
      lang: "ts",
      code: `# .env.local
NEXT_PUBLIC_SUPABASE_URL=${url}
NEXT_PUBLIC_SUPABASE_ANON_KEY=${anonKey}

// lib/supabase.ts
import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);`,
    },
    {
      id: "flutter",
      label: "Flutter",
      lang: "dart",
      code: `# pubspec.yaml → dependencies: supabase_flutter: ^2.0.0

import 'package:supabase_flutter/supabase_flutter.dart';

Future<void> main() async {
  await Supabase.initialize(
    url: '${url}',
    anonKey: '${anonKey}',
  );
  runApp(MyApp());
}

final rows = await Supabase.instance.client.from('todos').select();`,
    },
    {
      id: "curl",
      label: "curl",
      lang: "sh",
      code: `curl '${url}/rest/v1/todos?select=*' \\
  -H "apikey: ${anonKey}" \\
  -H "Authorization: Bearer ${anonKey}"`,
    },
  ];
}

/**
 * Env vars written into a Deploy project by "Connect a Base project".
 * Browser-exposed names get the public URL; server-side SUPABASE_URL gets the internal gateway URL
 * (http://base-{ref}:8000 on levant_net — no TLS / public DNS round trip) except for the DEVELOPMENT target
 * (`levant env pull` on a laptop can't reach the private network).
 */
export type ConnectEnvOptions = { includeServiceRole: boolean; includeDatabaseUrl: boolean; databaseUrlKind: "pooler" | "direct" };
export function connectEnvVars(
  info: { url: string; internalUrl?: string | null; anonKey: string; serviceRoleKey?: string | null; poolerUrl?: string | null; directUrl?: string | null },
  o: ConnectEnvOptions,
  target: "PRODUCTION" | "PREVIEW" | "DEVELOPMENT" = "PRODUCTION",
): { key: string; value: string; isSecret: boolean }[] {
  const serverUrl = target !== "DEVELOPMENT" && info.internalUrl ? info.internalUrl : info.url;
  const out = [
    { key: "NEXT_PUBLIC_SUPABASE_URL", value: info.url, isSecret: false },
    { key: "NEXT_PUBLIC_SUPABASE_ANON_KEY", value: info.anonKey, isSecret: false },
    { key: "SUPABASE_URL", value: serverUrl, isSecret: false },
    { key: "SUPABASE_ANON_KEY", value: info.anonKey, isSecret: false },
  ];
  if (o.includeServiceRole && info.serviceRoleKey) out.push({ key: "SUPABASE_SERVICE_ROLE_KEY", value: info.serviceRoleKey, isSecret: true });
  if (o.includeDatabaseUrl) {
    const v = o.databaseUrlKind === "pooler" ? (info.poolerUrl ?? info.directUrl) : (info.directUrl ?? info.poolerUrl);
    if (v) out.push({ key: "DATABASE_URL", value: v, isSecret: true });
  }
  return out;
}

/** Base sub-pages (shared between `/{team}/base/[ref]` and `/{team}/{project}/backend`). */
export const BASE_PAGES = [
  { seg: "", label: "Home" },
  { seg: "database", label: "Database" },
  { seg: "auth", label: "Auth" },
  { seg: "functions", label: "Edge Functions" },
  { seg: "logs", label: "Logs" },
  { seg: "usage", label: "Usage" },
  { seg: "settings", label: "Settings" },
] as const;
