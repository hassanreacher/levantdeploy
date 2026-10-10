import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { Deployment, Project, Upload } from "@prisma/client";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { getSetting } from "@/lib/settings";
import { slugify, RESERVED_PROJECT_SLUGS } from "@/lib/teams";
import { createDeployment, deploymentUrl, hostUrl, projectHost } from "@/lib/deployments";
import { assertCanCreateProject, assertCanDeploy } from "@/lib/plans/enforce";
import { storageDir, uploadRelPath, maxUploadBytes } from "@/lib/uploads/storage";
import { archive, getCommit, headSha } from "./git";

/**
 * Publish (builder-core): HEAD of the workspace → production deployment of the linked Deploy project.
 *   1. create (first publish) or reuse the Deploy project `BuilderProject.projectId` (same team, framework nextjs,
 *      source UPLOAD, port 3000); plan limits apply (projects, deployments/day)
 *   2. backend attached (baseRef) → attach the LevantBase project to the Deploy project + write its env vars
 *      (NEXT_PUBLIC_SUPABASE_URL/ANON_KEY, SUPABASE_URL/ANON_KEY) through the existing "connect" integration
 *   3. `git archive HEAD` (committed files only — never .env.local / node_modules) → COMPLETE Upload
 *   4. createDeployment({ target: PRODUCTION, source: { uploadId, commitSha, … } }) → build + deploy workers
 * The production build runs `next build` with the editor flag unset → no data-lv-src attributes, no bridge.
 * API-only (connectBaseEnv is server-only) — import from route handlers, not from the worker.
 */

export class PublishError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type PublishActor = { user: { id: string; name: string | null; email?: string | null } } & Record<string, unknown>;

async function uniqueProjectSlug(teamId: string, name: string): Promise<string> {
  const base = slugify(name || "app", 40) || "app";
  let slug = RESERVED_PROJECT_SLUGS.has(base) ? `${base}-app` : base;
  for (let i = 2; await db.project.findUnique({ where: { teamId_slug: { teamId, slug } }, select: { id: true } }); i++) slug = `${base.slice(0, 36)}-${i}`;
  return slug;
}

/** The Deploy project of a builder app (created on first publish). */
export async function ensureDeployProject(builderId: string, actor: PublishActor): Promise<{ project: Project; created: boolean }> {
  const bp = await db.builderProject.findUniqueOrThrow({ where: { id: builderId } });
  if (bp.projectId) {
    const p = await db.project.findUnique({ where: { id: bp.projectId } });
    if (p) return { project: p, created: false };
  }
  await assertCanCreateProject(bp.teamId, "deploy", { userId: actor.user.id });
  const slug = await uniqueProjectSlug(bp.teamId, bp.name);
  const project = await db.project.create({
    data: {
      teamId: bp.teamId,
      name: bp.name.slice(0, 100),
      slug,
      description: bp.description ?? `Built with LevantDeploy Builder`,
      framework: "nextjs",
      sourceType: "UPLOAD",
      kind: "WEB",
      port: 3000,
      createdById: actor.user.id,
    },
  });
  await db.builderProject.update({ where: { id: builderId }, data: { projectId: project.id } });
  await audit({ action: "project.create", teamId: bp.teamId, actor: actor as never, targetType: "project", targetId: project.id, meta: { slug, via: "builder", builderId } });
  return { project, created: true };
}

/** Snapshot of a commit as a COMPLETE upload (tar.gz from git archive). */
export async function uploadFromCommit(builderId: string, input: { teamId: string; projectId: string; userId: string; ref?: string }): Promise<Upload> {
  const bytes = await archive(builderId, { ref: input.ref ?? "HEAD", format: "tar.gz" });
  if (bytes.length > (await maxUploadBytes())) throw new PublishError(413, "The app is larger than the upload limit");
  const days = await getSetting("uploads.retentionDays");
  const row = await db.upload.create({
    data: {
      teamId: input.teamId,
      projectId: input.projectId,
      userId: input.userId,
      path: "",
      size: bytes.length,
      totalChunks: 1,
      receivedChunks: 1,
      status: "COMPLETE",
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      expiresAt: new Date(Date.now() + days * 86400_000),
    },
  });
  const rel = uploadRelPath(row.id);
  await fs.mkdir(path.join(storageDir(), "uploads"), { recursive: true });
  await fs.writeFile(path.join(storageDir(), rel), bytes);
  return db.upload.update({ where: { id: row.id }, data: { path: rel } });
}

