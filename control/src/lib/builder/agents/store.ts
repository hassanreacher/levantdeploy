/**
 * Prisma-backed RunStorePort (BuilderRun / BuilderRunEvent / BuilderMessage / BuilderProject from builder-core) and the
 * Redis event bus. Worker-safe.
 */
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import type { EventBusPort, RunPatch, RunStorePort } from "./adapters";
import { planSchema, type ProjectContext, type RunEvent, type RunEventType, type RunMode, type RunRecord, type RunState, type RunStatus, type StepItem } from "./types";

export const RUN_CHANNEL = (runId: string) => `ld:builder:run:${runId}`;
export const CANCEL_CHANNEL = "ld:builder:cancel";
export const LEASE_KEY = (runId: string) => `ld:builder:lease:${runId}`;

/** true when some executor currently holds the run's lease */
export async function leaseAlive(runId: string): Promise<boolean> {
  return (await redis().exists(LEASE_KEY(runId))) === 1;
}

export function modeOf(kind: string | null | undefined): RunMode {
  return kind === "chat" ? "chat" : kind === "fix" ? "fix" : "build";
}

type RunRow = Prisma.BuilderRunGetPayload<{ include: { builderProject: { select: { teamId: true } }; messages: true } }>;

export function toRecord(r: RunRow): RunRecord {
  const userMsg = r.messages.find((m) => m.role === "USER");
  const atts = Array.isArray(userMsg?.attachments) ? (userMsg!.attachments as { kind?: string; url?: string; name?: string; type?: string }[]) : [];
  const plan = r.plan ? planSchema.safeParse(r.plan) : null;
  return {
    id: r.id,
    builderProjectId: r.builderProjectId,
    teamId: r.builderProject.teamId,
    createdById: r.createdById,
    mode: modeOf(r.kind),
    status: r.status as RunStatus,
    phase: r.phase,
    message: r.prompt ?? userMsg?.content ?? "",
    attachments: atts.filter((a) => typeof a.url === "string" && (a.kind === "image" || a.type?.startsWith("image"))).map((a) => ({ url: a.url!, name: a.name, type: a.type ?? "image" })),
    plan: plan?.success ? plan.data : null,
    state: (r.state as RunState | null) ?? null,
    steps: Array.isArray(r.steps) ? (r.steps as unknown as StepItem[]) : [],
    error: r.error,
    summary: null,
    startCommit: r.baseCommit,
    endCommit: r.resultCommit,
    cancelRequested: !!r.cancelRequestedAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    createdAt: r.createdAt,
  };
}

function usageJson(state: RunState | null | undefined): Prisma.InputJsonValue | undefined {
  if (!state) return undefined;
  const byProvider = Object.fromEntries(
    Object.entries(state.usage.providers).map(([k, v]) => [k, { calls: v.calls, inTokens: v.inTok, outTokens: v.outTok, failures: v.failures }]),
  );
  const total = Object.values(state.usage.providers).reduce((a, v) => ({ calls: a.calls + v.calls, inTokens: a.inTokens + v.inTok, outTokens: a.outTokens + v.outTok }), { calls: 0, inTokens: 0, outTokens: 0 });
  return { byProvider, total: { ...total, steps: state.usage.steps, tokens: state.usage.tokens } };
}

function toData(patch: RunPatch): Prisma.BuilderRunUpdateManyMutationInput {
  const d: Prisma.BuilderRunUpdateManyMutationInput = {};
  if (patch.status !== undefined) d.status = patch.status;
  if (patch.phase !== undefined) d.phase = patch.phase;
  if (patch.plan !== undefined) d.plan = patch.plan === null ? (null as unknown as Prisma.InputJsonValue) : (patch.plan as unknown as Prisma.InputJsonValue);
  if (patch.state !== undefined) {
    d.state = patch.state as unknown as Prisma.InputJsonValue;
    const u = usageJson(patch.state);
    if (u) d.usage = u;
  }
  if (patch.steps !== undefined) d.steps = patch.steps as unknown as Prisma.InputJsonValue;
  if (patch.error !== undefined) d.error = patch.error;
  if (patch.startCommit !== undefined) d.baseCommit = patch.startCommit;
  if (patch.endCommit !== undefined) d.resultCommit = patch.endCommit;
  if (patch.startedAt !== undefined) d.startedAt = patch.startedAt;
  if (patch.finishedAt !== undefined) d.finishedAt = patch.finishedAt;
  return d;
}

