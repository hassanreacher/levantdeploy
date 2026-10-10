import { z } from "zod";
import type { Project } from "@prisma/client";
import { getSetting } from "@/lib/settings";

/**
 * Per-project runtime knobs stored in `Project.runtimeSettings` (JSON). All optional.
 *
 *   {
 *     drainSeconds: 30,                       // keep the previous production containers running this long after the switch
 *     startCommand: "node server.js",         // overrides the image CMD (run with sh -c)
 *     healthcheck: { type: "http"|"tcp"|"none", path: "/", timeoutSeconds: 120, intervalSeconds: 1,
 *                    accept: "lt500" | "2xx3xx" | "any" },
 *     workerStableSeconds: 10,                // kind WORKER: must stay running this long
 *     keepPreviewsPerBranch: 1,               // older READY previews of the same branch are stopped after the drain
 *     cronTimeoutSeconds: 900,
 *     logMaxSize: "10m", logMaxFile: 3,       // json-file log rotation
 *   }
 */
export const runtimeSettingsSchema = z
  .object({
    drainSeconds: z.number().int().min(0).max(600).optional(),
    startCommand: z.string().trim().min(1).max(2000).optional(),
    healthcheck: z
      .object({
        type: z.enum(["http", "tcp", "none"]).optional(),
        path: z.string().max(500).optional(),
        timeoutSeconds: z.number().int().min(5).max(1800).optional(),
        intervalSeconds: z.number().min(0.2).max(30).optional(),
        accept: z.enum(["lt500", "2xx3xx", "any"]).optional(),
      })
      .partial()
      .optional(),
    workerStableSeconds: z.number().int().min(1).max(600).optional(),
    keepPreviewsPerBranch: z.number().int().min(0).max(20).optional(),
    cronTimeoutSeconds: z.number().int().min(5).max(86400).optional(),
    logMaxSize: z.string().regex(/^\d+[kmg]$/).optional(),
    logMaxFile: z.number().int().min(1).max(20).optional(),
  })
  .passthrough();

export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;

export function runtimeSettings(p: Pick<Project, "runtimeSettings">): RuntimeSettings {
  const r = runtimeSettingsSchema.safeParse(p.runtimeSettings ?? {});
  return r.success ? r.data : {};
}

export type HealthConfig = {
  type: "http" | "tcp" | "running";
  path: string;
  timeoutMs: number;
  intervalMs: number;
  accept: "lt500" | "2xx3xx" | "any";
  /** WORKER: running for N ms */
  stableMs: number;
};

export function healthConfig(p: Pick<Project, "kind" | "healthcheckPath" | "runtimeSettings">): HealthConfig {
  const rs = runtimeSettings(p);
  const h = rs.healthcheck ?? {};
  let type: HealthConfig["type"];
  if (p.kind === "WORKER" || h.type === "none") type = "running";
  else if (h.type) type = h.type;
  else type = p.healthcheckPath ? "http" : "tcp";
  const path = (h.path ?? p.healthcheckPath ?? "/") || "/";
  return {
    type,
    path: path.startsWith("/") ? path : `/${path}`,
    timeoutMs: (h.timeoutSeconds ?? 120) * 1000,
    intervalMs: Math.round((h.intervalSeconds ?? 1) * 1000),
    accept: h.accept ?? "lt500",
    stableMs: (rs.workerStableSeconds ?? 10) * 1000,
  };
}

/** Is an HTTP status "alive" for the given policy? (5xx is never alive unless accept=any) */
export function statusAlive(status: number, accept: HealthConfig["accept"]): boolean {
  if (accept === "any") return status > 0;
  if (accept === "2xx3xx") return status >= 200 && status < 400;
  return status >= 200 && status < 500;
}

export async function drainSeconds(p: Pick<Project, "runtimeSettings">): Promise<number> {
  const rs = runtimeSettings(p);
  return rs.drainSeconds ?? (await getSetting("deploy.drainSeconds"));
}
