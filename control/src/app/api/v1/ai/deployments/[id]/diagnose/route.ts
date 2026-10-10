import { route, json, requireApiTokenOrSession, requireProjectRole, throttle, E } from "@/lib/http";
import { LIMITS } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import { diagnoseAndStore, readDiagnosis } from "@/lib/ai/auto-diagnose";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function load(id: string) {
  const actor = await requireApiTokenOrSession({ scope: "logs:read" });
  const d = await db.deployment.findFirst({ where: { OR: [{ id }, { shortId: id }] }, select: { id: true, projectId: true, meta: true, status: true } });
  if (!d) throw E.notFound("Deployment not found");
  await requireProjectRole(d.projectId, "VIEWER", { actor, scope: "logs:read" });
  return { actor, d };
}

/** GET /api/v1/ai/deployments/:id/diagnose → { diagnosis | null } (stored by auto-diagnosis) */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const { d } = await load((await params).id);
  return json({ diagnosis: readDiagnosis(d.meta) });
});

/** POST → run the one-shot diagnosis now and store it on the deployment. */
export const POST = route<{ id: string }>(async (_req, { params }) => {
  const { actor, d } = await load((await params).id);
  await throttle(`ai:msg:${actor.user.id}`, LIMITS.ai);
  return json({ diagnosis: await diagnoseAndStore(d.id) });
});
