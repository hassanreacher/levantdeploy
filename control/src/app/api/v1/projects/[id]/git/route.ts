import { z } from "zod";
import { route, json, body, requireProjectRole, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { encryptString } from "@/lib/crypto";
import { hasRole } from "@/lib/auth/roles";
import { parseGitSettings, toJson } from "@/lib/git/settings";
import { listDeployHooks } from "@/lib/git/deploy-hooks";
import { parseGitUrl, defaultTokenUsername } from "@/lib/git/url";
import { lsRemote } from "@/lib/git/exec";
import { gitAuthFor } from "@/lib/git/auth";
import { getRepo } from "@/lib/github/installations";
import { gitHubAppStatus } from "@/lib/github/config";
import { readPendingKey, dropPendingKey } from "@/lib/git/pending-keys";

export const dynamic = "force-dynamic";

async function view(projectId: string, canSeeHooks: boolean) {
  const p = await db.project.findUniqueOrThrow({ where: { id: projectId }, include: { githubInstallation: true } });
  const s = parseGitSettings(p.gitSettings);
  return {
    sourceType: p.sourceType,
    productionBranch: p.productionBranch,
    rootDirectory: p.rootDirectory,
    autoDeploy: p.autoDeploy,
    previewDeployments: p.previewDeployments,
    github: p.sourceType === "GITHUB"
      ? {
          repoFullName: p.githubRepoFullName,
          repoId: p.githubRepoId?.toString() ?? null,
          installationId: p.githubInstallation?.installationId ?? null,
          account: p.githubInstallation?.accountLogin ?? null,
          connected: !!p.githubInstallation && !p.githubInstallation.suspendedAt,
        }
      : null,
    git: p.sourceType === "GIT"
      ? {
          url: p.gitUrl,
          isSsh: !!parseGitUrl(p.gitUrl ?? "")?.isSsh,
          hasToken: !!s.tokenEnc,
          tokenUsername: s.tokenUsername ?? null,
          deployKeyPublic: p.gitDeployKeyPublic,
          polling: { enabled: s.polling.enabled, lastCheckedAt: s.polling.lastCheckedAt ?? null, lastError: s.polling.lastError ?? null, branches: Object.keys(s.polling.heads).length },
        }
      : null,
    image: p.sourceType === "IMAGE" ? p.image : null,
    deployHooks: canSeeHooks ? await listDeployHooks(p.id) : [],
    githubApp: await gitHubAppStatus(),
  };
}

/** GET /api/v1/projects/:id/git → git connection, deploy key (public), polling state, deploy hooks */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  const { project, role } = await requireProjectRole(id, "VIEWER", { scope: "projects:read" });
  return json(await view(project.id, hasRole(role, "MEMBER")));
});

const patch = z.object({
  productionBranch: z.string().trim().min(1).max(250).optional(),
  autoDeploy: z.boolean().optional(),
  previewDeployments: z.boolean().optional(),
  rootDirectory: z.string().max(500).optional(),
  /** connect / switch source */
  connect: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("github"), installationId: z.number().int().positive(), repoId: z.number().int().positive().optional(), repoFullName: z.string().optional() }),
      z.object({ type: z.literal("git"), url: z.string().trim().min(3).max(1000), token: z.string().max(2000).nullable().optional(), tokenUsername: z.string().max(200).nullable().optional(), deployKeyId: z.string().nullable().optional() }),
      z.object({ type: z.literal("disconnect") }),
    ])
    .optional(),
  /** generic git only */
  token: z.string().max(2000).nullable().optional(),
  tokenUsername: z.string().max(200).nullable().optional(),
  polling: z.boolean().optional(),
});

