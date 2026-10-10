import { route, json, requireTeamRole, throttle, E } from "@/lib/http";
import { db } from "@/lib/db";
import { buildPayload, sendToChannel, testPayload } from "@/lib/dashboard/notify";

/**
 * POST /api/v1/teams/:team/notifications/:id/test (ADMIN) — sends a test message synchronously.
 * Uses the latest deployment of the team (if any) so the message looks real; → { ok, error? }
 */
export const POST = route<{ team: string; id: string }>(async (_req, { params }) => {
  const { team, id } = await params;
  const { team: t, actor } = await requireTeamRole(team, "ADMIN");
  await throttle(`notify-test:${actor.user.id}`, { limit: 10, window: 60 });
  const ch = await db.notification.findFirst({ where: { id, teamId: t.id } });
  if (!ch) throw E.notFound("Channel not found");
  const last = await db.deployment.findFirst({
    where: { project: { teamId: t.id, ...(ch.projectId ? { id: ch.projectId } : {}) }, status: { in: ["READY", "ERROR"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true },
  });
  const p = (last && (await buildPayload(last.status === "READY" ? "deployment.ready" : "deployment.error", { deploymentId: last.id }))) || testPayload({ id: t.id, slug: t.slug, name: t.name });
  const error = await sendToChannel(ch, p);
  return json({ ok: !error, error: error ?? undefined, event: p.event });
});
