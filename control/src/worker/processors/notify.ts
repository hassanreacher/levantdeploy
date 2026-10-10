import { registerProcessor } from "@/lib/queues";
import { dispatchEvent, type NotifyEvent } from "@/lib/dashboard/notify";
import { dispatchPlanEvent, isPlanEvent } from "@/lib/plans/alerts";

/**
 * Dashboard area: `notify` queue. setStatus() enqueues { event: "deployment.ready" | "deployment.error", projectId, deploymentId }.
 * Fans out to email / signed webhook / Telegram / Slack / Discord channels + outgoing Webhook rows,
 * and writes in-app notifications (bell). Channel failures are recorded on the channel (lastError) and
 * do NOT fail the job (retrying would re-send to the channels that already succeeded).
 */
registerProcessor(
  "notify",
  async (job) => {
    const { event, deploymentId, projectId, teamId } = job.data;
    // plans area: quota warnings (80 % / 100 %) and upgrade requests
    if (isPlanEvent(event)) return dispatchPlanEvent(event, { teamId, payload: job.data.payload });
    if (event !== "deployment.ready" && event !== "deployment.error") return { skipped: event };
    const res = await dispatchEvent(event as NotifyEvent, { deploymentId, projectId, teamId });
    if (res.failed) console.warn(`[notify] ${event} ${deploymentId}: ${res.failed} channel(s) failed —`, res.errors.join("; "));
    return res;
  },
  { concurrency: 4 },
);
