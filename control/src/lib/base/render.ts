import fs from "node:fs";
import path from "node:path";
import { decryptString } from "@/lib/crypto";
import { projectDir, templateDir } from "./config";
import { serviceResources, type BaseLimits } from "./limits";
import type { BaseSecrets } from "./secrets";
import crypto from "node:crypto";
import { functionSecrets, MAIL_TEMPLATES, type BaseSettings } from "./settings";
import { imageRef, type BaseVersions } from "./versions";

/**
 * Rendering = copy base-stack/template into STORAGE_DIR/base/{ref}/ + write `.env` (compose interpolation),
 * `auth.env` (extra GOTRUE_* incl. OAuth providers) and `functions.env` (function secrets, per-function JWT opt-out,
 * egress proxy). The template itself stays a plain compose file — all per-project values are variables.
 */
export type RenderInput = {
  ref: string;
  secrets: BaseSecrets;
  settings: BaseSettings;
  limits: BaseLimits;
  versions: BaseVersions;
  /** https://{ref}.{BASE_DOMAIN} */
  publicUrl: string;
  publicNetwork: string;
  mirror?: string | null;
  egressProxy?: string | null;
  /** PEM contents trusted by edge functions (egress proxy with TLS interception) */
  egressCa?: string | null;
  /** function slugs with verifyJwt = false */
  noVerifyJwt?: string[];
  /** host port publishing the pooler (session mode) — null = no public DB access */
  dbPublicPort?: number | null;
  /** host address the public port binds to (BASE_DB_PORT_BIND, default 0.0.0.0) */
  dbPublicBind?: string;
};

export type RenderedEnv = {
  env: Record<string, string>;
  authEnv: Record<string, string>;
  functionsEnv: Record<string, string>;
  /** volumes/templates/<id>.html contents (always all ids; custom bodies or a default) */
  templates: Record<string, string>;
};

/** Placeholder for templates without a custom body (GoTrue keeps its built-in template — no URL is configured). */
const DEFAULT_TEMPLATE = "<!-- LevantBase: no custom template; GoTrue uses its built-in template -->\n";

const bool = (b: boolean) => (b ? "true" : "false");

