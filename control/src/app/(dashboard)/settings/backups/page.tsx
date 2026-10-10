import { getSetting } from "@/lib/settings";
import { listControlBackups, lastBackupStatus, backupRunning, controlBackupDir } from "@/lib/ops/backup";
import { BackupsSettings } from "./backups-client";

export const metadata = { title: "Backups · Platform Settings" };

export default async function PlatformBackupsPage() {
  const [items, last, running, config] = await Promise.all([listControlBackups(), lastBackupStatus(), backupRunning(), getSetting("backups.control")]);
  return (
    <BackupsSettings
      items={items}
      last={last}
      running={running}
      config={config}
      dir={controlBackupDir()}
      installDir={process.env.LEVANT_INSTALL_DIR || "/opt/levantdeploy"}
    />
  );
}
