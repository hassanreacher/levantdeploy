/**
 * Builder runs service (API side): start / get / cancel / event stream. Worker-safe (no next/* imports) — the HTTP
 * routes in src/app/api/v1/builder/projects/[id]/runs/** are thin wrappers.
 */
import { db } from "@/lib/db";
import { newRedis, redis } from "@/lib/redis";
import { queues } from "@/lib/queues";
import { assertCanUseBuilder, type BuilderCredits } from "@/lib/plans";
import { CANCEL_CHANNEL, RUN_CHANNEL, prismaStore } from "./store";
import type { RunEvent, RunMode } from "./types";

export class RunConflictError extends Error {
  readonly code = "CONFLICT";
  constructor(public runId: string) {
    super("The AI is already working on this app — wait for the current run to finish or stop it.");
  }
  get status() {
    return 409;
  }
  publicError() {
    return { status: 409, body: { code: "CONFLICT", message: this.message, runId: this.runId } };
  }
}

export type Attachment = { url: string; name?: string; type?: string };

export type StartRunInput = {
  builderProjectId: string;
  userId: string | null;
  message: string;
  mode: RunMode;
  attachments?: Attachment[];
  /** default true; false = caller executes the run in-process (dev/e2e scripts) */
  enqueue?: boolean;
};

export const ACTIVE_RUN_STATUSES = ["QUEUED", "RUNNING"] as const;

export async function startRun(input: StartRunInput): Promise<{ run: RunDTO; messageId: string; credits: BuilderCredits }> {
  const project = await db.builderProject.findUnique({ where: { id: input.builderProjectId }, select: { id: true, teamId: true } });
  if (!project) throw new Error("Builder project not found");
  const credits = await assertCanUseBuilder(project.teamId, { userId: input.userId });
  const active = await db.builderRun.findFirst({ where: { builderProjectId: project.id, status: { in: [...ACTIVE_RUN_STATUSES] } }, select: { id: true } });
  if (active) throw new RunConflictError(active.id);

  const { run, message } = await db.$transaction(async (tx) => {
    const run = await tx.builderRun.create({
      data: { builderProjectId: project.id, kind: input.mode, prompt: input.message, createdById: input.userId, status: "QUEUED", steps: [], usage: {} },
    });
    const message = await tx.builderMessage.create({
      data: {
        builderProjectId: project.id,
        role: "USER",
        content: input.message,
        attachments: (input.attachments ?? []).map((a) => ({ kind: "image", url: a.url, name: a.name ?? null, type: a.type ?? "image" })),
        agentRunId: run.id,
        authorId: input.userId,
        meta: { mode: input.mode },
      },
    });
    if (input.mode !== "chat") await tx.builderProject.update({ where: { id: project.id }, data: { status: "GENERATING" } });
    return { run, message };
  });
  const store = prismaStore();
  const ev = await store.appendEvent(run.id, "status", { status: "QUEUED", mode: input.mode });
  await redis().publish(RUN_CHANNEL(run.id), JSON.stringify(ev)).catch(() => {});
  if (input.enqueue !== false) await queues.builder.add({ runId: run.id }, { jobId: `builder-${run.id}` });
  return { run: (await getRunDTO(run.id))!, messageId: message.id, credits: { ...credits, usedToday: credits.usedToday + 1, usedMonth: credits.usedMonth + 1 } };
}

export type RunDTO = {
  id: string;
  builderProjectId: string;
  mode: string;
  status: string;
  phase: string | null;
  prompt: string | null;
  plan: unknown;
  steps: unknown;
  usage: unknown;
  error: string | null;
  baseCommit: string | null;
  resultCommit: string | null;
  cancelRequested: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastSeq: number;
};

export async function getRunDTO(runId: string, builderProjectId?: string): Promise<RunDTO | null> {
  const r = await db.builderRun.findUnique({ where: { id: runId } });
  if (!r || (builderProjectId && r.builderProjectId !== builderProjectId)) return null;
  const last = await db.builderRunEvent.aggregate({ where: { runId }, _max: { seq: true } });
  return {
    id: r.id,
    builderProjectId: r.builderProjectId,
    mode: r.kind,
    status: r.status,
    phase: r.phase,
    prompt: r.prompt,
    plan: r.plan,
    steps: r.steps,
    usage: r.usage,
    error: r.error,
    baseCommit: r.baseCommit,
    resultCommit: r.resultCommit,
    cancelRequested: !!r.cancelRequestedAt,
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    lastSeq: last._max.seq ?? 0,
  };
}