export function prismaStore(): RunStorePort {
  // seq allocation is per run and serialised in-process (one worker owns a run at a time)
  const seqs = new Map<string, Promise<number>>();
  const nextSeq = (runId: string): Promise<number> => {
    const prev = seqs.get(runId) ?? db.builderRunEvent.aggregate({ where: { runId }, _max: { seq: true } }).then((a) => a._max.seq ?? 0);
    const next = prev.then((n) => n + 1);
    seqs.set(runId, next.catch(() => 0));
    return next;
  };
  return {
    async getRun(id) {
      const r = await db.builderRun.findUnique({ where: { id }, include: { builderProject: { select: { teamId: true } }, messages: true } });
      return r ? toRecord(r) : null;
    },
    async updateRun(id, patch) {
      await db.builderRun.updateMany({ where: { id }, data: toData(patch) });
    },
    async transition(id, from, to, patch) {
      const r = await db.builderRun.updateMany({ where: { id, status: { in: from } }, data: { ...toData(patch ?? {}), status: to } });
      return r.count === 1;
    },
    async appendEvent(runId, type, data) {
      for (let i = 0; ; i++) {
        const seq = await nextSeq(runId);
        try {
          const row = await db.builderRunEvent.create({ data: { runId, seq, type, data: data as Prisma.InputJsonValue } });
          return { seq: row.seq, type: row.type as RunEventType, data, at: row.createdAt.toISOString() };
        } catch (e) {
          if ((e as { code?: string }).code !== "P2002" || i > 3) throw e;
          seqs.delete(runId); // another writer (resumed worker) — re-read max(seq)
        }
      }
    },
    async listEvents(runId, after = 0, limit = 1000) {
      const rows = await db.builderRunEvent.findMany({ where: { runId, seq: { gt: after } }, orderBy: { seq: "asc" }, take: limit });
      return rows.map((r) => ({ seq: r.seq, type: r.type as RunEventType, data: r.data as Record<string, unknown>, at: r.createdAt.toISOString() }));
    },
    async acquireLease(id, owner, ttl) {
      return (await redis().set(LEASE_KEY(id), owner, "PX", ttl, "NX")) === "OK";
    },
    async renewLease(id, owner, ttl) {
      const r = await redis().eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
        1,
        LEASE_KEY(id),
        owner,
        String(ttl),
      );
      return Number(r) === 1;
    },
    async releaseLease(id, owner) {
      await redis().eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, LEASE_KEY(id), owner);
    },
    async isCancelRequested(id) {
      const r = await db.builderRun.findUnique({ where: { id }, select: { cancelRequestedAt: true } });
      return !!r?.cancelRequestedAt;
    },
    async projectContext(pid, runId): Promise<ProjectContext> {
      const p = await db.builderProject.findUnique({ where: { id: pid } });
      if (!p) throw new Error(`BuilderProject ${pid} not found`);
      const run = runId ? await db.builderRun.findUnique({ where: { id: runId }, select: { createdAt: true } }) : null;
      const msgs = await db.builderMessage.findMany({
        where: { builderProjectId: pid, role: { in: ["USER", "ASSISTANT"] }, ...(run ? { createdAt: { lt: run.createdAt } } : {}), ...(runId ? { NOT: { agentRunId: runId } } : {}) },
        orderBy: { createdAt: "desc" },
        take: 8,
      });
      const s = (p.settings ?? {}) as { knowledge?: string; instructions?: string };
      return {
        id: p.id,
        teamId: p.teamId,
        name: p.name,
        knowledge: [s.knowledge, s.instructions].filter(Boolean).join("\n\n"),
        baseRef: p.baseRef,
        history: msgs.reverse().map((m) => ({ role: m.role === "USER" ? ("user" as const) : ("assistant" as const), content: m.content })),
      };
    },
    async writeAssistantMessage(run, content, commitSha) {
      await db.builderMessage.create({
        data: { builderProjectId: run.builderProjectId, role: "ASSISTANT", content, commitSha, agentRunId: run.id, meta: { mode: run.mode } },
      });
    },
    async updateProject(pid, patch) {
      const data: Prisma.BuilderProjectUpdateInput = {};
      if (patch.lastCommit !== undefined) data.lastCommit = patch.lastCommit;
      if (patch.baseRef !== undefined) data.baseRef = patch.baseRef;
      if (patch.status !== undefined) data.status = patch.status;
      await db.builderProject.update({ where: { id: pid }, data });
    },
  };
}

export function redisBus(): EventBusPort {
  return {
    async publish(runId, ev: RunEvent) {
      await redis().publish(RUN_CHANNEL(runId), JSON.stringify(ev));
    },
  };
}
