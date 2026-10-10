/** Row → DTO conversion for Base projects (worker-safe). */
import type { BaseBackup, BaseEvent, BaseFunction, BaseProject, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { projectUrl, studioUrl } from "./adapters";
import { readStored } from "./settings";
import { BASE_REGION, type BackupDTO, type BaseEventDTO, type BaseProjectDTO, type BaseStatus, type FunctionDTO } from "./shared";

export const baseInclude = {
  project: { select: { id: true, slug: true, name: true } },
  createdBy: { select: { name: true, avatar: true } },
} satisfies Prisma.BaseProjectInclude;

export type BaseRow = Prisma.BaseProjectGetPayload<{ include: typeof baseInclude }>;

export function customDomainOf(b: Pick<BaseProject, "settings">): string | null {
  const c = readStored(b.settings).customDomain;
  return c && c.status === "ACTIVE" ? c.hostname : null;
}

export function toBaseDTO(b: BaseRow): BaseProjectDTO {
  return {
    id: b.id,
    ref: b.ref,
    name: b.name,
    status: b.status as BaseStatus,
    region: b.region === "local" ? BASE_REGION : b.region,
    apiUrl: projectUrl(b.ref, customDomainOf(b)),
    studioUrl: studioUrl(b.ref),
    createdAt: b.createdAt.toISOString(),
    lastActivityAt: b.lastActivityAt?.toISOString() ?? null,
    versions: (b.versions && typeof b.versions === "object" ? b.versions : {}) as Record<string, string>,
    project: b.project ?? null,
    dbPublicPort: b.dbPublicPort,
    customDomain: readStored(b.settings).customDomain?.hostname ?? null,
    createdBy: b.createdBy ?? null,
    errorMessage: b.status === "ERROR" ? (b.statusMessage ?? null) : null,
  };
}

export const eventDTO = (e: BaseEvent): BaseEventDTO => ({
  id: e.id,
  type: e.type,
  level: e.level,
  message: e.message,
  createdAt: e.createdAt.toISOString(),
  meta: (e.meta as Record<string, unknown> | null) ?? null,
});

export const backupDTO = (b: BaseBackup & { createdBy?: string | null }): BackupDTO => ({
  id: b.id,
  status: b.status,
  kind: b.kind,
  sizeBytes: b.sizeBytes === null ? null : Number(b.sizeBytes),
  storageSizeBytes: b.storageSizeBytes === null ? null : Number(b.storageSizeBytes),
  hasStorage: !!b.storagePath,
  createdAt: b.createdAt.toISOString(),
  finishedAt: b.finishedAt?.toISOString() ?? null,
  error: b.error,
  createdBy: b.createdBy ?? null,
});

export const functionDTO = (ref: string, f: BaseFunction, apiUrl = projectUrl(ref)): FunctionDTO => ({
  id: f.id,
  name: f.name,
  slug: f.slug,
  verifyJwt: f.verifyJwt,
  version: f.version,
  status: f.deployedAt ? "ACTIVE" : "PENDING",
  updatedAt: f.updatedAt.toISOString(),
  createdAt: f.createdAt.toISOString(),
  url: `${apiUrl}/functions/v1/${f.slug}`,
});

export async function listTeamBases(teamId: string): Promise<BaseProjectDTO[]> {
  const rows = await db.baseProject.findMany({ where: { teamId }, include: baseInclude, orderBy: { createdAt: "desc" } });
  return rows.map(toBaseDTO);
}