export async function listRuns(builderProjectId: string, limit = 20): Promise<RunDTO[]> {
  const rows = await db.builderRun.findMany({ where: { builderProjectId }, orderBy: { createdAt: "desc" }, take: limit, select: { id: true } });
  return (await Promise.all(rows.map((r) => getRunDTO(r.id)))).filter((x): x is RunDTO => !!x);
}

/** Request cancellation. QUEUED runs are canceled immediately; RUNNING ones stop at the next step (and the in-flight LLM call is aborted). */
export async function cancelRun(runId: string): Promise<RunDTO | null> {
  const r = await db.builderRun.findUnique({ where: { id: runId } });
  if (!r) return null;
  if (!ACTIVE_RUN_STATUSES.includes(r.status as (typeof ACTIVE_RUN_STATUSES)[number])) return getRunDTO(runId);
  await db.builderRun.update({ where: { id: runId }, data: { cancelRequestedAt: new Date() } });
  if (r.status === "QUEUED") {
    const removed = await queues.builder.remove(`builder-${runId}`).catch(() => false);
    const res = await db.builderRun.updateMany({ where: { id: runId, status: "QUEUED" }, data: { status: "CANCELED", finishedAt: new Date(), phase: "done" } });
    if (res.count || removed) {
      await db.builderProject.update({ where: { id: r.builderProjectId }, data: { status: "READY" } }).catch(() => {});
      const ev = await prismaStore().appendEvent(runId, "status", { status: "CANCELED" });
      await redis().publish(RUN_CHANNEL(runId), JSON.stringify(ev)).catch(() => {});
    }
  }
  await redis().publish(CANCEL_CHANNEL, runId).catch(() => {});
  return getRunDTO(runId);
}

const FINAL = new Set(["SUCCEEDED", "FAILED", "CANCELED"]);

/**
 * SSE stream of run events: replays stored events after `after` (Last-Event-ID), then follows Redis pub/sub until the
 * run reaches a final status. Each SSE message: `id: <seq>\nevent: <type>\ndata: <RunEvent JSON>`.
 */
export function runEventStream(runId: string, after: number, signal?: AbortSignal): Response {
  const enc = new TextEncoder();
  let closed = false;
  let sub: ReturnType<typeof newRedis> | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  const cleanup = () => {
    closed = true;
    if (ping) clearInterval(ping);
    if (sub) {
      sub.quit().catch(() => {});
      sub = null;
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let last = after;
      const send = (ev: RunEvent) => {
        if (closed || ev.seq <= last) return false;
        last = ev.seq;
        try {
          controller.enqueue(enc.encode(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
        } catch {
          cleanup();
        }
        return ev.type === "status" && FINAL.has(String(ev.data.status));
      };
      const close = () => {
        if (closed) return;
        cleanup();
        try {
          controller.close();
        } catch {}
      };
      signal?.addEventListener("abort", close, { once: true });
      // subscribe first, buffer, then replay from the DB — no gap between replay and live
      const buffered: RunEvent[] = [];
      let replaying = true;
      sub = newRedis();
      sub.on("message", (_ch, payload) => {
        let ev: RunEvent;
        try {
          ev = JSON.parse(payload) as RunEvent;
        } catch {
          return;
        }
        if (replaying) buffered.push(ev);
        else if (send(ev)) close();
      });
      await sub.subscribe(RUN_CHANNEL(runId)).catch(() => {});
      ping = setInterval(() => {
        if (!closed) {
          try {
            controller.enqueue(enc.encode(": ping\n\n"));
          } catch {
            cleanup();
          }
        }
      }, 15_000);
      const store = prismaStore();
      let done = false;
      for (;;) {
        const page = await store.listEvents(runId, last, 500);
        for (const ev of page) if (send(ev)) done = true;
        if (page.length < 500) break;
      }
      replaying = false;
      for (const ev of buffered.sort((a, b) => a.seq - b.seq)) if (send(ev)) done = true;
      if (!done) {
        const r = await db.builderRun.findUnique({ where: { id: runId }, select: { status: true } });
        // final already and nothing new will come
        if (r && FINAL.has(r.status)) {
          const tail = await store.listEvents(runId, last, 500);
          for (const ev of tail) send(ev);
          done = true;
        }
      }
      if (done) close();
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" },
  });
}
