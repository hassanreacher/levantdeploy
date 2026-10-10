import type { Deployment, DeploymentStatus, DeploymentTarget, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { hostUrl } from "@/lib/deployments";

/** Serializable deployment row for the dashboard UI + API (dates as ISO strings). */
export type DeploymentDTO = {
  id: string;
  shortId: string;
  number: number;
  projectId: string;
  target: DeploymentTarget;
  status: DeploymentStatus;
  trigger: string;
  branch: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  commitAuthor: string | null;
  commitAuthorAvatar: string | null;
  prNumber: number | null;
  url: string;
  /** url with scheme */
  fullUrl: string;
  isCurrentProduction: boolean;
  sourceDeploymentId: string | null;
  errorMessage: string | null;
  errorStep: string | null;
  duration: number | null;
  createdAt: string;
  buildStartedAt: string | null;
  buildFinishedAt: string | null;
  deployStartedAt: string | null;
  readyAt: string | null;
  finishedAt: string | null;
  stoppedAt: string | null;
  imageTag: string | null;
  framework: string | null;
  meta: Record<string, unknown>;
  createdBy: { id: string; name: string; avatar: string | null } | null;
};

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function toDTO(d: Deployment & { createdBy?: { id: string; name: string; avatar: string | null } | null }): DeploymentDTO {
  return {
    id: d.id,
    shortId: d.shortId,
    number: d.number,
    projectId: d.projectId,
    target: d.target,
    status: d.status,
    trigger: d.trigger,
    branch: d.branch,
    commitSha: d.commitSha,
    commitMessage: d.commitMessage,
    commitAuthor: d.commitAuthor,
    commitAuthorAvatar: d.commitAuthorAvatar,
    prNumber: d.prNumber,
    url: d.url,
    fullUrl: hostUrl(d.url),
    isCurrentProduction: d.isCurrentProduction,
    sourceDeploymentId: d.sourceDeploymentId,
    errorMessage: d.errorMessage,
    errorStep: d.errorStep,
    duration: d.duration,
    createdAt: d.createdAt.toISOString(),
    buildStartedAt: iso(d.buildStartedAt),
    buildFinishedAt: iso(d.buildFinishedAt),
    deployStartedAt: iso(d.deployStartedAt),
    readyAt: iso(d.readyAt),
    finishedAt: iso(d.finishedAt),
    stoppedAt: iso(d.stoppedAt),
    imageTag: d.imageTag,
    framework: d.framework,
    meta: (d.meta as Record<string, unknown>) ?? {},
    createdBy: d.createdBy ? { id: d.createdBy.id, name: d.createdBy.name, avatar: d.createdBy.avatar } : null,
  };
}

export const createdBySelect = { select: { id: true, name: true, avatar: true } } as const;

export type DeploymentFilters = {
  cursor?: string;
  limit?: number;
  target?: DeploymentTarget;
  branch?: string;
  status?: DeploymentStatus[];
  q?: string;
};

/** Cursor-paginated (createdAt desc, cursor = last id) deployments of a project. */
export async function listDeployments(projectId: string, f: DeploymentFilters = {}): Promise<{ items: DeploymentDTO[]; next: string | null }> {
  const limit = Math.min(Math.max(f.limit ?? 20, 1), 100);
  const where: Prisma.DeploymentWhereInput = { projectId };
  if (f.target) where.target = f.target;
  if (f.branch) where.branch = f.branch;
  if (f.status?.length) where.status = { in: f.status };
  if (f.q) {
    const q = f.q.trim();
    where.OR = [
      { shortId: { startsWith: q.toLowerCase() } },
      { commitSha: { startsWith: q.toLowerCase() } },
      { commitMessage: { contains: q, mode: "insensitive" } },
      { branch: { contains: q, mode: "insensitive" } },
      ...(/^#?\d+$/.test(q) ? [{ number: Number(q.replace("#", "")) }] : []),
    ];
  }
  const rows = await db.deployment.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
    include: { createdBy: createdBySelect },
  });
  const more = rows.length > limit;
  const items = rows.slice(0, limit).map(toDTO);
  return { items, next: more ? items[items.length - 1]!.id : null };
}

/** Distinct branches (most recent first) for the filter dropdown. */
export async function recentBranches(projectId: string, take = 30): Promise<string[]> {
  const rows = await db.deployment.findMany({
    where: { projectId, branch: { not: null } },
    distinct: ["branch"],
    orderBy: { createdAt: "desc" },
    select: { branch: true },
    take,
  });
  return rows.map((r) => r.branch!).filter(Boolean);
}
