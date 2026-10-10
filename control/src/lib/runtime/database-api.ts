import { z } from "zod";
import type { Backup, Database } from "@prisma/client";
import { ENGINES } from "./db-engines";
import { isValidCron } from "./cron-expr";

export const dbNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9-]*$/, "Use lowercase letters, digits and dashes, starting with a letter");

const cron = z
  .string()
  .trim()
  .max(100)
  .superRefine((s, ctx) => {
    const e = isValidCron(s);
    if (e) ctx.addIssue({ code: "custom", message: e });
  });

export const createDbSchema = z.object({
  name: dbNameSchema,
  engine: z.enum(["POSTGRES", "MYSQL", "REDIS", "MONGO"]),
  version: z.string().trim().max(30).optional(),
  projectId: z.string().max(40).nullish(),
  publicAccess: z.boolean().default(false),
  backupSchedule: cron.nullish(),
  backupRetention: z.number().int().min(1).max(365).default(7),
});

export const updateDbSchema = z.object({
  projectId: z.string().max(40).nullable().optional(),
  publicAccess: z.boolean().optional(),
  backupSchedule: cron.nullable().optional(),
  backupRetention: z.number().int().min(1).max(365).optional(),
});

export function databaseDTO(d: Database & { project?: { id: string; slug: string; name: string } | null; backups?: Backup[] }) {
  const spec = ENGINES[d.engine];
  const last = d.backups?.[0];
  return {
    id: d.id,
    name: d.name,
    engine: d.engine,
    engineLabel: spec.label,
    version: d.version,
    status: d.status,
    projectId: d.projectId,
    project: d.project ? { id: d.project.id, slug: d.project.slug, name: d.project.name } : null,
    internalHost: d.internalHost,
    port: spec.port,
    publicPort: d.publicPort,
    backupSchedule: d.backupSchedule,
    backupRetention: d.backupRetention,
    envNames: spec.envNames,
    lastError: d.lastError,
    lastBackup: last ? { id: last.id, status: last.status, createdAt: last.createdAt.toISOString(), sizeBytes: last.sizeBytes } : null,
    createdAt: d.createdAt.toISOString(),
  };
}
export type DatabaseDTO = ReturnType<typeof databaseDTO>;

export function backupDTO(b: Backup) {
  return {
    id: b.id,
    status: b.status,
    trigger: b.trigger,
    sizeBytes: b.sizeBytes,
    error: b.error,
    hasFile: !!b.path,
    fileName: b.path ? b.path.split("/").pop() : null,
    startedAt: b.startedAt?.toISOString() ?? null,
    finishedAt: b.finishedAt?.toISOString() ?? null,
    createdAt: b.createdAt.toISOString(),
  };
}
export type BackupDTO = ReturnType<typeof backupDTO>;

export const ENGINE_OPTIONS = (Object.keys(ENGINES) as Array<keyof typeof ENGINES>).map((k) => ({
  value: k,
  label: ENGINES[k].label,
  versions: ENGINES[k].versions,
  defaultVersion: ENGINES[k].defaultVersion,
}));
