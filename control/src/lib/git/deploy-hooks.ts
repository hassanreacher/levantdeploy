import { db } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { decryptString, encryptString, randomId, randomToken, timingSafeEqual } from "@/lib/crypto";
import { parseGitSettings, toJson, type DeployHook } from "./settings";
import { deployBranch, TriggerError } from "./trigger";

/**
 * Deploy hooks (like Vercel): a secret URL that triggers a deployment of a branch when POSTed to.
 *   POST {APP_URL}/api/v1/deploy-hooks/{projectId}/{token}
 */
export const hookUrl = (projectId: string, token: string) => appUrl(`/api/v1/deploy-hooks/${projectId}/${token}`);

export type PublicHook = { id: string; name: string; branch: string; url: string; createdAt: string; lastTriggeredAt: string | null };

const toPublic = (projectId: string, h: DeployHook): PublicHook => ({
  id: h.id,
  name: h.name,
  branch: h.branch,
  url: hookUrl(projectId, decryptString(h.tokenEnc) ?? "invalid"),
  createdAt: h.createdAt,
  lastTriggeredAt: h.lastTriggeredAt ?? null,
});

export async function listDeployHooks(projectId: string): Promise<PublicHook[]> {
  const p = await db.project.findUnique({ where: { id: projectId }, select: { gitSettings: true } });
  return parseGitSettings(p?.gitSettings).deployHooks.map((h) => toPublic(projectId, h));
}

export async function createDeployHook(projectId: string, input: { name: string; branch: string }): Promise<PublicHook> {
  const p = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { gitSettings: true } });
  const s = parseGitSettings(p.gitSettings);
  if (s.deployHooks.length >= 20) throw new TriggerError(400, "A project can have at most 20 deploy hooks");
  const token = randomToken(24);
  const hook: DeployHook = { id: "hk_" + randomId(12), name: input.name, branch: input.branch, tokenEnc: encryptString(token), createdAt: new Date().toISOString(), lastTriggeredAt: null };
  s.deployHooks.push(hook);
  await db.project.update({ where: { id: projectId }, data: { gitSettings: toJson(s) } });
  return toPublic(projectId, hook);
}

export async function deleteDeployHook(projectId: string, hookId: string): Promise<boolean> {
  const p = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { gitSettings: true } });
  const s = parseGitSettings(p.gitSettings);
  const before = s.deployHooks.length;
  s.deployHooks = s.deployHooks.filter((h) => h.id !== hookId);
  await db.project.update({ where: { id: projectId }, data: { gitSettings: toJson(s) } });
  return s.deployHooks.length < before;
}

/** Validates the token and creates the deployment. 404 for unknown project/token (no existence leak). */
export async function triggerDeployHook(projectId: string, token: string) {
  const p = await db.project.findUnique({ where: { id: projectId }, select: { id: true, gitSettings: true, pausedAt: true } });
  if (!p) throw new TriggerError(404, "Not found");
  const s = parseGitSettings(p.gitSettings);
  const hook = s.deployHooks.find((h) => {
    const t = decryptString(h.tokenEnc);
    return !!t && timingSafeEqual(t, token);
  });
  if (!hook) throw new TriggerError(404, "Not found");
  if (p.pausedAt) throw new TriggerError(409, "Project is paused");
  const dep = await deployBranch(p.id, hook.branch, { trigger: "API", meta: { deployHook: hook.name } });
  hook.lastTriggeredAt = new Date().toISOString();
  // re-read to avoid clobbering concurrent edits of other fields
  const fresh = parseGitSettings((await db.project.findUnique({ where: { id: p.id }, select: { gitSettings: true } }))?.gitSettings);
  fresh.deployHooks = fresh.deployHooks.map((h) => (h.id === hook.id ? { ...h, lastTriggeredAt: hook.lastTriggeredAt } : h));
  await db.project.update({ where: { id: p.id }, data: { gitSettings: toJson(fresh) } });
  return { hook, deployment: dep };
}
