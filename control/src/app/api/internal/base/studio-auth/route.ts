import { cleanHost } from "@/lib/proxy/hosts";
import { readCookie } from "@/lib/proxy/protection";
import { parseBaseHost } from "@/lib/base/config";
import { basePageResponse } from "@/lib/base/pages";
import { STUDIO_COOKIE, checkStudioCookie, ensureStudioRunning, studioRunning } from "@/lib/base/studio";

export const dynamic = "force-dynamic";

/**
 * GET /api/internal/base/studio-auth — Caddy forward-auth for studio-{ref}.{BASE_DOMAIN} (base-runtime area).
 * 200 = valid SSO cookie for this ref and the user is still MEMBER+ of the team → Caddy continues to Studio.
 * 401 = branded "Open Studio from the dashboard" page. 503 = Studio is (re)starting (auto refresh, start enqueued).
 */
export async function GET(req: Request) {
  const host = cleanHost(req.headers.get("x-levant-original-host") ?? "");
  const h = parseBaseHost(host);
  if (!h || h.kind !== "studio") return basePageResponse("not-found", host);
  const ok = await checkStudioCookie(readCookie(req.headers.get("cookie"), STUDIO_COOKIE), h.ref).catch(() => null);
  if (!ok) return basePageResponse("studio-login", host);
  if (!(await studioRunning(h.ref))) {
    await ensureStudioRunning(h.ref, ok.userId).catch(() => {});
    return basePageResponse("studio-starting", host);
  }
  return new Response("ok", { status: 200, headers: { "cache-control": "no-store" } });
}
