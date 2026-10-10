import { route, json, requirePlatformOwner, throttle } from "@/lib/http";
import { checkForUpdate } from "@/lib/ops/version";

/** GET → { update } (cached 6 h); `?refresh=1` checks the version source now. */
export const GET = route(async (req) => {
  const actor = await requirePlatformOwner();
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  if (refresh) await throttle(`update-check:${actor.user.id}`, { limit: 10, window: 60 });
  return json({ update: await checkForUpdate({ force: refresh }) });
});
