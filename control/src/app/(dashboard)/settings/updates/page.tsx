import { checkForUpdate, currentVersion } from "@/lib/ops/version";
import { getSetting } from "@/lib/settings";
import { UpdatesSettings } from "./updates-client";

export const metadata = { title: "Updates · Platform Settings" };

export default async function PlatformUpdatesPage() {
  const [update, url] = await Promise.all([checkForUpdate().catch(() => null), getSetting("updates.checkUrl")]);
  return (
    <UpdatesSettings
      version={currentVersion()}
      update={update}
      checkUrl={url}
      envUrl={process.env.LEVANT_UPDATE_URL || null}
      installDir={process.env.LEVANT_INSTALL_DIR || "/opt/levantdeploy"}
    />
  );
}
