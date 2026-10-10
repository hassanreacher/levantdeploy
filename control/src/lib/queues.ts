import { Queue, type ConnectionOptions, type Job, type JobsOptions, type WorkerOptions } from "bullmq";

/**
 * BullMQ queues + processor registry.
 *
 * Producers (API routes, lib code):
 *   await queues.build.add({ deploymentId });
 *   await queues.notify.add({ event: "deployment.ready", deploymentId });
 *
 * Consumers (worker): each area adds `src/worker/processors/<area>.ts` which calls
 *   registerProcessor("build", async (job) => { ... }, { concurrency: 2 });
 *   registerSchedule("metrics", "sample", { every: 60_000 });          // repeatable job
 *   onWorkerStart(async () => { await syncRoutes(); });                // run once at worker boot
 * The worker entry (src/worker/index.ts) imports every processors/*.ts file then starts BullMQ workers.
 */

export const QUEUE_NAMES = ["build", "deploy", "domains", "cron", "metrics", "backups", "cleanup", "notify", "git", "ops", "base", "plans", "builder-preview", "builder"] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

/** Job payloads per queue. Extend (additively) when your area needs more fields. */
export type JobData = {
  build: { deploymentId: string };
  /** runtime: action defaults to "deploy" (build finished → start containers). Other actions use explicit job ids. */
  deploy: {
    deploymentId: string;
    action?: "deploy" | "rollback" | "restart" | "stop" | "scale" | "start";
    replicas?: number;
    /** user id for audit / logs */
    byUserId?: string | null;
  };
  /** check one domain, or all due ones (tick) */
  domains: { domainId?: string; all?: boolean; tick?: boolean };
  /** runtime: tick = run due jobs; cronJobId (+manual) = run one now */
  cron: { cronJobId?: string; tick?: boolean; manual?: boolean; runId?: string };
  metrics: { tick?: boolean };
  /** runtime: database add-on lifecycle + backups */
  backups: {
    databaseId?: string;
    backupId?: string;
    tick?: boolean;
    action?: "provision" | "backup" | "restore" | "delete" | "start" | "stop" | "restart" | "reconfigure";
  };
  /** runtime: "drain" stops one superseded deployment after the drain period */
  cleanup: {
    kind?: "deployments" | "images" | "logs" | "uploads" | "workdirs" | "metrics" | "all" | "drain";
    projectId?: string;
    deploymentId?: string;
  };
  /** event: "deployment.ready" | "deployment.error" | "deployment.canceled" | ... */
  notify: { event: string; teamId?: string; projectId?: string; deploymentId?: string; payload?: Record<string, unknown> };
  /** git area: branch polling for generic Git projects, PR preview cleanup, GitHub status sync, upload expiry */
  git: { kind: "poll" | "poll-project" | "pr-closed" | "github-status" | "uploads-expire"; projectId?: string; deploymentId?: string; prNumber?: number; branch?: string };
  /** ops area: control-DB backups ("control-backup") and the update check ("update-check") */
  ops: { kind: "control-backup" | "update-check"; byUserId?: string | null };
  /** plans area: periodic quota check (all teams) or one team */
  plans: { kind: "quota-check"; teamId?: string };
  /** builder-agents: run (or resume) one AI builder run; sweep = re-enqueue interrupted runs */
  builder: { runId?: string; sweep?: boolean };
  /** builder-core: live-preview container lifecycle (start | stop | restart | idle-check tick) — see src/lib/builder/preview.ts */
  "builder-preview": { action: "start" | "stop" | "restart" | "idle-check"; builderId?: string; byUserId?: string | null; reason?: string };
  /** base-runtime area (LevantBase): one stack action per job, or a periodic tick (see src/lib/base/jobs.ts) */
  base: {
    action:
      | "provision" | "pause" | "resume" | "restart" | "upgrade" | "delete" | "backup" | "restore"
      | "studio-start" | "studio-stop" | "settings" | "functions" | "usage-sample" | "auto-pause-inactive" | "studio-idle" | "backup-tick";
    ref?: string;
    service?: string;
    backupId?: string;
    byUserId?: string | null;
    /** free-form action options (versions for upgrade, kind for backup, ...) */
    options?: Record<string, unknown>;
  };
};

export const QUEUE_PREFIX = "ld:bull";

