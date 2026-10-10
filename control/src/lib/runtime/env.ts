import type { Deployment, EnvTarget, Project } from "@prisma/client";
import { db } from "@/lib/db";
import { decryptJson } from "@/lib/crypto";
import { resolveEnv } from "@/lib/dashboard/env-vars";
import { deploymentUrl, hostUrl, projectHost } from "@/lib/deployments";
import { ENGINES, connectionEnvNames, type DbCredentials } from "./db-engines";

/** Keys the platform always controls (user values are ignored). */
export const RESERVED_ENV = new Set(["PORT", "LEVANT", "LEVANT_ENV", "LEVANT_URL", "LEVANT_DEPLOYMENT_ID", "LEVANT_DEPLOYMENT_URL"]);

/** Connection strings of database add-ons connected to the project (internal hostnames on levant_net). */
export async function databaseEnv(projectId: string): Promise<Record<string, string>> {
  const dbs = await db.database.findMany({ where: { projectId, status: { in: ["RUNNING", "PROVISIONING"] } }, orderBy: { createdAt: "asc" } });
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const d of dbs) {
    const creds = decryptJson<DbCredentials>(d.credentialsEnc);
    if (!creds || !d.internalHost) continue;
    const first = !seen.has(d.engine);
    seen.add(d.engine);
    const url = ENGINES[d.engine].url(creds, d.internalHost, ENGINES[d.engine].port);
    for (const name of connectionEnvNames(d.engine, d.name, first)) out[name] ??= url;
  }
  return out;
}

/** Full runtime environment of a deployment (decrypted). Never log the result. */
export async function buildRuntimeEnv(
  project: Project,
  dep: Pick<Deployment, "id" | "url" | "target" | "branch" | "commitSha" | "commitMessage" | "number" | "shortId">,
  extra: { replica?: number } = {},
): Promise<Record<string, string>> {
  const target: EnvTarget = dep.target === "PRODUCTION" ? "PRODUCTION" : "PREVIEW";
  // shared groups < project vars < branch-specific preview vars (dashboard area helper)
  const user = await resolveEnv(project.id, target, dep.branch ?? null);
  const dbEnv = await databaseEnv(project.id);
  const prodDomain = await db.domain.findFirst({ where: { projectId: project.id, kind: "PLATFORM" }, select: { hostname: true } });

  const system: Record<string, string> = {
    LEVANT: "1",
    LEVANT_ENV: target === "PRODUCTION" ? "production" : "preview",
    LEVANT_URL: deploymentUrl(dep),
    LEVANT_DEPLOYMENT_URL: deploymentUrl(dep),
    LEVANT_DEPLOYMENT_ID: dep.id,
    LEVANT_DEPLOYMENT_NUMBER: String(dep.number),
    LEVANT_PROJECT: project.slug,
    LEVANT_PROJECT_ID: project.id,
    LEVANT_PROJECT_PRODUCTION_URL: hostUrl(prodDomain?.hostname ?? projectHost(project.slug)),
    LEVANT_GIT_BRANCH: dep.branch ?? "",
    LEVANT_GIT_COMMIT_SHA: dep.commitSha ?? "",
    LEVANT_GIT_COMMIT_MESSAGE: (dep.commitMessage ?? "").split("\n")[0]!.slice(0, 200),
    PORT: String(project.port),
  };
  if (extra.replica !== undefined) system.LEVANT_REPLICA = String(extra.replica);
  // overridable defaults (bind on all interfaces: Next standalone reads HOSTNAME, many frameworks HOST)
  const defaults: Record<string, string> = { HOST: "0.0.0.0", HOSTNAME: "0.0.0.0" };
  if (target === "PRODUCTION") defaults.NODE_ENV = "production";

  const merged: Record<string, string> = { ...defaults, ...dbEnv, ...user };
  for (const k of Object.keys(merged)) if (RESERVED_ENV.has(k)) delete merged[k];
  return { ...merged, ...system };
}

export function envToList(env: Record<string, string>): string[] {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}
