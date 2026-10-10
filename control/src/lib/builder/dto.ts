import { db } from "@/lib/db";
import type { CommitInfo, FileChange } from "./git";

/** Commit → API shape (matches src/lib/builder-ui/types.ts Commit). Adds runId (agent commits) and published flags. */
export async function commitDTOs(builderId: string, commits: CommitInfo[]) {
  const shas = commits.map((c) => c.sha);
  const [msgs, bp] = await Promise.all([
    db.builderMessage.findMany({ where: { builderProjectId: builderId, commitSha: { in: shas } }, select: { commitSha: true, agentRunId: true } }),
    db.builderProject.findUnique({ where: { id: builderId }, select: { projectId: true } }),
  ]);
  const runs = await db.builderRun.findMany({ where: { builderProjectId: builderId, resultCommit: { in: shas } }, select: { id: true, resultCommit: true } });
  const published = bp?.projectId
    ? new Set(
        (await db.deployment.findMany({ where: { projectId: bp.projectId, commitSha: { in: shas }, status: { in: ["READY", "SUPERSEDED", "QUEUED", "BUILDING", "DEPLOYING"] } }, select: { commitSha: true } })).map(
          (d) => d.commitSha,
        ),
      )
    : new Set<string | null>();
  const runOf = new Map<string, string>();
  for (const m of msgs) if (m.commitSha && m.agentRunId) runOf.set(m.commitSha, m.agentRunId);
  for (const r of runs) if (r.resultCommit) runOf.set(r.resultCommit, r.id);
  return commits.map((c) => commitDTO(c, { runId: runOf.get(c.sha) ?? null, published: published.has(c.sha) }));
}

export function commitDTO(c: CommitInfo, extra: { runId?: string | null; published?: boolean; files?: FileChange[] } = {}) {
  return {
    sha: c.sha,
    shortSha: c.shortSha,
    message: c.message,
    title: c.title,
    date: c.date,
    author: { kind: c.author.kind, role: c.author.role, name: c.author.name },
    parents: c.parents,
    runId: extra.runId ?? null,
    published: extra.published ?? false,
    ...(extra.files ? { files: extra.files } : {}),
  };
}
