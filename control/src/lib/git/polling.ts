import { db } from "@/lib/db";
import { createDeployment } from "@/lib/deployments";
import { stopPreviews } from "./runtime-adapter";
import { lsRemote } from "./exec";
import { projectRemote } from "./auth";
import { parseGitSettings, toJson } from "./settings";
import { diffHeads } from "./polling-diff";

/**
 * Branch polling for generic Git projects (non-GitHub hosts have no webhook into us).
 * Worker schedule: queue `git`, every 2 minutes (src/worker/processors/git.ts).
 *  - production branch moved → PRODUCTION deployment
 *  - other branch moved/created → PREVIEW deployment (if previewDeployments)
 *  - branch deleted → its previews are stopped
 * The first poll only records the current heads.
 */
export type PollResult = { projectId: string; deployed: string[]; deleted: string[]; error?: string };

export { diffHeads };

export async function pollProject(projectId: string): Promise<PollResult> {
  const p = await db.project.findUnique({ where: { id: projectId } });
  if (!p || p.sourceType !== "GIT") return { projectId, deployed: [], deleted: [] };
  const s = parseGitSettings(p.gitSettings);
  const remote = await projectRemote(p.id);
  if (!remote) return { projectId, deployed: [], deleted: [] };
  let heads: Record<string, string>;
  try {
    heads = (await lsRemote(remote.url, remote.auth)).heads;
  } catch (e) {
    s.polling.lastError = (e as Error).message.slice(0, 500);
    s.polling.lastCheckedAt = new Date().toISOString();
    await db.project.update({ where: { id: p.id }, data: { gitSettings: toJson(s) } });
    return { projectId, deployed: [], deleted: [], error: s.polling.lastError };
  }
  const first = Object.keys(s.polling.heads).length === 0;
  const { changed, deleted } = diffHeads(s.polling.heads, heads);
  const deployed: string[] = [];
  if (!first && p.autoDeploy && !p.pausedAt) {
    for (const branch of changed.slice(0, 10)) {
      const isProd = branch === p.productionBranch;
      if (!isProd && !p.previewDeployments) continue;
      const target = isProd ? "PRODUCTION" : "PREVIEW";
      const exists = await db.deployment.findFirst({ where: { projectId: p.id, target, commitSha: heads[branch] }, select: { id: true } });
      if (exists) continue;
      const d = await createDeployment({ projectId: p.id, target, trigger: "GIT_PUSH", source: { branch, commitSha: heads[branch] }, meta: { source: "git-poll" } });
      deployed.push(d.id);
    }
    for (const b of deleted) await stopPreviews(p.id, { branch: b }).catch(() => {});
  }
  // re-read before writing (settings may have changed meanwhile)
  const fresh = parseGitSettings((await db.project.findUnique({ where: { id: p.id }, select: { gitSettings: true } }))?.gitSettings);
  fresh.polling.heads = heads;
  fresh.polling.lastCheckedAt = new Date().toISOString();
  fresh.polling.lastError = null;
  await db.project.update({ where: { id: p.id }, data: { gitSettings: toJson(fresh) } });
  return { projectId, deployed, deleted };
}

export async function pollAll(): Promise<PollResult[]> {
  const projects = await db.project.findMany({
    where: { sourceType: "GIT", pausedAt: null, gitSettings: { path: ["polling", "enabled"], equals: true } },
    select: { id: true },
    take: 500,
  });
  const out: PollResult[] = [];
  for (const p of projects) out.push(await pollProject(p.id).catch((e) => ({ projectId: p.id, deployed: [], deleted: [], error: (e as Error).message })));
  return out;
}
