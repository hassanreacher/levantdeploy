import type { BaseProject, BaseStatus, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";

/** Pub/sub channel for live dashboard updates: JSON {ref, status?, event?} */
export const BASE_STATUS_CHANNEL = "lb:base:status";

export type BaseEventLevel = "info" | "success" | "warning" | "error";

export async function baseEvent(
  p: Pick<BaseProject, "id" | "ref">,
  type: string,
  message: string,
  opts: { level?: BaseEventLevel; meta?: Record<string, unknown>; actorId?: string | null } = {},
) {
  const row = await db.baseEvent
    .create({
      data: {
        baseProjectId: p.id,
        type,
        level: opts.level ?? "info",
        message: message.slice(0, 20_000),
        meta: (opts.meta ?? undefined) as Prisma.InputJsonValue | undefined,
        actorId: opts.actorId ?? null,
      },
    })
    .catch(() => null);
  void redis()
    .publish(BASE_STATUS_CHANNEL, JSON.stringify({ ref: p.ref, event: { type, level: opts.level ?? "info", message: message.slice(0, 500) } }))
    .catch(() => {});
  return row;
}

/** Allowed status transitions (anything → ERROR / DELETING is always allowed). */
export const BASE_TRANSITIONS: Record<BaseStatus, BaseStatus[]> = {
  PROVISIONING: ["ACTIVE"],
  ACTIVE: ["PAUSING", "UPGRADING", "RESTORING", "PROVISIONING"],
  PAUSING: ["PAUSED", "ACTIVE"],
  PAUSED: ["PROVISIONING", "RESTORING", "ACTIVE"],
  RESTORING: ["ACTIVE"],
  UPGRADING: ["ACTIVE"],
  ERROR: ["PROVISIONING", "ACTIVE", "PAUSING", "PAUSED", "RESTORING", "UPGRADING"],
  DELETING: [],
};

export const canTransition = (from: BaseStatus, to: BaseStatus) => from === to || to === "ERROR" || to === "DELETING" || BASE_TRANSITIONS[from].includes(to);

export async function setBaseStatus(ref: string, to: BaseStatus, opts: { message?: string | null; extra?: Prisma.BaseProjectUpdateInput } = {}) {
  const cur = await db.baseProject.findUnique({ where: { ref } });
  if (!cur) throw new Error(`base project ${ref} not found`);
  if (!canTransition(cur.status, to)) throw new Error(`cannot go from ${cur.status} to ${to}`);
  const row = await db.baseProject.update({
    where: { ref },
    data: { status: to, statusMessage: opts.message === undefined ? (to === "ERROR" ? cur.statusMessage : null) : opts.message, ...(opts.extra ?? {}) },
  });
  void redis()
    .publish(BASE_STATUS_CHANNEL, JSON.stringify({ ref, status: to }))
    .catch(() => {});
  return row;
}