/** PATCH /api/v1/projects/:id/git — branch / auto-deploy / previews / token / polling / connect a repo / disconnect (ADMIN) */
export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const input = await body(req, patch);
  const { project, team, actor } = await requireProjectRole(id, "ADMIN", { scope: "projects:write" });
  const s = parseGitSettings(project.gitSettings);
  const data: Record<string, unknown> = {};
  if (input.productionBranch !== undefined) data.productionBranch = input.productionBranch;
  if (input.autoDeploy !== undefined) data.autoDeploy = input.autoDeploy;
  if (input.previewDeployments !== undefined) data.previewDeployments = input.previewDeployments;
  if (input.rootDirectory !== undefined) {
    const r = input.rootDirectory.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (r.split("/").includes("..")) throw E.validation({ rootDirectory: "Must be inside the repository" });
    data.rootDirectory = r;
  }
  if (input.token !== undefined) {
    s.tokenEnc = input.token ? encryptString(input.token) : null;
    if (input.tokenUsername !== undefined) s.tokenUsername = input.tokenUsername;
  } else if (input.tokenUsername !== undefined) s.tokenUsername = input.tokenUsername;
  if (input.polling !== undefined) s.polling.enabled = input.polling;

  const c = input.connect;
  if (c?.type === "disconnect") {
    Object.assign(data, { sourceType: "UPLOAD", gitUrl: null, githubInstallationId: null, githubRepoId: null, githubRepoFullName: null, gitDeployKeyEnc: null, gitDeployKeyPublic: null });
    s.tokenEnc = null;
    s.polling = { enabled: false, heads: {} };
  } else if (c?.type === "github") {
    const inst = await db.gitHubInstallation.findUnique({ where: { installationId: c.installationId } });
    if (!inst || inst.teamId !== team.id) throw E.notFound("Installation not found");
    const repo = await getRepo(inst.installationId, (c.repoId ?? c.repoFullName)!).catch(() => {
      throw E.notFound("Repository not accessible");
    });
    Object.assign(data, {
      sourceType: "GITHUB",
      githubInstallationId: inst.id,
      githubRepoId: BigInt(repo.id),
      githubRepoFullName: repo.full_name,
      gitUrl: repo.clone_url,
      productionBranch: input.productionBranch ?? repo.default_branch,
    });
  } else if (c?.type === "git") {
    const parsed = parseGitUrl(c.url);
    if (!parsed || (parsed.protocol === "file" && process.env.GIT_ALLOW_FILE_URLS !== "1")) throw E.validation({ url: "Invalid Git URL" });
    let auth: Parameters<typeof lsRemote>[1] = { kind: "none" };
    if (parsed.isSsh) {
      if (c.deployKeyId) {
        const k = await readPendingKey(c.deployKeyId, team.id);
        if (!k) throw E.validation({ url: "Deploy key expired — generate a new one" });
        data.gitDeployKeyPublic = k.publicKey;
        data.gitDeployKeyEnc = encryptString(k.privateKey);
        auth = { kind: "ssh", privateKey: k.privateKey };
        await dropPendingKey(c.deployKeyId);
      } else {
        const existing = await gitAuthFor({ ...project, sourceType: "GIT", gitUrl: c.url, githubInstallation: null });
        if (existing?.auth.kind !== "ssh") throw E.validation({ url: "Generate a deploy key for SSH URLs" });
        auth = existing.auth;
      }
    } else if (c.token) {
      s.tokenEnc = encryptString(c.token);
      s.tokenUsername = c.tokenUsername || defaultTokenUsername(parsed.host);
      auth = { kind: "token", token: c.token, username: s.tokenUsername };
    }
    const remote = await lsRemote(parsed.isSsh ? c.url : parsed.clean, auth).catch((e) => {
      throw E.validation({ url: "Repository not reachable" }, `Could not access the repository: ${(e as Error).message}`);
    });
    s.polling.heads = remote.heads;
    Object.assign(data, {
      sourceType: "GIT",
      gitUrl: parsed.isSsh ? c.url : parsed.clean,
      githubInstallationId: null,
      githubRepoId: null,
      githubRepoFullName: null,
      productionBranch: input.productionBranch ?? remote.defaultBranch ?? project.productionBranch,
    });
  }
  data.gitSettings = toJson(s);
  await db.project.update({ where: { id: project.id }, data });
  await audit({ action: "project.git_update", teamId: team.id, actor, targetType: "project", targetId: project.id, meta: { fields: Object.keys(input), connect: c?.type ?? null } });
  return json(await view(project.id, true));
});
