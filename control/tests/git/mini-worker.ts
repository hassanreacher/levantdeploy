/**
 * Test helper: a worker that runs only the given processor files (e.g. build + git) — lets the git area verify
 * builds of CLI/GitHub deployments without starting runtime's deploy/proxy processors (shared Caddy).
 *   tsx --env-file=.env.git tests/git/mini-worker.ts build git
 */
import { Worker } from "bullmq";
import { QUEUE_PREFIX, bullConnection, getRegisteredProcessors, getRegisteredSchedules, getStartHooks, queues } from "@/lib/queues";

async function main() {
  const names = process.argv.slice(2);
  for (const n of names) await import(`../../src/worker/processors/${n}.ts`);
  for (const p of getRegisteredProcessors()) {
    const w = new Worker(p.queue, (job) => p.fn(job), { lockDuration: 120_000, ...p.options, concurrency: 1, connection: bullConnection(), prefix: QUEUE_PREFIX });
    w.on("failed", (j, e) => console.log(`[mini-worker] ${p.queue}#${j?.id} failed: ${e.message}`));
    w.on("completed", (j) => console.log(`[mini-worker] ${p.queue}#${j.id} done`));
    console.log(`[mini-worker] consuming ${p.queue}`);
  }
  for (const s of getRegisteredSchedules()) await queues[s.queue].raw.upsertJobScheduler(s.id, s.repeat, { name: s.id, data: s.data as never });
  for (const h of getStartHooks()) await Promise.resolve(h.fn()).catch((e) => console.log(`[mini-worker] hook ${h.name}: ${(e as Error).message}`));
}
main();
