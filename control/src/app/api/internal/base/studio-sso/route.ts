import { cleanHost } from "@/lib/proxy/hosts";
import { parseBaseHost } from "@/lib/base/config";
import { basePageResponse } from "@/lib/base/pages";
import { STUDIO_COOKIE, STUDIO_COOKIE_TTL_SEC, redeemStudioToken, signStudioCookie } from "@/lib/base/studio";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/**
 * GET studio-{ref}.{BASE_DOMAIN}/__levant/sso?t=<one-time token>  (Caddy rewrites to this route; base-runtime area)
 * Redeems the token issued by issueStudioToken(ref, userId) (60 s, single use), sets the host-only signed cookie
 * (HttpOnly, SameSite=Lax, Secure over https, 12 h) and redirects to Studio.
 */
export async function GET(req: Request) {
  const host = cleanHost(req.headers.get("x-levant-original-host") ?? "");
  const h = parseBaseHost(host);
  if (!h || h.kind !== "studio") return basePageResponse("not-found", host);
  const token = new URL(req.url).searchParams.get("t") ?? "";
  const r = await redeemStudioToken(token, h.ref).catch(() => null);
  if (!r) return basePageResponse("studio-denied", host);
  const secure = (req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "")) === "https";
  const cookie = [
    `${STUDIO_COOKIE}=${encodeURIComponent(signStudioCookie(h.ref, r.userId))}`,
    "Path=/",
    `Max-Age=${STUDIO_COOKIE_TTL_SEC}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
  const p = await db.baseProject.findUnique({ where: { ref: h.ref }, select: { id: true, teamId: true } });
  if (p) await audit({ action: "base.studio_open", teamId: p.teamId, userId: r.userId, targetType: "base_project", targetId: p.id, meta: { ref: h.ref } });
  return new Response(null, { status: 303, headers: { location: "/project/default", "set-cookie": cookie, "cache-control": "no-store" } });
}
