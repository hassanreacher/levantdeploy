import { cleanHost } from "@/lib/proxy/hosts";
import { basePageResponse, pageKindForBaseHost } from "@/lib/base/pages";

export const dynamic = "force-dynamic";

/**
 * GET /api/internal/base/page?host=&state=   (Caddy, base-runtime area)
 * Branded page for {ref}.{BASE_DOMAIN} / studio-{ref}.{BASE_DOMAIN} when the project isn't serving traffic:
 * paused → 503 "Project paused — restore it from the dashboard", provisioning/unavailable → 503 (auto refresh),
 * error → 502, unknown → 404.
 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const host = cleanHost(u.searchParams.get("host") ?? req.headers.get("x-levant-original-host") ?? "");
  const kind = await pageKindForBaseHost(host, u.searchParams.get("state")).catch(() => "unavailable" as const);
  return basePageResponse(kind, host);
}