export function buildEnv(i: RenderInput): RenderedEnv {
  const { secrets: s, settings: st } = i;
  const res = serviceResources(i.limits);
  const img = (v: string) => imageRef(v, i.mirror);
  const smtpPass = st.smtp.passEnc ? (decryptString(st.smtp.passEnc) ?? "") : "";
  const env: Record<string, string> = {
    LB_REF: i.ref,
    LB_PUBLIC_NETWORK: i.publicNetwork,
    LB_STUDIO_GATE_SECRET: s.studioGateSecret,
    LB_FILE_SIZE_LIMIT: String(Math.max(1, i.limits.maxUploadMb) * 1024 * 1024),
    LB_HTTP_PROXY: i.egressProxy ?? "",
    // pooler TLS: CN = the API host (wildcard DNS points it at this server); enforced while the DB is public
    LB_DB_CERT_CN: new URL(i.publicUrl).hostname,
    LB_POOLER_ENFORCE_SSL: i.dbPublicPort ? "true" : "false",
    LB_NO_PROXY: i.egressProxy ? "localhost,127.0.0.1,db,api-gw,kong,envoy,rest,auth,storage,meta,realtime,functions,imgproxy" : "",

    LB_IMAGE_STUDIO: img(i.versions.studio),
    LB_IMAGE_GATEWAY: img(i.versions.gateway),
    LB_IMAGE_AUTH: img(i.versions.auth),
    LB_IMAGE_REST: img(i.versions.rest),
    LB_IMAGE_REALTIME: img(i.versions.realtime),
    LB_IMAGE_STORAGE: img(i.versions.storage),
    LB_IMAGE_IMGPROXY: img(i.versions.imgproxy),
    LB_IMAGE_META: img(i.versions.meta),
    LB_IMAGE_FUNCTIONS: img(i.versions.functions),
    LB_IMAGE_DB: img(i.versions.db),
    LB_IMAGE_POOLER: img(i.versions.pooler),

    // secrets (all per project, see secrets.ts)
    POSTGRES_PASSWORD: s.postgresPassword,
    JWT_SECRET: s.jwtSecret,
    ANON_KEY: s.anonKey,
    SERVICE_ROLE_KEY: s.serviceRoleKey,
    SUPABASE_PUBLISHABLE_KEY: "",
    SUPABASE_SECRET_KEY: "",
    ANON_KEY_ASYMMETRIC: "",
    SERVICE_ROLE_KEY_ASYMMETRIC: "",
    DASHBOARD_USERNAME: "levant",
    DASHBOARD_PASSWORD: s.dashboardPassword,
    SECRET_KEY_BASE: s.secretKeyBase,
    REALTIME_DB_ENC_KEY: s.realtimeDbEncKey,
    VAULT_ENC_KEY: s.vaultEncKey,
    PG_META_CRYPTO_KEY: s.pgMetaCryptoKey,
    LOGFLARE_PUBLIC_ACCESS_TOKEN: s.logflarePublicToken,
    LOGFLARE_PRIVATE_ACCESS_TOKEN: s.logflarePrivateToken,
    S3_PROTOCOL_ACCESS_KEY_ID: s.s3ProtocolAccessKeyId,
    S3_PROTOCOL_ACCESS_KEY_SECRET: s.s3ProtocolAccessKeySecret,

    // URLs
    SUPABASE_PUBLIC_URL: i.publicUrl,
    API_EXTERNAL_URL: `${i.publicUrl}/auth/v1`,

    // database
    POSTGRES_HOST: "db",
    POSTGRES_DB: "postgres",
    POSTGRES_PORT: "5432",

    // pooler (profile "pooler")
    POOLER_PROXY_PORT_TRANSACTION: "6543",
    POOLER_DEFAULT_POOL_SIZE: "20",
    POOLER_MAX_CLIENT_CONN: "100",
    POOLER_TENANT_ID: i.ref,
    POOLER_DB_POOL_SIZE: "5",

    // studio
    STUDIO_DEFAULT_ORGANIZATION: "LevantBase",
    STUDIO_DEFAULT_PROJECT: i.ref,
    OPENAI_API_KEY: "",

    // auth
    SITE_URL: st.auth.siteUrl,
    ADDITIONAL_REDIRECT_URLS: st.auth.additionalRedirectUrls.join(","),
    JWT_EXPIRY: String(st.auth.jwtExpiry),
    DISABLE_SIGNUP: bool(st.auth.disableSignup),
    MAILER_URLPATHS_CONFIRMATION: "/auth/v1/verify",
    MAILER_URLPATHS_INVITE: "/auth/v1/verify",
    MAILER_URLPATHS_RECOVERY: "/auth/v1/verify",
    MAILER_URLPATHS_EMAIL_CHANGE: "/auth/v1/verify",
    ENABLE_EMAIL_SIGNUP: bool(st.auth.enableEmailSignup),
    ENABLE_EMAIL_AUTOCONFIRM: bool(st.auth.emailAutoconfirm),
    SMTP_ADMIN_EMAIL: st.smtp.adminEmail ?? "",
    SMTP_HOST: st.smtp.host ?? "",
    SMTP_PORT: String(st.smtp.port ?? 587),
    SMTP_USER: st.smtp.user ?? "",
    SMTP_PASS: smtpPass,
    SMTP_SENDER_NAME: st.smtp.senderName ?? "",
    ENABLE_ANONYMOUS_USERS: bool(st.auth.enableAnonymousUsers),
    ENABLE_PHONE_SIGNUP: bool(st.auth.enablePhoneSignup),
    ENABLE_PHONE_AUTOCONFIRM: bool(st.auth.phoneAutoconfirm),

    // storage (file backend)
    GLOBAL_S3_BUCKET: "stub",
    REGION: "local",
    STORAGE_TENANT_ID: "stub",
    IMGPROXY_AUTO_WEBP: "true",

    // functions
    FUNCTIONS_VERIFY_JWT: bool(st.functions.verifyJwt),

    // rest
    PGRST_DB_SCHEMAS: st.api.schemas.join(","),
    PGRST_DB_MAX_ROWS: String(st.api.maxRows),
    PGRST_DB_EXTRA_SEARCH_PATH: st.api.extraSearchPath.join(","),
  };
  const resKey: Record<string, string> = {
    db: "DB", realtime: "REALTIME", functions: "FUNCTIONS", storage: "STORAGE", meta: "META", imgproxy: "IMGPROXY",
    gateway: "GATEWAY", auth: "AUTH", rest: "REST", studio: "STUDIO", pooler: "POOLER",
  };
  for (const [svc, r] of Object.entries(res)) {
    env[`LB_CPU_${resKey[svc]}`] = r.cpus;
    env[`LB_MEM_${resKey[svc]}`] = r.memory;
  }

  const authEnv: Record<string, string> = {};
  for (const [name, p] of Object.entries(st.providers)) {
    if (!p) continue;
    const P = `GOTRUE_EXTERNAL_${name.toUpperCase()}`;
    authEnv[`${P}_ENABLED`] = bool(!!p.enabled);
    if (p.clientId) authEnv[`${P}_CLIENT_ID`] = p.clientId;
    if (p.secretEnc) authEnv[`${P}_SECRET`] = decryptString(p.secretEnc) ?? "";
    authEnv[`${P}_REDIRECT_URI`] = p.redirectUri || `${i.publicUrl}/auth/v1/callback`;
    if (p.url) authEnv[`${P}_URL`] = p.url;
    if (p.skipNonceCheck) authEnv[`${P}_SKIP_NONCE_CHECK`] = "true";
  }
  for (const [k, v] of Object.entries(st.authExtra)) authEnv[k] = v;
  // dashboard e-mail templates → served by the gateway's :8002 listener, subjects as GOTRUE_MAILER_SUBJECTS_*
  const templates: Record<string, string> = {};
  for (const id of MAIL_TEMPLATES) {
    const t = st.templates?.[id];
    templates[id] = t?.body ? t.body : DEFAULT_TEMPLATE;
    if (t?.body) authEnv[`GOTRUE_MAILER_TEMPLATES_${id.toUpperCase()}`] = `http://lb_${i.ref}_api-gw:8002/templates/${id}`;
    if (t?.subject) authEnv[`GOTRUE_MAILER_SUBJECTS_${id.toUpperCase()}`] = t.subject.replace(/[\r\n]+/g, " ");
  }
  env.LB_TEMPLATES_HASH = crypto.createHash("sha256").update(JSON.stringify(templates)).digest("hex").slice(0, 16);

  const functionsEnv: Record<string, string> = { ...functionSecrets(st) };
  functionsEnv.LEVANT_NO_VERIFY_JWT = (i.noVerifyJwt ?? []).join(",");
  if (i.egressProxy) {
    functionsEnv.HTTP_PROXY = i.egressProxy;
    functionsEnv.HTTPS_PROXY = i.egressProxy;
    functionsEnv.NO_PROXY = env.LB_NO_PROXY!;
  }
  if (i.egressCa) functionsEnv.DENO_CERT = "/etc/levant-ca/egress-ca.crt";
  return { env, authEnv, functionsEnv, templates };
}

