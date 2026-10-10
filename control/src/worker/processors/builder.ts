/**
 * builder-agents: queue "builder" — one job per AI builder run (src/lib/builder/agents).
 *
 *  - runs/resumes the orchestrator; the run keeps going when the browser closes (events → DB + Redis pub/sub);
 *  - cancel: POST …/cancel sets cancelRequestedAt and publishes on CANCEL_CHANNEL → the in-flight LLM call is aborted;
 *  - resume: a worker that dies mid-run leaves the run RUNNING with a checkpoint. BullMQ's stalled-job check puts the
 *    job back in the queue; the start hook + a periodic sweep re-enqueue RUNNING/QUEUED runs whose job is gone.
 */
import { onWorkerStart, queues, registerProcessor, registerSchedule } from "@/lib/queues";
import { db } from "@/lib/db";
import { newRedis } from "@/lib/redis";
import { executeRun } from "@/lib/builder/agents/orchestrator";
import { productionDeps } from "@/lib/builder/agents/deps";
import { CANCEL_CHANNEL, leaseAlive } from "@/lib/builder/agents/store";

const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[builder]", ...a);

async function sweep() {
  const stale = new Date(Date.now() - 60_000);
  const runs = await db.builderRun.findMany({ where: { status: { in: ["QUEUED", "RUNNING"] }, updatedAt: { lt: stale } }, select: { id: true, status: true } });
  for (const r of runs) {
    // someone (a worker job, a dev script) is executing it right now
    if (await leaseAlive(r.id)) continue;
    const job = await queues.builder.raw.getJob(`builder-${r.id}`);
    const state = job ? await job.getState() : "missing";
    if (["active", "waiting", "delayed", "prioritized", "waiting-children"].includes(state)) continue;
    // also skip if a resume job is pending
    const pending = await queues.builder.raw.getJobs(["waiting", "active", "delayed"], 0, 200);
    if (pending.some((j) => j.data?.runId === r.id)) continue;
    log(`re-enqueue ${r.status} run ${r.id} (job ${state})`);
    await queues.builder.add({ runId: r.id }, { jobId: `builder-${r.id}-r${Date.now()}` });
  }
}

registerProcessor(
  "builder",
  async (job) => {
    if (job.data.sweep) return sweep();
    const runId = job.data.runId;
    if (!runId) return;
    const ac = new AbortController();
    const sub = newRedis();
    sub.on("message", (_ch, id) => {
      if (id === runId) {
        log(`cancel ${runId}`);
        ac.abort();
      }
    });
    await sub.subscribe(CANCEL_CHANNEL).catch(() => {});
    const t = Date.now();
    try {
      let status = await executeRun(productionDeps(), runId, { signal: ac.signal });
      // lease held elsewhere: right after a crash the dead worker's lease lives ≤ 60 s — wait it out, then resume
      for (let i = 0; status === "RUNNING" && i < 4 && !ac.signal.aborted; i++) {
        await new Promise((r) => setTimeout(r, 20_000));
        status = await executeRun(productionDeps(), runId, { signal: ac.signal });
      }
      log(`run ${runId} → ${status} in ${Math.round((Date.now() - t) / 1000)}s`);
      return { status };
    } finally {
      await sub.quit().catch(() => {});
    }
  },
  { concurrency: Number(process.env.BUILDER_CONCURRENCY) > 0 ? Number(process.env.BUILDER_CONCURRENCY) : 3, lockDuration: 60_000 },
);

registerSchedule("builder", "builder-sweep", { every: 2 * 60_000 }, { sweep: true });
onWorkerStart("builder-resume", sweep);
