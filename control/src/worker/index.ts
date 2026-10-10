/**
 * LevantDeploy worker (`npm run worker`).
 *  1. imports every src/worker/processors/*.ts (each area registers its processors there)
 *  2. starts one BullMQ Worker per registered queue (concurrency: processor option > WORKER_CONCURRENCY_<QUEUE> > WORKER_CONCURRENCY)
 *  3. upserts repeatable schedules, runs onWorkerStart hooks (e.g. syncRoutes)
 *  4. graceful shutdown on SIGINT/SIGTERM (waits for active jobs up to 60 s)
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "bullmq";
import {
  QUEUE_PREFIX,
  bullConnection,
  closeQueues,
  getRegisteredProcessors,
  getRegisteredSchedules,
  getStartHooks,
  queues,
} from "@/lib/queues";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";

const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[worker]", ...a);

async function loadProcessors() {
  const dir = path.join(__dirname, "processors");
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.(ts|js|mjs)$/.test(f) && !f.endsWith(".d.ts") && !f.includes(".test."))
    .sort();
  for (const f of files) {
    await import(pathToFileURL(path.join(dir, f)).href);
    log(`loaded processors/${f}`);
  }
}

function concurrencyFor(queue: string, fromOptions?: number) {
  if (fromOptions) return fromOptions;
  const specific = Number(process.env[`WORKER_CONCURRENCY_${queue.toUpperCase()}`]);
  if (specific > 0) return specific;
  return Number(process.env.WORKER_CONCURRENCY) > 0 ? Number(process.env.WORKER_CONCURRENCY) : 2;
}

async function main() {
  await loadProcessors();
  const workers: Worker[] = [];
  for (const p of getRegisteredProcessors()) {
    const concurrency = concurrencyFor(p.queue, p.options.concurrency);
    const w = new Worker(
      p.queue,
      async (job) => {
        const t = Date.now();
        try {
          const res = await p.fn(job);
          log(`${p.queue}#${job.id} done in ${Date.now() - t}ms`);
          return res;
        } catch (e) {
          log(`${p.queue}#${job.id} failed: ${(e as Error).message}`);
          throw e;
        }
      },
      { lockDuration: 120_000, ...p.options, concurrency, connection: bullConnection(), prefix: QUEUE_PREFIX },
    );
    w.on("error", (e) => log(`${p.queue} worker error:`, e.message));
    workers.push(w);
    log(`queue "${p.queue}" → concurrency ${concurrency}`);
  }
  if (!workers.length) log("no processors registered yet (add files to src/worker/processors/)");

  for (const s of getRegisteredSchedules()) {
    await queues[s.queue].raw.upsertJobScheduler(s.id, s.repeat, { name: s.id, data: s.data as never });
    log(`schedule ${s.queue}/${s.id}`, JSON.stringify(s.repeat));
  }

  for (const h of getStartHooks()) {
    try {
      await h.fn();
      log(`start hook "${h.name}" ok`);
    } catch (e) {
      log(`start hook "${h.name}" failed:`, (e as Error).message);
    }
  }

  // heartbeat (dashboard can show worker health)
  const beat = setInterval(() => {
    void redis().set("ld:worker:heartbeat", String(Date.now()), "EX", 90).catch(() => {});
  }, 30_000);
  void redis().set("ld:worker:heartbeat", String(Date.now()), "EX", 90).catch(() => {});
  log(`ready (${workers.length} queue${workers.length === 1 ? "" : "s"})`);

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log(`${sig} received, draining…`);
    clearInterval(beat);
    const force = setTimeout(() => {
      log("forced exit after 60s");
      process.exit(1);
    }, 60_000);
    force.unref();
    await Promise.allSettled(workers.map((w) => w.close()));
    await closeQueues().catch(() => {});
    await db.$disconnect().catch(() => {});
    await redis().quit().catch(() => {});
    log("bye");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error("[worker] fatal", e);
  process.exit(1);
});