/**
 * Serialize for compose `.env` / `env_file`. Single quotes = literal (no `$` interpolation, no escapes); values that
 * contain a single quote fall back to double quotes with `\`, `"` escaped and `$` doubled. Newlines are refused.
 */
export function serializeEnv(vars: Record<string, string>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(vars)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`invalid env key ${k}`);
    if (/[\r\n\0]/.test(v)) throw new Error(`env value for ${k} must be a single line`);
    if (!v.includes("'")) lines.push(`${k}='${v}'`);
    else lines.push(`${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "$$$$")}"`);
  }
  return lines.join("\n") + "\n";
}

/** Template-owned files: overwritten on every render. User data (functions/<slug>, snippets) is never touched. */
const MANAGED = ["docker-compose.yml", "volumes/api", "volumes/db", "volumes/pooler", "volumes/functions/main", "volumes/functions/deno.jsonc"];
const SEEDED = ["volumes/functions/hello", "volumes/snippets"]; // copied on first render only

function copyRecursive(src: string, dst: string) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) copyRecursive(path.join(src, f), path.join(dst, f));
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

function writeSecretFile(file: string, content: string) {
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** Write STORAGE_DIR/base/{ref}/ (idempotent). Returns the project dir. */
export function renderStack(i: RenderInput, opts: { dir?: string; template?: string } = {}): string {
  const dir = opts.dir ?? projectDir(i.ref);
  const tpl = opts.template ?? templateDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const rel of MANAGED) {
    const src = path.join(tpl, rel);
    if (!fs.existsSync(src)) continue;
    fs.rmSync(path.join(dir, rel), { recursive: true, force: true });
    copyRecursive(src, path.join(dir, rel));
  }
  for (const rel of SEEDED) {
    const src = path.join(tpl, rel);
    if (fs.existsSync(src) && !fs.existsSync(path.join(dir, rel))) copyRecursive(src, path.join(dir, rel));
  }
  fs.mkdirSync(path.join(dir, "backups"), { recursive: true });
  fs.mkdirSync(path.join(dir, "ca"), { recursive: true });
  const { env, authEnv, functionsEnv, templates } = buildEnv(i);
  const tdir = path.join(dir, "volumes", "templates");
  fs.mkdirSync(tdir, { recursive: true });
  for (const [id, body] of Object.entries(templates)) fs.writeFileSync(path.join(tdir, `${id}.html`), body);
  writeSecretFile(path.join(dir, ".env"), serializeEnv(env));
  writeSecretFile(path.join(dir, "auth.env"), serializeEnv(authEnv));
  writeSecretFile(path.join(dir, "functions.env"), serializeEnv(functionsEnv));
  // public DB port: compose override publishing the gateway's pooler (session) listener on the host
  const pub = path.join(dir, PUBLIC_OVERRIDE);
  if (i.dbPublicPort) fs.writeFileSync(pub, publicOverride(i.dbPublicPort, i.dbPublicBind ?? "0.0.0.0"));
  else fs.rmSync(pub, { force: true });
  const ca = path.join(dir, "ca", "egress-ca.crt");
  if (i.egressCa) fs.writeFileSync(ca, i.egressCa);
  else fs.rmSync(ca, { force: true });
  return dir;
}

export const PUBLIC_OVERRIDE = "docker-compose.public.yml";

/** LEVANTBASE: the only host port a stack ever gets (plan `publicDbPort`, setPublicPort). */
export function publicOverride(port: number, bind = "0.0.0.0"): string {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`invalid public port ${port}`);
  if (!/^[0-9a-fA-F:.]+$/.test(bind)) throw new Error(`invalid bind address ${bind}`);
  return `# rendered by LevantDeploy (setPublicPort): Postgres pooler (session mode, TLS required) on the host\nservices:\n  api-gw:\n    ports:\n      - "${bind.includes(":") ? `[${bind}]` : bind}:${port}:5432"\n`;
}
