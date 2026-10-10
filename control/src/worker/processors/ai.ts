/**
 * AI area worker hook: optional auto-diagnosis of failed deployments (Settings → AI → "Diagnose failed deployments").
 * Listens on the deployment STATUS_CHANNEL (no queue of its own), dedupes per deployment across worker processes,
 * and stores the result on deployment.meta.aiDiagnosis (shown as a banner on the deployment page).
 */
import { onWorkerStart } from "@/lib/queues";
import { newRedis, redis } from "@/lib/redis";
import { STATUS_CHANNEL, type StatusEvent } from "@/lib/deployments";
import { getSetting } from "@/lib/settings";
import { diagnoseAndStore } from "@/lib/ai/auto-diagnose";

onWorkerStart("ai-auto-diagnose", async () => {
  const sub = newRedis();
  await sub.subscribe(STATUS_CHANNEL);
  sub.on("message", async (_ch, raw) => {
    let ev: StatusEvent;
    try {
      ev = JSON.parse(raw) as StatusEvent;
    } catch {
      return;
    }
    if (ev.status !== "ERROR") return;
    try {
      if (!(await getSetting("ai.autoDiagnose"))) return;
      const first = await redis().set(`ld:ai:diag:${ev.deploymentId}`, "1", "EX", 86_400, "NX");
      if (first !== "OK") return;
      // let the build/deploy worker flush its last log lines first
      await new Promise((r) => setTimeout(r, 3000));
      const res = await diagnoseAndStore(ev.deploymentId);
      console.log(new Date().toISOString(), "[ai] auto-diagnosis stored for", ev.deploymentId, res?.source);
    } catch (e) {
      console.warn("[ai] auto-diagnosis error:", (e as Error).message);
    }
  });
});
