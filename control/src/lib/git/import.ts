import { z } from "zod";
import type { Deployment, Prisma, Project, Team, DeploymentTrigger } from "@prisma/client";
import { db } from "@/lib/db";
import { encryptString } from "@/lib/crypto";
import { slugify, RESERVED_PROJECT_SLUGS } from "@/lib/teams";
import { createDeployment } from "@/lib/deployments";
import { presetById, buildSettingsSchema } from "@/lib/build/types";
import { getRepo, getBranchHead } from "@/lib/github/installations";
import { reportDeploymentStatus } from "@/lib/github/status";
import { uploadFromDirectory } from "@/lib/uploads/storage";
import { lsRemote, GitError } from "./exec";
import { parseGitUrl, defaultTokenUsername } from "./url";
import { readPendingKey, dropPendingKey } from "./pending-keys";
import { templatePath } from "./templates";
import { safeRoot } from "./detect";
import { gitSettingsSchema, toJson } from "./settings";

/**
 * Project creation for every import path (GitHub repo, Git URL, upload, Docker image, template) + first deployment.
 * Used by POST /api/v1/projects (dashboard import flow and `levant link`/`levant deploy`).
 */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const envSchema = z
  .array(
    z.object({
      key: z.string().trim().regex(ENV_KEY_RE, "Invalid name").max(256),
      value: z.string().max(64 * 1024),
      targets: z.array(z.enum(["PRODUCTION", "PREVIEW", "DEVELOPMENT"])).min(1).optional(),
      isSecret: z.boolean().optional(),
    }),
  )
  .max(500)
  .default([]);

export const sourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("github"), installationId: z.number().int().positive(), repoId: z.number().int().positive().optional(), repoFullName: z.string().optional() }),
  z.object({
    type: z.literal("git"),
    url: z.string().trim().min(3).max(1000),
    token: z.string().max(2000).optional().nullable(),
    tokenUsername: z.string().max(200).optional().nullable(),
    deployKeyId: z.string().optional().nullable(),
    polling: z.boolean().optional(),
  }),
  z.object({ type: z.literal("upload"), uploadId: z.string().min(1) }),
  z.object({ type: z.literal("image"), image: z.string().trim().regex(/^[a-z0-9][a-z0-9._\-/:@]{0,250}$/i, "e.g. nginx:1.27 or ghcr.io/org/app:latest") }),
  z.object({ type: z.literal("template"), template: z.string().min(1).max(100) }),
  z.object({ type: z.literal("none") }),
]);

