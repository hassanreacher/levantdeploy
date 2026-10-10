import type { CronJob, Project } from "@prisma/client";
import { db } from "@/lib/db";
import { docker, dockerNetwork, ensureNetwork, LABELS } from "@/lib/docker";
import { currentProduction, projectHost } from "@/lib/deployments";
import { buildRuntimeEnv, envToList } from "./env";
import { containerRefs, demuxBuffer, EXTRA_LABELS, inspectSafe, projectMounts } from "./containers";
import { runtimeSettings } from "./settings";
import { nextRun } from "./cron-expr";

const MAX_OUTPUT = 16 * 1024;
const tail = (s: string) => (s.length > MAX_OUTPUT ? "…(truncated)\n" + s.slice(-MAX_OUTPUT) : s);

export function computeNextRun(job: Pick<CronJob, "schedule" | "timezone">, after = new Date()): Date | null {
  try {
    return nextRun(job.schedule, after, job.timezone || "UTC");
  } catch {
    return null;
  }
}

/** Run one cron job now: one-off container from the current production image, or HTTP GET on the production app. */
export async function runCronJob(cronJobId: string, trigger: "SCHEDULED" | "MANUAL" = "SCHEDULED", existingRunId?: string) {
  const job = await db.cronJob.findUnique({ where: { id: cronJobId }, include: { project: true } });
  if (!job) return null;
  const started = new Date();
  const run = existingRunId
    ? await db.cronRun.update({ where: { id: existingRunId }, data: { status: "RUNNING", startedAt: started } })
    : await db.cronRun.create({ data: { cronJobId: job.id, status: "RUNNING", trigger, startedAt: started } });
  let status: "SUCCESS" | "FAILED" | "SKIPPED" = "FAILED";
  let exitCode: number | null = null;
  let output = "";
  try {
    const prod = await currentProduction(job.projectId);
    if (!prod || !prod.imageTag || (prod.status !== "READY" && prod.status !== "SUPERSEDED")) {
      status = "SKIPPED";
      output = "No production deployment yet — skipped.";
    } else if (job.command) {
      const r = await runOneOff(job.project, prod, job.command, runtimeSettings(job.project).cronTimeoutSeconds ?? 900, job.id);
      exitCode = r.exitCode;
      output = r.output;
      status = r.exitCode === 0 ? "SUCCESS" : "FAILED";
    } else if (job.path) {
      const refs = containerRefs(prod).filter((r) => !r.service || r.public);
      const ref = refs[0];
      if (!ref || prod.stoppedAt) {
        status = "FAILED";
        output = "Production deployment is not running.";
      } else {
        const info = await inspectSafe(ref.id);
        const ip = info?.NetworkSettings?.Networks?.[dockerNetwork()]?.IPAddress;
        const path = job.path.startsWith("/") ? job.path : `/${job.path}`;
        const t0 = Date.now();
        const res = await fetch(`http://${ip}:${ref.port}${path}`, {
          headers: { "user-agent": "LevantDeploy-Cron/1", host: projectHost(job.project.slug), "x-levant-cron": job.id },
          signal: AbortSignal.timeout((runtimeSettings(job.project).cronTimeoutSeconds ?? 300) * 1000),
        }).catch((e) => e as Error);
        if (res instanceof Error) {
          output = `GET ${path} failed: ${res.message}`;
        } else {
          const text = await res.text().catch(() => "");
          exitCode = res.status;
          output = tail(`GET ${path} → ${res.status} in ${Date.now() - t0}ms\n\n${text}`);
          status = res.status >= 200 && res.status < 400 ? "SUCCESS" : "FAILED";
        }
      }
    } else {
      status = "SKIPPED";
      output = "Job has neither a command nor a path.";
    }
  } catch (e) {
    output = `Error: ${(e as Error).message}`;
  }
  const finished = new Date();
  const durationMs = finished.getTime() - started.getTime();
  await db.cronRun.update({ where: { id: run.id }, data: { status, exitCode, output: tail(output), finishedAt: finished, durationMs } });
  await db.cronJob.update({
    where: { id: job.id },
    data: { lastRunAt: started, lastStatus: status, lastDurationMs: durationMs, nextRunAt: computeNextRun(job, finished) },
  });
  // keep the last 100 runs per job
  const old = await db.cronRun.findMany({ where: { cronJobId: job.id }, orderBy: { startedAt: "desc" }, skip: 100, select: { id: true } });
  if (old.length) await db.cronRun.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
  return { runId: run.id, status, exitCode };
}

/** One-off container: same image/env/volumes as production, `sh -c <command>`, removed afterwards. */
export async function runOneOff(project: Project, dep: Parameters<typeof buildRuntimeEnv>[1] & { imageTag: string | null }, command: string, timeoutSec: number, tag = "manual") {
  await ensureNetwork();
  const env = await buildRuntimeEnv(project, dep);
  const c = await docker().createContainer({
    name: `levant_cron_${dep.shortId}_${Date.now().toString(36)}`,
    Image: dep.imageTag!,
    Cmd: ["sh", "-c", command],
    Env: envToList({ ...env, LEVANT_CRON: tag }),
    Labels: { [LABELS.managed]: "true", [LABELS.project]: project.id, [LABELS.team]: project.teamId, [EXTRA_LABELS.role]: "cron" },
    HostConfig: {
      NetworkMode: dockerNetwork(),
      Mounts: await projectMounts(project.id),
      ...(project.cpuLimit ? { NanoCpus: Math.round(project.cpuLimit * 1e9) } : {}),
      ...(project.memoryLimitMb ? { Memory: project.memoryLimitMb * 1024 * 1024 } : {}),
      LogConfig: { Type: "json-file", Config: { "max-size": "5m", "max-file": "1" } },
      Init: true,
    },
  });
  try {
    await c.start();
    const waited = await Promise.race([
      c.wait() as Promise<{ StatusCode: number }>,
      new Promise<null>((r) => setTimeout(() => r(null), timeoutSec * 1000)),
    ]);
    let exitCode: number;
    let note = "";
    if (waited === null) {
      await c.kill().catch(() => {});
      exitCode = 124;
      note = `\n[levant] killed after ${timeoutSec}s timeout`;
    } else exitCode = waited.StatusCode;
    const buf = (await c.logs({ stdout: true, stderr: true, tail: 2000 })) as unknown as Buffer;
    return { exitCode, output: tail(demuxBuffer(buf) + note) };
  } finally {
    await c.remove({ force: true }).catch(() => {});
  }
}

/** Tick (every minute): run due jobs, initialise nextRunAt of new ones. */
export async function cronTick(now = new Date(), enqueue: (cronJobId: string) => Promise<unknown>) {
  const fresh = await db.cronJob.findMany({ where: { enabled: true, nextRunAt: null } });
  for (const j of fresh) await db.cronJob.update({ where: { id: j.id }, data: { nextRunAt: computeNextRun(j, now) } });
  const due = await db.cronJob.findMany({ where: { enabled: true, nextRunAt: { lte: now } } });
  for (const j of due) {
    // claim: move nextRunAt forward first so two ticks never run the same occurrence
    const claimed = await db.cronJob.updateMany({ where: { id: j.id, nextRunAt: j.nextRunAt }, data: { nextRunAt: computeNextRun(j, now) } });
    if (claimed.count) await enqueue(j.id);
  }
  return { due: due.length };
}

