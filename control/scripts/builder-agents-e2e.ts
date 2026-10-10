/**
 * builder-agents end-to-end driver (dev/sandbox): runs one AI builder run IN-PROCESS with the production ports
 * (llm router, builder-core git/workspace/preview, LevantBase) against the DB in DATABASE_URL and prints a report.
 *
 *   set -a; . ./.env.bagents; . /home/user/.levant-secrets/providers.env; set +a
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/builder-agents-e2e.ts --new "Coffee shop" --message "Build a landing page …"
 *   … --project <builderProjectId> --message "Make the hero darker" [--mode build|chat|fix] [--gemini-only]
 */
import { db } from "@/lib/db";
import { setSetting } from "@/lib/settings";
import { createWorkspace } from "@/lib/builder/workspace";
import { productionDeps } from "@/lib/builder/agents/deps";
import { executeRun } from "@/lib/builder/agents/orchestrator";
import { runEventStream, startRun } from "@/lib/builder/agents/runs";
import { BUILTIN_PROVIDERS } from "@/lib/llm";
import type { RunMode } from "@/lib/builder/agents/types";

const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function geminiOnly() {
  const providers: Record<string, Record<string, unknown>> = {};
  for (const p of BUILTIN_PROVIDERS) providers[p.id] = { enabled: p.id === "gemini" };
  await setSetting("llm.providers", providers as never);
  const g = ["gemini/gemini-3.5-flash", "gemini/gemini-3-flash-preview", "gemini/gemini-3.1-flash-lite", "gemini/gemini-3.1-pro-preview"];
  await setSetting("llm.preferences", { plan: g, code: g, fix: g, judge: g, chat: g, vision: g, fast: ["gemini/gemini-3.1-flash-lite", ...g] } as never);
}

async function main() {
  if (process.argv.includes("--gemini-only")) await geminiOnly();
  const team = await db.team.findFirstOrThrow({ where: { slug: arg("team") ?? "admin" } });
  const user = await db.user.findFirstOrThrow({ where: { email: "admin@levantdeploy.local" } });
  let projectId = arg("project");
  if (!projectId) {
    const p = await db.builderProject.create({ data: { teamId: team.id, name: arg("new") ?? "E2E app", createdById: user.id, prompt: arg("message") } });
    await createWorkspace(p.id, { name: p.name });
    projectId = p.id;
  }
  const message = arg("message") ?? "Build a landing page for a coffee shop with menu and contact form";
  const t0 = Date.now();
  if (process.argv.includes("--queue")) {
    // through the worker (queue "builder") — follow the SSE stream like the browser does
    const { run } = await startRun({ builderProjectId: projectId, userId: user.id, message, mode: (arg("mode") as RunMode) ?? "build" });
    console.log(`project ${projectId} run ${run.id} (queued)`);
    let after = 0;
    for (;;) {
      const res = runEventStream(run.id, after);
      const reader = res.body!.getReader();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!data) continue;
          const ev = JSON.parse(data.slice(6)) as { seq: number; type: string; data: Record<string, unknown> };
          after = ev.seq;
          console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s #${ev.seq} ${ev.type.padEnd(8)} ${JSON.stringify(ev.data).slice(0, 220)}`);
        }
      }
      const r = await db.builderRun.findUniqueOrThrow({ where: { id: run.id } });
      if (["SUCCEEDED", "FAILED", "CANCELED"].includes(r.status)) {
        const state = r.state as { checkIteration: number; resumes: number; degraded: string[] };
        console.log(JSON.stringify({ status: r.status, seconds: Math.round((Date.now() - t0) / 1000), fixIterations: state?.checkIteration, resumes: state?.resumes, usage: r.usage, degraded: state?.degraded, error: r.error, projectId, runId: run.id }, null, 2));
        process.exit(0);
      }
    }
  }
  const { run } = await startRun({ builderProjectId: projectId, userId: user.id, message, mode: (arg("mode") as RunMode) ?? "build", enqueue: false });
  console.log(`project ${projectId} run ${run.id}`);
  const deps = productionDeps();
  const bus = deps.bus;
  deps.bus = {
    async publish(id, ev) {
      const d = ev.data as Record<string, unknown>;
      const short =
        ev.type === "file" ? `${d.action} ${d.path} (+${d.added ?? "?"}/-${d.removed ?? "?"})` :
        ev.type === "check" ? `${d.kind} ${d.skipped ? "SKIPPED" : d.ok ? "OK" : "FAIL"} #${d.iteration}${d.ok ? "" : `\n${String(d.output).slice(0, 600)}`}` :
        ev.type === "plan" ? JSON.stringify(d.plan).slice(0, 600) :
        JSON.stringify(d).slice(0, 300);
      console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s ${ev.type.padEnd(8)} ${short}`);
      await bus.publish(id, ev);
    },
  };
  const status = await executeRun(deps, run.id);
  const r = await db.builderRun.findUniqueOrThrow({ where: { id: run.id } });
  const state = r.state as { checkIteration: number; usage: unknown; degraded: string[]; backendRef: string | null };
  console.log(JSON.stringify({ status, seconds: Math.round((Date.now() - t0) / 1000), fixIterations: state.checkIteration, usage: r.usage, degraded: state.degraded, backendRef: state.backendRef, error: r.error, projectId, runId: run.id }, null, 2));
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
