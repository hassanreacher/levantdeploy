import { route, json, requirePlatformOwner, throttle, E } from "@/lib/http";
import { queues } from "@/lib/queues";
import { listControlBackups, lastBackupStatus, backupRunning, controlBackupDir } from "@/lib/ops/backup";
import { getSetting } from "@/lib/settings";
import { audit } from "@/lib/audit";

/** GET → control-DB backups + status. POST → enqueue "Back up now" (worker ops queue). */
export const GET = route(async () => {
  await requirePlatformOwner();
  const [items, last, running, config] = await Promise.all([listControlBackups(), lastBackupStatus(), backupRunning(), getSetting("backups.control")]);
  return json({ items, last, running, config, dir: controlBackupDir() });
});

export const POST = route(async () => {
  const actor = await requirePlatformOwner();
  await throttle(`control-backup:${actor.user.id}`, { limit: 6, window: 600 });
  if (await backupRunning()) throw E.conflict("A backup is already running");
  const job = await queues.ops.add({ kind: "control-backup", byUserId: actor.user.id }, { name: "control-backup-manual" });
  await audit({ action: "platform.backup_request", actor, targetType: "platform" });
  return json({ queued: true, jobId: job.id }, 202);
});
