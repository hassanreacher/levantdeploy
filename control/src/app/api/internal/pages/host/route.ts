import { pageKindForHost, renderHostPage } from "@/lib/proxy/pages";

export const dynamic = "force-dynamic";

/**
 * GET /api/internal/pages/host?host=<host>&state=<unavailable?>
 * Branded fallback page Caddy serves for hosts without a live upstream:
 * 404 "Deployment not found", 503 "Deployment is building/starting" (auto-refresh), 503 "stopped", 502 "failed"…
 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const host = (u.searchParams.get("host") || req.headers.get("x-levant-original-host") || "").slice(0, 253);
  let kind: Awaited<ReturnType<typeof pageKindForHost>> = "not-found";
  try {
    kind = await pageKindForHost(host, u.searchParams.get("state"));
  } catch (e) {
    console.warn("[pages/host]", (e as Error).message);
    kind = "unavailable";
  }
  const { status, html } = renderHostPage(kind, host || "unknown host");
  const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-levant-page": kind };
  if (status === 503) headers["retry-after"] = "5";
  return new Response(html, { status, headers });
}
