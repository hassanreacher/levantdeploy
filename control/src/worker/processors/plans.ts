import { registerProcessor, registerSchedule, onWorkerStart } from "@/lib/queues";
import { ensureDefaultPlans, checkAllQuotas, checkQuotas } from "@/lib/plans";

/**
 * Plans area: quota checks every 10 minutes (monthly bandwidth roll-up from MetricSample + 80 % / 100 % alerts
 * through the notify queue) and the default-plan bootstrap at worker start.
 */
registerProcessor(
  "plans",
  async (job) => {
    if (job.data.teamId) return (await checkQuotas(job.data.teamId)).sent;
    return checkAllQuotas();
  },
  { concurrency: 1, lockDuration: 10 * 60_000 },
);

registerSchedule("plans", "quota-check", { every: 10 * 60_000 }, { kind: "quota-check" });

onWorkerStart("plans-bootstrap", async () => {
  const r = await ensureDefaultPlans();
  if (r.created.length) console.log(`[plans] created default plans: ${r.created.join(", ")}`);
});
