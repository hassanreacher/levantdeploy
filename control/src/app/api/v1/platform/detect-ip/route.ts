import { route, json, requirePlatformOwner, throttle } from "@/lib/http";
import { getSetting, setSetting } from "@/lib/settings";
import { detectPublicIps } from "@/lib/ops/public-ip";
import { audit } from "@/lib/audit";

/** POST → detect the server's public IPv4/IPv6 and save them (keeps a previously typed value when detection fails). */
export const POST = route(async () => {
  const actor = await requirePlatformOwner();
  await throttle(`detect-ip:${actor.user.id}`, { limit: 10, window: 60 });
  const found = await detectPublicIps();
  const cur = await getSetting("platform.serverIps");
  const next = { ipv4: found.ipv4 ?? cur.ipv4, ipv6: found.ipv6 ?? cur.ipv6, detectedAt: found.ipv4 || found.ipv6 ? new Date().toISOString() : cur.detectedAt };
  await setSetting("platform.serverIps", next);
  await audit({ action: "platform.detect_ip", actor, targetType: "platform", meta: { ipv4: found.ipv4, ipv6: found.ipv6 } });
  return json({ detected: found, serverIps: next });
});