export function bullConnection(): ConnectionOptions {
  const u = new URL(process.env.REDIS_URL || "redis://localhost:6379");
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname && u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    ...(u.protocol === "rediss:" ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}

const DEFAULT_JOB_OPTS: Partial<Record<QueueName, JobsOptions>> = {
  // builds/deploys are not retried automatically: a failure marks the deployment ERROR
  build: { attempts: 1, removeOnComplete: { age: 86400, count: 1000 }, removeOnFail: { age: 7 * 86400 } },
  deploy: { attempts: 1, removeOnComplete: { age: 86400, count: 1000 }, removeOnFail: { age: 7 * 86400 } },
  builder: { attempts: 1, removeOnComplete: { age: 86400, count: 1000 }, removeOnFail: { age: 7 * 86400 } },
  base: { attempts: 1, removeOnComplete: { age: 86400, count: 1000 }, removeOnFail: { age: 7 * 86400 } },
  notify: { attempts: 5, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 1000, removeOnFail: 5000 },
};

class TypedQueue<N extends QueueName> {
  private q: Queue | null = null;
  constructor(public readonly name: N) {}

  get raw(): Queue {
    this.q ??= new Queue(this.name, {
      connection: bullConnection(),
      prefix: QUEUE_PREFIX,
      defaultJobOptions: { removeOnComplete: { age: 86400, count: 500 }, removeOnFail: { age: 3 * 86400 }, ...DEFAULT_JOB_OPTS[this.name] },
    });
    return this.q;
  }

  /** Enqueue a job. For build/deploy the jobId defaults to `${queue}-${deploymentId}` (dedupe + cancel). */
  add(data: JobData[N], opts: JobsOptions & { name?: string } = {}): Promise<Job> {
    const { name, ...rest } = opts;
    const d = data as { deploymentId?: string };
    const jobId = rest.jobId ?? (d.deploymentId && (this.name === "build" || this.name === "deploy") ? `${this.name}-${d.deploymentId}` : undefined);
    return this.raw.add(name ?? this.name, data, { ...rest, ...(jobId ? { jobId } : {}) });
  }

  /** Remove a waiting/delayed job (no-op if active or missing). */
  async remove(jobId: string): Promise<boolean> {
    const job = await this.raw.getJob(jobId);
    if (!job) return false;
    const state = await job.getState();
    if (state === "active") return false;
    await job.remove().catch(() => {});
    return true;
  }

  async close() {
    await this.q?.close();
    this.q = null;
  }
}

const g = globalThis as unknown as { __ldQueues?: { [K in QueueName]: TypedQueue<K> } };

export const queues: { [K in QueueName]: TypedQueue<K> } = (g.__ldQueues ??= {
  build: new TypedQueue("build"),
  deploy: new TypedQueue("deploy"),
  domains: new TypedQueue("domains"),
  cron: new TypedQueue("cron"),
  metrics: new TypedQueue("metrics"),
  backups: new TypedQueue("backups"),
  cleanup: new TypedQueue("cleanup"),
  notify: new TypedQueue("notify"),
  git: new TypedQueue("git"),
  ops: new TypedQueue("ops"),
  base: new TypedQueue("base"),
  plans: new TypedQueue("plans"),
  builder: new TypedQueue("builder"),
  "builder-preview": new TypedQueue("builder-preview"),
});

export async function closeQueues() {
  await Promise.all(QUEUE_NAMES.map((n) => queues[n].close()));
}

// ───────────────────────────── Worker registry ─────────────────────────────

export type Processor<N extends QueueName> = (job: Job<JobData[N]>) => Promise<unknown>;

export type RegisteredProcessor = {
  queue: QueueName;
  fn: (job: Job) => Promise<unknown>;
  /** BullMQ worker options (concurrency, lockDuration, limiter…) */
  options: Partial<Omit<WorkerOptions, "connection" | "prefix">>;
};

export type RegisteredSchedule = {
  queue: QueueName;
  /** stable id of the repeatable job */
  id: string;
  repeat: { every?: number; pattern?: string; tz?: string };
  data: unknown;
};

const reg = globalThis as unknown as {
  __ldProcessors?: Map<QueueName, RegisteredProcessor>;
  __ldSchedules?: RegisteredSchedule[];
  __ldStartHooks?: Array<{ name: string; fn: () => Promise<void> | void }>;
};
const processors = (reg.__ldProcessors ??= new Map());
const schedules = (reg.__ldSchedules ??= []);
const startHooks = (reg.__ldStartHooks ??= []);

/** One processor per queue. Throws if the queue already has one (two areas fighting over a queue is a bug). */
export function registerProcessor<N extends QueueName>(queue: N, fn: Processor<N>, options: RegisteredProcessor["options"] = {}) {
  if (processors.has(queue)) throw new Error(`A processor for queue "${queue}" is already registered`);
  processors.set(queue, { queue, fn: fn as (job: Job) => Promise<unknown>, options });
}

/** Repeatable job (cron pattern or `every` ms) upserted when the worker starts. */
export function registerSchedule<N extends QueueName>(queue: N, id: string, repeat: RegisteredSchedule["repeat"], data: JobData[N] = {} as JobData[N]) {
  schedules.push({ queue, id, repeat, data });
}

/** Run once when the worker boots (after processors are registered), e.g. syncRoutes(). Errors are logged, not fatal. */
export function onWorkerStart(name: string, fn: () => Promise<void> | void) {
  startHooks.push({ name, fn });
}

export const getRegisteredProcessors = () => [...processors.values()];
export const getRegisteredSchedules = () => [...schedules];
export const getStartHooks = () => [...startHooks];
