import { cleanHost } from "@/lib/proxy/hosts";
import { builderIdFromHost } from "@/lib/builder/host";
import { previewPage } from "@/lib/builder/pages";
import { isPreviewRunning, requestPreview } from "@/lib/builder/preview";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** GET /api/internal/builder/preview-page?host=&state= — Caddy error handler for preview hosts (upstream down). */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = builderIdFromHost(cleanHost(url.searchParams.get("host") ?? req.headers.get("x-levant-original-host") ?? ""));
  if (!id) return previewPage("not-found");
  const p = await db.builderProject.findUnique({ where: { id }, select: { previewStatus: true, previewError: true } });
  if (!p) return previewPage("not-found");
  if (p.previewStatus === "ERROR") return previewPage("error");
  if (!(await isPreviewRunning(id)) && p.previewStatus !== "STARTING") await requestPreview(id, "start", { reason: "upstream down" }).catch(() => {});
  return previewPage("starting");
}
