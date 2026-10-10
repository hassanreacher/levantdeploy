import { route, json, requireProjectRole } from "@/lib/http";
import { findDeployment } from "@/lib/runtime/api";
import { containerRefs, inspectSafe } from "@/lib/runtime/containers";

export const dynamic = "force-dynamic";

/** GET /api/v1/deployments/:id/runtime → live docker state of the deployment's containers. */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  const d = await findDeployment(id);
  await requireProjectRole(d.projectId, "VIEWER", { scope: "deployments:read" });
  const containers = await Promise.all(
    containerRefs(d).map(async (r) => {
      const info = await inspectSafe(r.id);
      return {
        id: r.id.slice(0, 12),
        name: r.name,
        replica: r.replica,
        service: r.service ?? null,
        public: r.public ?? null,
        state: info?.State.Status ?? "removed",
        running: !!info?.State.Running,
        health: info?.State.Health?.Status ?? null,
        restartCount: info?.RestartCount ?? 0,
        startedAt: info?.State.StartedAt ?? null,
        exitCode: info?.State.ExitCode ?? null,
        image: d.imageTag,
      };
    }),
  );
  const live = (d.status === "READY" || d.status === "SUPERSEDED") && !d.stoppedAt && containers.some((c) => c.running);
  return json({ containers, stoppedAt: d.stoppedAt?.toISOString() ?? null, live, isCurrentProduction: d.isCurrentProduction });
});
