import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * Audit log writer. Never throws (audit must not break the action).
 *
 *   await audit({ action: "project.create", teamId, actor, targetType: "project", targetId: p.id, meta: { name } });
 *
 * `actor` is the object returned by requireApiTokenOrSession()/requireTeamRole().actor — or pass userId directly.
 * Action naming: "<resource>.<verb>" (project.create, deployment.cancel, env.update, member.role_change, token.create…).
 */
export type AuditInput = {
  action: string;
  teamId?: string | null;
  userId?: string | null;
  actor?: { user: { id: string }; token: { id: string } | null } | null;
  targetType?: string | null;
  targetId?: string | null;
  meta?: Prisma.InputJsonValue;
  ip?: string | null;
  userAgent?: string | null;
};

export async function audit(input: AuditInput): Promise<void> {
  try {
    let ip = input.ip ?? null;
    let userAgent = input.userAgent ?? null;
    if (ip === null && userAgent === null) {
      // Inside a request? pick up ip/ua (no-op in the worker)
      try {
        const { headers } = await import("next/headers");
        const h = await headers();
        ip = h.get("cf-connecting-ip") || h.get("x-real-ip") || h.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
        userAgent = h.get("user-agent")?.slice(0, 300) ?? null;
      } catch {}
    }
    await db.auditLog.create({
      data: {
        action: input.action,
        teamId: input.teamId ?? null,
        userId: input.userId ?? input.actor?.user.id ?? null,
        apiTokenId: input.actor?.token?.id ?? null,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        meta: input.meta ?? {},
        ip,
        userAgent,
      },
    });
  } catch (e) {
    console.warn("[audit] failed", input.action, (e as Error).message);
  }
}
