import { z } from "zod";
import type { Prisma } from "@prisma/client";

/** `Project.gitSettings` JSON (git area). */
export const deployHookSchema = z.object({
  id: z.string(),
  name: z.string(),
  branch: z.string(),
  /** encryptString(token) — the hook URL is shown again in the settings */
  tokenEnc: z.string(),
  createdAt: z.string(),
  lastTriggeredAt: z.string().nullable().optional(),
});
export type DeployHook = z.infer<typeof deployHookSchema>;

export const gitSettingsSchema = z.object({
  /** HTTPS token for private generic Git repos (encrypted) */
  tokenEnc: z.string().nullable().optional(),
  tokenUsername: z.string().nullable().optional(),
  deployHooks: z.array(deployHookSchema).default([]),
  polling: z
    .object({
      enabled: z.boolean().default(false),
      /** last seen head per branch */
      heads: z.record(z.string()).default({}),
      lastCheckedAt: z.string().nullable().optional(),
      lastError: z.string().nullable().optional(),
    })
    .default({ enabled: false, heads: {} }),
});
export type GitSettings = z.infer<typeof gitSettingsSchema>;

export function parseGitSettings(raw: unknown): GitSettings {
  const r = gitSettingsSchema.safeParse(raw ?? {});
  return r.success ? r.data : gitSettingsSchema.parse({});
}

export const toJson = (s: GitSettings) => s as unknown as Prisma.InputJsonObject;
