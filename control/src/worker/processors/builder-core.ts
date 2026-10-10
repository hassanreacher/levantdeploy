/**
 * builder-core: live-preview lifecycle (queue "builder-preview").
 *   start | stop | restart   one project (jobs enqueued by requestPreview(); job id bp-<action>-<id> dedupes)
 *   idle-check               every minute: stop previews idle > BUILDER_PREVIEW_IDLE_MIN (default 20) + orphan cleanup
 * On worker start: re-attach log followers of running previews and reconcile DB status with Docker.
 */
import { registerProcessor, registerSchedule, onWorkerStart } from "@/lib/queues";
import { db } from "@/lib/db";
import { followPreviewLogs, isPreviewRunning, restartPreviewNow, startPreviewNow, stopIdlePreviews, stopPreviewNow } from "@/lib/builder/preview";

registerProcessor(
  "builder-preview",
  async (job) => {
    const { action, builderId } = job.data;
    if (action === "idle-check") return { stopped: await stopIdlePreviews() };
    if (!builderId) return { skipped: "no builderId" };
    const exists = await db.builderProject.findUnique({ where: { id: builderId }, select: { id: true } });
    if (!exists) return { skipped: "project deleted" };
    switch (action) {
      case "start": {
        const st = await startPreviewNow(builderId);
        return { status: st.status };
      }
      case "restart": {
        const st = await restartPreviewNow(builderId);
        return { status: st.status };
      }
      case "stop":
        await stopPreviewNow(builderId, job.data.reason ? `stopped (${job.data.reason})` : "stopped");
        return { status: "STOPPED" };
    }
  },
  { concurrency: Number(process.env.WORKER_CONCURRENCY_BUILDER_PREVIEW || 4), lockDuration: 10 * 60_000 },
);

registerSchedule("builder-preview", "idle-check-every-minute", { every: 60_000 }, { action: "idle-check" });

onWorkerStart("builder-preview-reconcile", async () => {
  const rows = await db.builderProject.findMany({ where: { previewStatus: { in: ["RUNNING", "STARTING"] } }, select: { id: true, previewStatus: true } });
  for (const r of rows) {
    if (await isPreviewRunning(r.id)) {
      if (r.previewStatus === "STARTING") await db.builderProject.update({ where: { id: r.id }, data: { previewStatus: "RUNNING" } }).catch(() => {});
      void followPreviewLogs(r.id);
    } else {
      await db.builderProject.update({ where: { id: r.id }, data: { previewStatus: "STOPPED" } }).catch(() => {});
    }
  }
});
