import { z } from "zod";

/**
 * Process environment, validated with zod and parsed lazily (so `next build` works without a full env).
 * Import `env` anywhere on the server / in the worker: `env.PLATFORM_DOMAIN`.
 * Never import this from client components.
 */
const isProd = process.env.NODE_ENV === "production";
const devOnly = <T extends z.ZodTypeAny>(schema: T, devDefault: string) => (isProd ? schema : schema.default(devDefault as never));
const optionalStr = z.string().trim().min(1).optional().catch(undefined);

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: devOnly(z.string().min(1), "redis://localhost:6379"),
  ENCRYPTION_KEY: devOnly(z.string().min(16, "ENCRYPTION_KEY must be 16+ chars (use 32+ random chars)"), "dev-only-encryption-key-change-me"),
  SESSION_SECRET: devOnly(z.string().min(32, "SESSION_SECRET must be 32+ chars"), "dev-only-session-secret-change-me-dev-only-secret"),
  /** apps are served at *.PLATFORM_DOMAIN */
  PLATFORM_DOMAIN: devOnly(z.string().min(1), "levant.localhost"),
  /** "https" in production behind Caddy, "http" for local dev without TLS */
  PLATFORM_SCHEME: z.enum(["http", "https"]).default(isProd ? "https" : "http"),
  /** host (optionally :port) of the dashboard, e.g. "deploy.example.com" */
  DASHBOARD_HOST: devOnly(z.string().min(1), "localhost:3000"),
  /** public base URL of the dashboard (defaults to {scheme}://{DASHBOARD_HOST}) */
  APP_URL: optionalStr,
  STORAGE_DIR: z.string().default(isProd ? "/var/lib/levantdeploy/storage" : "./storage"),
  WORK_DIR: z.string().default(isProd ? "/var/lib/levantdeploy/work" : "./storage/work"),
  DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),
  DOCKER_NETWORK: z.string().default("levant_net"),
  CADDY_ADMIN_URL: z.string().default(isProd ? "http://caddy:2019" : "http://localhost:2019"),
  // ── runtime area (proxy / domains) ──
  /** how Caddy reaches the control app (dashboard host, tls-ask, 404/503 pages): host:port */
  CONTROL_UPSTREAM: z.string().default(isProd ? "control:3000" : "host.docker.internal:3000"),
  /** "acme" = public certificates (Let's Encrypt/ZeroSSL, on-demand), "internal" = Caddy local CA (dev / no public DNS) */
  PROXY_TLS: z.enum(["acme", "internal", "off"]).default(isProd ? "acme" : "internal"),
  ACME_EMAIL: optionalStr,
  /** directory INSIDE the Caddy container for the JSON access log */
  CADDY_LOG_DIR: z.string().default("/var/log/caddy"),
  /** the same access log as seen by the worker (shared volume / bind mount) */
  CADDY_ACCESS_LOG: z.string().optional(),
  /** comma-separated public IPv4/IPv6 of this server (A/AAAA targets shown in DNS instructions + verified) */
  SERVER_IPS: z.string().default(""),
  /** comma-separated DNS resolvers used for domain verification (default: public resolvers) */
  DNS_RESOLVERS: z.string().default("1.1.1.1,8.8.8.8"),
  // ── base-runtime area (LevantBase) ──
  /** Base projects are served at {ref}.BASE_DOMAIN and studio-{ref}.BASE_DOMAIN (default base.{PLATFORM_DOMAIN}) */
  BASE_DOMAIN: optionalStr,
  /** registry mirror prefix for the Base stack images, e.g. "mirror.gcr.io" (Docker Hub rate limits) */
  BASE_IMAGE_MIRROR: optionalStr,
  /** directory of the stack template (default: <repo>/base-stack/template, /app/base-stack/template in the image) */
  BASE_TEMPLATE_DIR: optionalStr,
  /** optional outbound HTTP(S) proxy for Base auth + edge functions (servers behind a proxy) */
  BASE_EGRESS_PROXY: optionalStr,
  /** CA bundle (PEM, path on the worker) trusted by edge functions when BASE_EGRESS_PROXY intercepts TLS */
  BASE_EGRESS_CA_FILE: optionalStr,
  /** host port range for public DB access (setPublicPort), "from-to" */
  BASE_DB_PORT_RANGE: z.string().regex(/^\d{4,5}-\d{4,5}$/).default("54000-54999"),
  /** host address public DB ports bind to (default all interfaces) */
  BASE_DB_PORT_BIND: optionalStr,
  /** hostname shown in public DB connection strings (default {ref}.{BASE_DOMAIN}) */
  BASE_DB_HOST: optionalStr,
  ANTHROPIC_API_KEY: optionalStr,
  ANTHROPIC_MODEL: optionalStr,
  SMTP_HOST: optionalStr,
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: optionalStr,
  SMTP_PASS: optionalStr,
  SMTP_FROM: z.string().default("LevantDeploy <no-reply@levantdeploy.local>"),
  SMTP_SECURE: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  GITHUB_APP_ID: optionalStr,
  GITHUB_APP_SLUG: optionalStr,
  GITHUB_APP_PRIVATE_KEY: optionalStr,
  GITHUB_APP_WEBHOOK_SECRET: optionalStr,
  GITHUB_APP_CLIENT_ID: optionalStr,
  GITHUB_APP_CLIENT_SECRET: optionalStr,
  /** registration after the first user: "open" | "invite" (default invite-only) */
  REGISTRATION: z.enum(["open", "invite"]).default("invite"),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  WORKER_CONCURRENCY_BUILD: z.coerce.number().int().positive().optional(),
  WORKER_CONCURRENCY_DEPLOY: z.coerce.number().int().positive().optional(),
  LOG_MAX_LINES: z.coerce.number().int().positive().default(50_000),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${msg}`);
  }
  cached = parsed.data;
  return cached;
}

/** Lazily-validated env object. */
export const env: Env = new Proxy({} as Env, {
  get: (_t, prop: string) => loadEnv()[prop as keyof Env],
});

export function appUrl(path = ""): string {
  const e = loadEnv();
  const base = (e.APP_URL || `${e.PLATFORM_SCHEME}://${e.DASHBOARD_HOST}`).replace(/\/$/, "");
  return base + path;
}
