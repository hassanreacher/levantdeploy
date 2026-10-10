import { cleanHost } from "@/lib/proxy/hosts";
import { renderPasswordPage } from "@/lib/proxy/pages";
import { AUTH_COOKIE, protectionForHost, readCookie, verifyAuthCookie } from "@/lib/proxy/protection";

export const dynamic = "force-dynamic";

/**
 * GET /api/internal/protection/check — Caddy forward-auth for password-protected deployments.
 * 200 = valid signed cookie (request continues to the app); otherwise 401 + the password page (returned to the visitor).
 */
export async function GET(req: Request) {
  const host = cleanHost(req.headers.get("x-levant-original-host") ?? "");
  const uri = req.headers.get("x-forwarded-uri") ?? "/";
  const p = host ? await protectionForHost(host).catch(() => null) : null;
  if (!p || p.protection.mode !== "password" || !p.protection.passwordHash) return new Response("ok", { status: 200 });
  if (verifyAuthCookie(readCookie(req.headers.get("cookie"), AUTH_COOKIE), p.projectId, p.protection.passwordHash)) return new Response("ok", { status: 200 });
  const { html } = renderPasswordPage(host, uri);
  return new Response(html, { status: 401, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}
