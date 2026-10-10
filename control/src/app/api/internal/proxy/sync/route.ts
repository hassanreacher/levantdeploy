import { route, json, requirePlatformOwner } from "@/lib/http";
import { syncRoutes, lastSync, caddyReachable } from "@/lib/proxy/sync";

export const dynamic = "force-dynamic";

/** GET: proxy status (last sync, Caddy reachable). POST: force a route sync. Platform owner only. */
export const GET = route(async () => {
  await requirePlatformOwner();
  return json({ last: await lastSync(), caddy: await caddyReachable() });
});

export const POST = route(async () => {
  await requirePlatformOwner();
  return json(await syncRoutes({ immediate: true }));
});