/** Attach the builder app's backend to the Deploy project and write its env vars (idempotent). */
async function connectBackend(builderId: string, project: Project, actor: PublishActor): Promise<string[]> {
  const bp = await db.builderProject.findUniqueOrThrow({ where: { id: builderId }, select: { baseRef: true, teamId: true } });
  if (!bp.baseRef) return [];
  const base = await db.baseProject.findUnique({ where: { ref: bp.baseRef } });
  if (!base || base.teamId !== project.teamId) return [];
  if (!base.projectId) {
    const other = await db.baseProject.findUnique({ where: { projectId: project.id }, select: { id: true } });
    if (!other) await db.baseProject.update({ where: { id: base.id }, data: { projectId: project.id } });
  }
  const { connectBaseEnv } = await import("@/lib/base-ui/connect");
  const r = await connectBaseEnv({
    ref: base.ref,
    projectId: project.id,
    teamId: project.teamId,
    actor: actor as never,
    targets: ["PRODUCTION", "PREVIEW"],
    options: { includeServiceRole: false, includeDatabaseUrl: false, databaseUrlKind: "pooler" },
  });
  return r.keys;
}

export type PublishResult = {
  deployment: { id: string; number: number; url: string; status: Deployment["status"]; target: Deployment["target"]; createdAt: string };
  url: string;
  productionUrl: string;
  project: { id: string; slug: string; name: string };
  createdProject: boolean;
  commit: { sha: string; title: string };
  envKeys: string[];
};

export async function publishBuilderProject(builderId: string, actor: PublishActor): Promise<PublishResult> {
  const bp = await db.builderProject.findUnique({ where: { id: builderId } });
  if (!bp) throw new PublishError(404, "App not found");
  const head = await headSha(builderId);
  if (!head) throw new PublishError(409, "The app has no commits yet");
  const active = bp.lastDeploymentId ? await db.deployment.findUnique({ where: { id: bp.lastDeploymentId }, select: { status: true } }) : null;
  if (active && (active.status === "QUEUED" || active.status === "BUILDING" || active.status === "DEPLOYING")) throw new PublishError(409, "A publish is already in progress");
  await assertCanDeploy(bp.teamId, { userId: actor.user.id });
  const { project, created } = await ensureDeployProject(builderId, actor);
  const envKeys = await connectBackend(builderId, project, actor).catch((e) => {
    console.warn("[builder] publish: backend env", (e as Error).message);
    return [] as string[];
  });
  const commit = await getCommit(builderId, head);
  const upload = await uploadFromCommit(builderId, { teamId: bp.teamId, projectId: project.id, userId: actor.user.id, ref: head });
  const d = await createDeployment({
    projectId: project.id,
    target: "PRODUCTION",
    trigger: "MANUAL",
    createdById: actor.user.id,
    source: { uploadId: upload.id, branch: "main", commitSha: head, commitMessage: commit.title.slice(0, 500), commitAuthor: actor.user.name ?? "LevantDeploy Builder" },
    meta: { source: "builder", builderId },
  });
  await db.builderProject.update({ where: { id: builderId }, data: { lastDeploymentId: d.id, lastPublishedAt: new Date() } });
  await audit({ action: "builder.publish", teamId: bp.teamId, actor: actor as never, targetType: "builder_project", targetId: builderId, meta: { deploymentId: d.id, projectId: project.id, commit: head.slice(0, 12) } });
  return {
    deployment: { id: d.id, number: d.number, url: d.url, status: d.status, target: d.target, createdAt: d.createdAt.toISOString() },
    url: deploymentUrl(d),
    productionUrl: hostUrl(projectHost(project.slug)),
    project: { id: project.id, slug: project.slug, name: project.name },
    createdProject: created,
    commit: { sha: head, title: commit.title },
    envKeys,
  };
}

/** Publish state for the editor (last deployment, production URL). */
export async function publishState(builderId: string) {
  const bp = await db.builderProject.findUnique({ where: { id: builderId }, select: { projectId: true, lastDeploymentId: true, lastPublishedAt: true } });
  if (!bp) throw new PublishError(404, "App not found");
  const project = bp.projectId ? await db.project.findUnique({ where: { id: bp.projectId }, select: { id: true, slug: true, name: true } }) : null;
  const d = bp.lastDeploymentId ? await db.deployment.findUnique({ where: { id: bp.lastDeploymentId } }) : null;
  return {
    project,
    deployment: d ? { id: d.id, number: d.number, status: d.status, url: deploymentUrl(d), createdAt: d.createdAt.toISOString(), readyAt: d.readyAt?.toISOString() ?? null, errorMessage: d.errorMessage } : null,
    url: project ? hostUrl(projectHost(project.slug)) : null,
    lastPublishedAt: bp.lastPublishedAt?.toISOString() ?? null,
    lastPublishedCommit: d?.commitSha ?? null,
  };
}
