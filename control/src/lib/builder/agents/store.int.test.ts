/**
 * Integration test against a real Postgres + Redis (isolated DB). Skipped unless BUILDER_AGENTS_DB_TEST=1:
 *   set -a; . ./.env.bagents; set +a; BUILDER_AGENTS_DB_TEST=1 npx vitest run src/lib/builder/agents/store.int.test.ts
 */
import { describe, expect, it } from "vitest";

const enabled = process.env.BUILDER_AGENTS_DB_TEST === "1";

describe.skipIf(!enabled)("builder runs with Prisma + Redis", () => {
  it("startRun → executeRun (fake LLM) → events, messages, SSE replay, cancel", async () => {
    const { db } = await import("@/lib/db");
    const { createWorkspace } = await import("@/lib/builder/workspace");
    const { startRun, cancelRun, getRunDTO, runEventStream } = await import("./runs");
    const { prismaStore, redisBus } = await import("./store");
    const { coreWorkspace } = await import("./deps");
    const { executeRun } = await import("./orchestrator");
    const { fakeLlm, fakeChecks, fakeBackend } = await import("./testing");

    const team = await db.team.findFirstOrThrow({ where: { slug: "admin" } });
    const user = await db.user.findFirstOrThrow({ where: { email: "admin@levantdeploy.local" } });
    // unlimited credits for the test team (platform owner team may already be)
    const bp = await db.builderProject.create({ data: { teamId: team.id, name: "int-test", createdById: user.id } });
    try {
      await createWorkspace(bp.id, { name: "int-test" });
      const { run } = await startRun({ builderProjectId: bp.id, userId: user.id, message: "Add an about page", mode: "build", enqueue: false });
      expect(run.status).toBe("QUEUED");
      await expect(startRun({ builderProjectId: bp.id, userId: user.id, message: "again", mode: "build", enqueue: false })).rejects.toMatchObject({ code: "CONFLICT" });

      const llm = fakeLlm({
        planner: [{ json: { summary: "About page", kind: "feature", backend: { needed: false }, design: { update: false }, files: [{ path: "app/about/page.tsx", action: "create", group: "about" }] } }],
        coder: [{ calls: [{ name: "write_file", args: { path: "app/about/page.tsx", content: 'export const metadata = { title: "About" };\nexport default function About() {\n  return <main><h1>About us</h1></main>;\n}\n' } }] }],
        summarizer: [{ text: "Added an About page." }],
      });
      const deps = { llm, workspace: coreWorkspace(), checks: fakeChecks(), backend: fakeBackend(), store: prismaStore(), bus: redisBus(), sleep: async () => {} };
      expect(await executeRun(deps, run.id, { budgets: { ensembleSize: 1 } })).toBe("SUCCEEDED");

      const dto = (await getRunDTO(run.id))!;
      expect(dto.status).toBe("SUCCEEDED");
      expect(dto.resultCommit).toMatch(/^[0-9a-f]{40}$/);
      expect((dto.steps as { key: string }[]).map((s) => s.key)).toEqual(expect.arrayContaining(["plan", "code:about", "check:0", "summarize"]));
      expect((dto.usage as { byProvider: Record<string, unknown> }).byProvider.gemini).toBeTruthy();
      const msgs = await db.builderMessage.findMany({ where: { builderProjectId: bp.id }, orderBy: { createdAt: "asc" } });
      expect(msgs.map((m) => m.role)).toEqual(["USER", "ASSISTANT"]);
      expect(msgs[1].content).toBe("Added an About page.");
      expect(msgs[1].commitSha).toBe(dto.resultCommit);
      const project = await db.builderProject.findUniqueOrThrow({ where: { id: bp.id } });
      expect(project.status).toBe("READY");
      expect(project.lastCommit).toBe(dto.resultCommit);

      // SSE replay of a finished run: all events, closes after the final status
      const res = runEventStream(run.id, 0);
      const text = await new Response(res.body).text();
      const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
      expect(ids.length).toBe(dto.lastSeq);
      expect(text).toContain("event: file");
      expect(text).toMatch(/event: status\ndata: .*"SUCCEEDED"/);
      // resume from Last-Event-ID
      const tail = await new Response(runEventStream(run.id, dto.lastSeq - 2).body).text();
      expect([...tail.matchAll(/^id: /gm)].length).toBe(2);

      // cancel a queued run
      const second = await startRun({ builderProjectId: bp.id, userId: user.id, message: "Make it blue", mode: "build", enqueue: false });
      const canceled = await cancelRun(second.run.id);
      expect(canceled?.status).toBe("CANCELED");
    } finally {
      await db.builderProject.delete({ where: { id: bp.id } }).catch(() => {});
    }
  }, 60_000);
});
