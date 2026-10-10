import { cleanHost } from "@/lib/proxy/hosts";
import { builderIdFromHost } from "@/lib/builder/host";
import { PREVIEW_COOKIE, PREVIEW_COOKIE_TTL_SEC, redeemPreviewToken, redeemShareToken, signPreviewCookie, touchPreview } from "@/lib/builder/preview";
import { previewPage } from "@/lib/builder/pages";

export const dynamic = "force-dynamic";

/**
 * preview-{id}.{PLATFORM_DOMAIN}/__levant/sso?t=<token>&next=/path    (Caddy rewrites to ?path=/__levant/sso&t=…)
 * preview-{id}.{PLATFORM_DOMAIN}/__levant/share?t=<share token>
 * Redeems the token, sets the host-only preview cookie (HttpOnly; over https: SameSite=None; Secure; Partitioned so it
 * also works inside the editor iframe; over http: SameSite=Lax) and redirects to `next`.
 */
export async function GET(req: Request) {
  const host = cleanHost(req.headers.get("x-levant-original-host") ?? "");
  const id = builderIdFromHost(host);
  if (!id) return previewPage("not-found");
  const url = new URL(req.url);
  const token = url.searchParams.get("t") ?? "";
  const kind = url.searchParams.get("path") === "/__levant/share" ? "share" : "sso";
  let value: string | null = null;
  if (kind === "sso") {
    const r = await redeemPreviewToken(token, id).catch(() => null);
    if (!r) return previewPage("denied");
    value = signPreviewCookie(id, "u", r.userId);
  } else {
    const r = await redeemShareToken(token, id).catch(() => null);
    if (!r) return previewPage("expired");
    value = signPreviewCookie(id, "s", r.shareHash.slice(0, 16));
  }
  const secure = (req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "")) === "https";
  const cookie = [
    `${PREVIEW_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${PREVIEW_COOKIE_TTL_SEC}`,
    "HttpOnly",
    ...(secure ? ["SameSite=None", "Secure", "Partitioned"] : ["SameSite=Lax"]),
  ].join("; ");
  const next = url.searchParams.get("next") ?? "/";
  const location = next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/__levant") ? next : "/";
  await touchPreview(id, { ensureRunning: true });
  return new Response(null, { status: 303, headers: { location, "set-cookie": cookie, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}
