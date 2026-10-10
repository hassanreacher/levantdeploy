import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { env } from "@/lib/env";
import { dockerNetwork } from "@/lib/docker";

/**
 * LevantBase naming + paths (pure helpers, no DB). One Base project = one compose project `lb_{ref}`:
 *   dir        STORAGE_DIR/base/{ref}/            (docker-compose.yml, .env, auth.env, functions.env, volumes/, backups/)
 *   network    lb_{ref}_net (internal) + lb_{ref}_egress (auth + functions only); gateway also on levant_net
 *   containers lb_{ref}_<service>              labels levant.base={ref}
 *   public     https://{ref}.{BASE_DOMAIN}       (API gateway)    https://studio-{ref}.{BASE_DOMAIN} (Studio, SSO-gated)
 *   internal   http://base-{ref}:8000            (gateway alias on levant_net — for server-side code in LevantDeploy apps)
 */

export const REF_LENGTH = 20;
export const REF_RE = /^[a-z]{20}$/;

/** 20 lowercase letters (same shape as upstream project refs; DNS-label safe). */
export function generateRef(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  const bytes = crypto.randomBytes(REF_LENGTH * 2);
  let out = "";
  for (let i = 0; i < bytes.length && out.length < REF_LENGTH; i++) {
    const b = bytes[i]!;
    if (b < 234) out += alphabet[b % 26]; // 234 = 9*26 → unbiased
  }
  while (out.length < REF_LENGTH) out += alphabet[crypto.randomInt(26)];
  return out;
}

export const isRef = (s: string) => REF_RE.test(s);

export function baseDomain(): string {
  return (env.BASE_DOMAIN || `base.${env.PLATFORM_DOMAIN}`).toLowerCase().replace(/\.$/, "");
}

export const apiHost = (ref: string) => `${ref}.${baseDomain()}`;
export const studioHost = (ref: string) => `studio-${ref}.${baseDomain()}`;
export const publicScheme = () => env.PLATFORM_SCHEME;
export const projectUrl = (ref: string) => `${publicScheme()}://${apiHost(ref)}`;
export const studioUrl = (ref: string) => `${publicScheme()}://${studioHost(ref)}`;

export const composeProject = (ref: string) => `lb_${ref}`;
export const containerName = (ref: string, service: string) => `lb_${ref}_${service}`;
export const gatewayContainer = (ref: string) => containerName(ref, "api-gw");
/** alias of the gateway on levant_net (LevantDeploy app containers → SUPABASE_URL for server-side code) */
export const gatewayAlias = (ref: string) => `base-${ref}`;
export const internalUrl = (ref: string) => `http://${gatewayAlias(ref)}:8000`;
/** Caddy dials these (container names on levant_net) */
export const gatewayDial = (ref: string) => `${gatewayContainer(ref)}:8000`;
export const studioGateDial = (ref: string) => `${gatewayContainer(ref)}:8001`;
export const publicNetwork = () => dockerNetwork();

/** Which host is this? `{ref}.{BASE_DOMAIN}` → api, `studio-{ref}.{BASE_DOMAIN}` → studio. */
export function parseBaseHost(raw: string): { kind: "api" | "studio"; ref: string } | null {
  const host = raw.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  const suffix = `.${baseDomain()}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  if (isRef(label)) return { kind: "api", ref: label };
  if (label.startsWith("studio-") && isRef(label.slice(7))) return { kind: "studio", ref: label.slice(7) };
  return null;
}

export function storageDir(): string {
  return path.resolve(env.STORAGE_DIR);
}
export const baseRoot = () => path.join(storageDir(), "base");
export const projectDir = (ref: string) => {
  if (!isRef(ref)) throw new Error(`invalid base ref "${ref}"`);
  return path.join(baseRoot(), ref);
};
export const backupsDir = (ref: string) => path.join(projectDir(ref), "backups");
export const functionsDir = (ref: string) => path.join(projectDir(ref), "volumes", "functions");

/** base-stack/template (rendered from upstream). */
export function templateDir(): string {
  const candidates = [
    env.BASE_TEMPLATE_DIR,
    path.resolve(process.cwd(), "../base-stack/template"),
    path.resolve(process.cwd(), "base-stack/template"),
    "/app/base-stack/template",
  ].filter(Boolean) as string[];
  for (const c of candidates) if (fs.existsSync(path.join(c, "docker-compose.yml"))) return c;
  throw new Error(`LevantBase template not found (tried ${candidates.join(", ")}); set BASE_TEMPLATE_DIR`);
}

/** Services of the stack and which ones are always on. */
export const CORE_SERVICES = ["db", "auth", "rest", "realtime", "storage", "imgproxy", "meta", "functions", "api-gw"] as const;
export const OPTIONAL_SERVICES = ["studio", "supavisor"] as const;
export type BaseService = (typeof CORE_SERVICES)[number] | (typeof OPTIONAL_SERVICES)[number];
export const ALL_SERVICES: readonly BaseService[] = [...CORE_SERVICES, ...OPTIONAL_SERVICES];
export const isService = (s: string): s is BaseService => (ALL_SERVICES as readonly string[]).includes(s);
/** compose service → container suffix (supavisor runs as lb_{ref}_pooler) */
export const containerSuffix = (s: BaseService) => (s === "supavisor" ? "pooler" : s);

export const STUDIO_IDLE_MS = 30 * 60_000;

export const STUDIO_RUNNING_KEY = (ref: string) => `lb:studio:running:${ref}`;
export const STUDIO_LAST_KEY = (ref: string) => `lb:studio:last:${ref}`;
