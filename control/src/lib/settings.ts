import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { cached, invalidate } from "@/lib/redis";

/**
 * Typed platform settings stored in the `Setting` table (key → JSON).
 * Add a key here (schema + default) before using it:
 *
 *   const domain = await getSetting("platform.domain");
 *   await setSetting("build.proxy", { httpProxy: "http://…", noProxy: "localhost" });
 */
export const SETTINGS = {
  /** overrides env PLATFORM_DOMAIN when set (null = use env) */
  "platform.domain": z.string().min(1).nullable().default(null),
  "platform.name": z.string().min(1).default("LevantDeploy"),
  /** registration after the first user: open = anyone (with email verification), invite = team invites only, closed = nobody (plans area) */
  "platform.registration": z.enum(["open", "invite", "closed"]).default("open"),
  // ── plans area: sign-up policy ──
  /** unverified users can sign in but cannot create projects / deployments */
  "auth.requireEmailVerification": z.boolean().default(true),
  /** reject sign-ups from known disposable / throwaway email domains */
  "auth.blockDisposableEmails": z.boolean().default(true),
  /** extra disposable domains blocked in addition to the built-in list */
  "auth.disposableDomains": z.array(z.string().trim().toLowerCase().min(3)).max(5000).default([]),
  /** sign-ups per IP: max accounts per window */
  "auth.signupRateLimit": z.object({ limit: z.number().int().min(1).max(1000), windowMinutes: z.number().int().min(1).max(10_080) }).default({ limit: 5, windowMinutes: 60 }),
  /** sign-up requires accepting the terms (checkbox); termsUrl / privacyUrl are linked when set */
  "auth.requireTerms": z.boolean().default(true),
  "auth.termsUrl": z.string().url().nullable().default(null),
  "auth.privacyUrl": z.string().url().nullable().default(null),
  /** HTTP(S) proxy + extra CA for builds (build area) */
  "build.proxy": z
    .object({
      httpProxy: z.string().optional(),
      httpsProxy: z.string().optional(),
      noProxy: z.string().optional(),
      caCertPem: z.string().optional(),
      /** docker build --network (host: builds reach a proxy listening on the host's loopback) — build area */
      network: z.enum(["host", "default"]).optional(),
    })
    .default({}),
  /** optional registry to push images to (default: local images only) */
  "build.registry": z.object({ url: z.string(), username: z.string().optional(), passwordEnc: z.string().optional() }).nullable().default(null),
  /** Docker Hub pull-through mirror for the base images of generated Dockerfiles, e.g. "mirror.gcr.io" (build area) */
  "build.registryMirror": z.string().trim().min(1).nullable().default(null),
  "build.concurrency": z.number().int().min(1).max(16).default(2),
  "build.timeoutMinutes": z.number().int().min(1).max(240).default(30),
  "limits.defaults": z
    .object({ cpuLimit: z.number().positive().nullable(), memoryLimitMb: z.number().int().positive().nullable(), maxReplicas: z.number().int().positive() })
    .default({ cpuLimit: 1, memoryLimitMb: 512, maxReplicas: 4 }),
  "deploy.keepStoppedDeployments": z.number().int().min(0).max(50).default(5),
  "deploy.drainSeconds": z.number().int().min(0).max(600).default(30),
  "logs.retentionDays": z.number().int().min(1).max(3650).default(30),
  "metrics.retentionDays": z.number().int().min(1).max(365).default(14),
  /** GitHub App credentials created via the manifest flow (git area). Secrets are encrypted. */
  "github.app": z
    .object({
      appId: z.string(),
      slug: z.string(),
      clientId: z.string().optional(),
      clientSecretEnc: z.string().optional(),
      privateKeyEnc: z.string(),
      webhookSecretEnc: z.string(),
      htmlUrl: z.string().optional(),
    })
    .nullable()
    .default(null),
  // ── ops area (platform Settings → General / Limits / Email / Backups / Updates) ──
  /** public IPs of this server (auto-detected or typed by the owner) — DNS instructions; env SERVER_IPS is the fallback */
  "platform.serverIps": z
    .object({ ipv4: z.string().nullable(), ipv6: z.string().nullable(), detectedAt: z.string().nullable() })
    .default({ ipv4: null, ipv6: null, detectedAt: null }),
  /** SMTP; overrides env SMTP_* when set (password encrypted with encryptString) */
  smtp: z
    .object({
      host: z.string().min(1),
      port: z.number().int().min(1).max(65535),
      secure: z.boolean(),
      user: z.string().nullable(),
      passEnc: z.string().nullable(),
      from: z.string().min(3),
    })
    .nullable()
    .default(null),
  /** scheduled pg_dump of the control database into STORAGE_DIR/backups/control (ops worker) */
  "backups.control": z
    .object({ enabled: z.boolean(), schedule: z.string().min(9).max(100), keep: z.number().int().min(1).max(365) })
    .default({ enabled: true, schedule: "23 3 * * *", keep: 7 }),
  /** URL of a JSON ({version, notes?, url?}) or plain-text version file; null = env LEVANT_UPDATE_URL */
  "updates.checkUrl": z.string().url().nullable().default(null),
  /** max size of a CLI/dashboard source upload, MB (git area enforces it; capped at 2047 by the Upload.size Int column) */
  "uploads.maxSizeMb": z.number().int().min(1).max(20_480).default(512),
  /** git area: days a completed upload is kept (needed for redeploys of upload deployments) */
  "uploads.retentionDays": z.number().int().min(1).max(3650).default(30),
  "ai.enabled": z.boolean().default(true),
  "ai.model": z.string().nullable().default(null),
  /** ai area: output_config.effort for the agent (null = "medium") */
  "ai.effort": z.enum(["low", "medium", "high", "xhigh", "max"]).nullable().default(null),
  /** ai area: Anthropic API key encrypted with encryptString (null = use env ANTHROPIC_API_KEY) */
  "ai.apiKeyEnc": z.string().nullable().default(null),
  /** ai area: run a read-only diagnosis on every failed deployment (stored in deployment.meta.aiDiagnosis) */
  "ai.autoDiagnose": z.boolean().default(false),
  // ── llm area (Settings → AI providers): router config for the builder agents (src/lib/llm) ──
  /** per-provider overrides (enabled, encrypted key, base URL, headers, vars, models, limits) + owner-added custom providers */
  "llm.providers": z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  /** ranked "provider/model" refs per purpose (missing purpose = built-in default list) */
  "llm.preferences": z.record(z.string(), z.array(z.string()).max(100)).nullable().default(null),
  "llm.routing": z
    .object({ timeoutMs: z.number().int().min(5_000).max(600_000), maxAttempts: z.number().int().min(1).max(20), sameModelRetries: z.number().int().min(0).max(3) })
    .partial()
    .nullable()
    .default(null),
  /** cached GET /models per provider: { [id]: { fetchedAt, models: [{ id, contextWindow?, maxOutput?, vision?, tools?, free? }] } } */
  "llm.modelsCache": z.record(z.string(), z.object({ fetchedAt: z.string(), models: z.array(z.record(z.string(), z.unknown())) })).default({}),
} satisfies Record<string, z.ZodTypeAny>;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.output<(typeof SETTINGS)[K]>;

export async function getSetting<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
  const schema = SETTINGS[key] as z.ZodTypeAny;
  const raw = await cached(`setting:${key}`, 30, async () => (await db.setting.findUnique({ where: { key } }))?.value ?? null);
  const parsed = schema.safeParse(raw === null ? undefined : raw);
  return (parsed.success ? parsed.data : schema.parse(undefined)) as SettingValue<K>;
}

export async function setSetting<K extends SettingKey>(key: K, value: SettingValue<K>): Promise<SettingValue<K>> {
  const schema = SETTINGS[key] as z.ZodTypeAny;
  const v = schema.parse(value);
  await db.setting.upsert({ where: { key }, create: { key, value: v ?? Prisma.JsonNull }, update: { value: v ?? Prisma.JsonNull } });
  await invalidate(`setting:${key}`);
  return v as SettingValue<K>;
}

export async function getAllSettings(): Promise<{ [K in SettingKey]: SettingValue<K> }> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(SETTINGS) as SettingKey[]) out[k] = await getSetting(k);
  return out as { [K in SettingKey]: SettingValue<K> };
}
