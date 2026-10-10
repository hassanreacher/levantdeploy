import { db } from "@/lib/db";
import { maskedConfig } from "./notify";

/** Notification channels for the settings UI (configs masked, dates as ISO). projectId → that project's + team-wide channels. */
export async function listChannels(teamId: string, projectId?: string) {
  const rows = await db.notification.findMany({
    where: { teamId, ...(projectId ? { OR: [{ projectId }, { projectId: null }] } : {}) },
    orderBy: [{ projectId: "asc" }, { createdAt: "asc" }],
    include: { project: { select: { id: true, name: true, slug: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    name: r.name,
    events: r.events,
    enabled: r.enabled,
    projectId: r.projectId,
    project: r.project,
    lastSentAt: r.lastSentAt?.toISOString() ?? null,
    lastError: r.lastError,
    config: maskedConfig(r.type, r.configEnc),
  }));
}