export const createProjectSchema = z.object({
  team: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(100),
  slug: z.string().trim().max(60).optional(),
  framework: z.string().nullable().optional(),
  rootDirectory: z.string().max(500).default(""),
  productionBranch: z.string().trim().max(250).optional(),
  buildSettings: buildSettingsSchema.partial().default({}),
  port: z.number().int().min(1).max(65535).optional(),
  kind: z.enum(["WEB", "WORKER", "STATIC", "COMPOSE"]).optional(),
  env: envSchema,
  source: sourceSchema,
  deploy: z.boolean().default(true),
  /** trigger recorded on the first deployment */
  trigger: z.enum(["MANUAL", "CLI", "API"]).default("MANUAL"),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export class ImportError extends Error {
  constructor(
    public status: number,
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export async function availableSlug(teamId: string, name: string): Promise<string> {
  const base = slugify(name, 40) || "app";
  const s = RESERVED_PROJECT_SLUGS.has(base) ? `${base}-app` : base;
  for (let i = 0; i < 50; i++) {
    const cand = i === 0 ? s : `${s.slice(0, 36)}-${i + 1}`;
    if (!(await db.project.findUnique({ where: { teamId_slug: { teamId, slug: cand } }, select: { id: true } }))) return cand;
  }
  throw new ImportError(409, "Could not find a free project name");
}

export async function createProjectFromImport(input: CreateProjectInput, ctx: { team: Team; userId: string }): Promise<{ project: Project; deployment: Deployment | null }> {
  const slug = input.slug ? slugify(input.slug, 40) : slugify(input.name, 40);
  if (!slug || RESERVED_PROJECT_SLUGS.has(slug)) throw new ImportError(422, "This name is reserved", { name: "This name is reserved" });
  if (await db.project.findUnique({ where: { teamId_slug: { teamId: ctx.team.id, slug } }, select: { id: true } })) {
    throw new ImportError(409, `A project named "${slug}" already exists in this team`, { name: "Already taken" });
  }
  let rootDirectory: string;
  try {
    rootDirectory = safeRoot(input.rootDirectory);
  } catch {
    throw new ImportError(422, "Invalid root directory", { rootDirectory: "Must be a relative path inside the repository" });
  }
  const framework = input.framework && input.framework !== "auto" ? input.framework : null;
  if (framework && !presetById(framework)) throw new ImportError(422, "Unknown framework preset", { framework: "Unknown preset" });
  const preset = presetById(framework);

  const data: Prisma.ProjectUncheckedCreateInput = {
    teamId: ctx.team.id,
    name: input.name,
    slug,
    framework,
    rootDirectory,
    buildSettings: { ...input.buildSettings, framework } as Prisma.InputJsonObject,
    kind: input.kind ?? preset?.kind ?? "WEB",
    port: input.port ?? preset?.port ?? 3000,
    createdById: ctx.userId,
    sourceType: "UPLOAD",
    productionBranch: input.productionBranch || "main",
  };
  let firstSource: { branch?: string | null; commitSha?: string | null; commitMessage?: string | null; commitAuthor?: string | null; commitAuthorAvatar?: string | null; uploadId?: string | null } = {};
  let pendingKeyId: string | null = null;
  const src = input.source;

  switch (src.type) {
    case "github": {
      const inst = await db.gitHubInstallation.findUnique({ where: { installationId: src.installationId } });
      if (!inst || inst.teamId !== ctx.team.id) throw new ImportError(404, "GitHub installation not found for this team");
      const ref = src.repoId ?? src.repoFullName;
      if (!ref) throw new ImportError(422, "repoId or repoFullName is required", { source: "Pick a repository" });
      let repo;
      try {
        repo = await getRepo(inst.installationId, ref);
      } catch (e) {
        throw new ImportError(404, `Repository not accessible by the GitHub App: ${(e as Error).message}`);
      }
      const branch = input.productionBranch || repo.default_branch;
      Object.assign(data, {
        sourceType: "GITHUB",
        githubInstallationId: inst.id,
        githubRepoId: BigInt(repo.id),
        githubRepoFullName: repo.full_name,
        gitUrl: repo.clone_url,
        productionBranch: branch,
      });
      const head = await getBranchHead(inst.installationId, repo.full_name, branch).catch(() => null);
      firstSource = { branch, commitSha: head?.sha ?? null, commitMessage: head?.message ?? null, commitAuthor: head?.author ?? null, commitAuthorAvatar: head?.avatar ?? null };
      break;
    }
    case "git": {
      const parsed = parseGitUrl(src.url);
      if (!parsed) throw new ImportError(422, "Invalid Git URL", { url: "Use https://host/owner/repo.git or git@host:owner/repo.git" });
      if (parsed.protocol === "file" && process.env.GIT_ALLOW_FILE_URLS !== "1") throw new ImportError(422, "file:// URLs are not allowed", { url: "Not allowed" });
      if (parsed.protocol === "http" && process.env.NODE_ENV === "production" && process.env.GIT_ALLOW_HTTP !== "1") {
        throw new ImportError(422, "Use https:// (plain http is disabled)", { url: "Use https://" });
      }
      const settings = gitSettingsSchema.parse({ polling: { enabled: src.polling ?? true, heads: {} } });
      let auth: Parameters<typeof lsRemote>[1] = { kind: "none" };
      if (parsed.isSsh) {
        if (!src.deployKeyId) throw new ImportError(422, "SSH URLs need a deploy key", { url: "Generate a deploy key and add it to the repository" });
        const k = await readPendingKey(src.deployKeyId, ctx.team.id);
        if (!k) throw new ImportError(422, "The deploy key expired — generate a new one", { url: "Deploy key expired" });
        data.gitDeployKeyPublic = k.publicKey;
        data.gitDeployKeyEnc = encryptString(k.privateKey);
        auth = { kind: "ssh", privateKey: k.privateKey };
        pendingKeyId = src.deployKeyId;
      } else if (src.token) {
        settings.tokenEnc = encryptString(src.token);
        settings.tokenUsername = src.tokenUsername || defaultTokenUsername(parsed.host);
        auth = { kind: "token", token: src.token, username: settings.tokenUsername };
      }
      let remote;
      try {
        remote = await lsRemote(parsed.clean, auth);
      } catch (e) {
        throw new ImportError(422, `Could not access the repository: ${e instanceof GitError ? e.message : (e as Error).message}`, { url: "Repository not reachable" });
      }
      const branch = input.productionBranch || remote.defaultBranch || Object.keys(remote.heads)[0] || "main";
      if (Object.keys(remote.heads).length && !remote.heads[branch]) throw new ImportError(422, `Branch "${branch}" not found`, { productionBranch: "Branch not found" });
      settings.polling.heads = remote.heads;
      Object.assign(data, { sourceType: "GIT", gitUrl: parsed.protocol === "ssh" ? src.url.trim() : parsed.clean, productionBranch: branch, gitSettings: toJson(settings) });
      firstSource = { branch, commitSha: remote.heads[branch] ?? null };
      break;
    }
    case "upload": {
      const up = await db.upload.findUnique({ where: { id: src.uploadId } });
      if (!up || up.teamId !== ctx.team.id) throw new ImportError(404, "Upload not found");
      if (up.status !== "COMPLETE") throw new ImportError(409, "Upload is not complete");
      data.sourceType = "UPLOAD";
      firstSource = { uploadId: up.id };
      break;
    }
    case "template": {
      const dir = templatePath(src.template);
      if (!dir) throw new ImportError(404, "Template not found");
      const up = await uploadFromDirectory(dir, { teamId: ctx.team.id, userId: ctx.userId });
      data.sourceType = "UPLOAD";
      data.description = `Created from the ${src.template} template`;
      firstSource = { uploadId: up.id };
      break;
    }
    case "image": {
      data.sourceType = "IMAGE";
      data.image = src.image;
      break;
    }
    case "none":
      data.sourceType = "UPLOAD";
      break;
  }

  const project = await db.$transaction(async (tx) => {
    const p = await tx.project.create({ data });
    if (input.env.length) {
      await tx.envVar.createMany({
        data: input.env.map((e) => ({
          projectId: p.id,
          key: e.key,
          valueEnc: encryptString(e.value),
          targets: e.targets ?? ["PRODUCTION", "PREVIEW", "DEVELOPMENT"],
          isSecret: e.isSecret ?? false,
          createdById: ctx.userId,
        })),
      });
    }
    if (firstSource.uploadId) await tx.upload.update({ where: { id: firstSource.uploadId }, data: { projectId: p.id } });
    return p;
  });
  if (pendingKeyId) await dropPendingKey(pendingKeyId);

  let deployment: Deployment | null = null;
  const canDeploy = src.type !== "none" && input.deploy;
  if (canDeploy) {
    deployment = await createDeployment({
      projectId: project.id,
      target: "PRODUCTION",
      trigger: input.trigger as DeploymentTrigger,
      createdById: ctx.userId,
      source: firstSource,
      meta: { source: src.type, firstDeployment: true },
    });
    await reportDeploymentStatus(deployment).catch(() => {});
  }
  return { project, deployment };
}
