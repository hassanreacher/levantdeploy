import { registerProcessor, onWorkerStart } from "@/lib/queues";
import { runControlBackup } from "@/lib/ops/backup";
import { checkForUpdate } from "@/lib/ops/version";
import { applyOpsSchedules } from "@/lib/ops/schedules";
import { audit } from "@/lib/audit";

// ops area: control-DB backups (scheduled / "Back up now") and the periodic update check.
registerProcessor(
  "ops",
  async (job) => {
    const { kind, byUserId } = job.data;
    if (kind === "control-backup") {
      const res = await runControlBackup();
      await audit({ action: res.ok ? "platform.backup" : "platform.backup_failed", userId: byUserId ?? null, targetType: "backup", targetId: res.file, meta: { size: res.size, error: res.error, ms: res.ms } });
      if (!res.ok) throw new Error(`control backup failed: ${res.error}`);
      return res;
    }
    if (kind === "update-check") return checkForUpdate({ force: true });
    return null;
  },
  { concurrency: 1, lockDuration: 60 * 60_000 },
);

onWorkerStart("ops-schedules", applyOpsSchedules);
