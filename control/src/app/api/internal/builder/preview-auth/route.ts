import { cleanHost } from "@/lib/proxy/hosts";
import { readCookie } from "@/lib/proxy/protection";
import { builderIdFromHost } from "@/lib/builder/host";
import { PREVIEW_COOKIE, checkPreviewCookie, isPreviewRunning, touchPreview, requestPreview } from "@/lib/builder/preview";
import { previewPage } from "@/lib/builder/pages";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/internal/builder/preview-auth — Caddy forward-auth for preview-{id}.{PLATFORM_DOMAIN} (builder-core).
 * 200 = valid preview cookie (team MEMBER+ via SSO, or a live share link) and the dev server is running → Caddy
 * proxies to lvb-{id}:3000. 401 = sign-in page. 503 = "starting" page (auto refresh; start enqueued).
 * Every allowed request counts as activity (idle stop after BUILDER_PREVIEW_IDLE_MIN).
 */
export async function GET(req: Request) {
  const host = cleanHost(req.headers.get("x-levant-original-host") ?? "");
  const id = builderIdFromHost(host);
  if (!id) return previewPage("not-found");
  const ok = await checkPreviewCookie(readCookie(req.headers.get("cookie"), PREVIEW_COOKIE), id).catch(() => null);
  if (!ok) {
    const exists = await db.builderProject.findUnique({ where: { id }, select: { id: true } });
    return previewPage(exists ? "login" : "not-found");
  }
  if (!(await isPreviewRunning(id))) {
    const p = await db.builderProject.findUnique({ where: { id }, select: { previewStatus: true, previewError: true } });
    if (p?.previewStatus === "ERROR" && ok.kind === "share") return previewPage("error");
    if (p?.previewStatus !== "STARTING") await requestPreview(id, "start", { byUserId: ok.kind === "member" ? ok.userId : null, reason: "visit" }).catch(() => {});
    return previewPage("starting");
  }
  await touchPreview(id);
  return new Response("ok", { status: 200, headers: { "cache-control": "no-store" } });
}
