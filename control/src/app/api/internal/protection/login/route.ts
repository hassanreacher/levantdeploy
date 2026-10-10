import bcrypt from "bcryptjs";
import { cleanHost } from "@/lib/proxy/hosts";
import { renderPasswordPage } from "@/lib/proxy/pages";
import { AUTH_COOKIE, AUTH_TTL_SEC, protectionForHost, safeNext, signAuthCookie } from "@/lib/proxy/protection";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** GET /__levant/auth (via Caddy) → back to the site. */
export async function GET(req: Request) {
  return new Response(null, { status: 303, headers: { location: safeNext(new URL(req.url).searchParams.get("next")) } });
}

/** POST /__levant/auth (form: password, next) on a protected host → sets the signed cookie and redirects. */
export async function POST(req: Request) {
  const host = cleanHost(req.headers.get("x-levant-original-host") ?? "");
  const form = await req.formData().catch(() => null);
  const password = String(form?.get("password") ?? "");
  const next = safeNext(String(form?.get("next") ?? new URL(req.url).searchParams.get("next") ?? "/"));
  const p = host ? await protectionForHost(host).catch(() => null) : null;
  if (!p || p.protection.mode !== "password" || !p.protection.passwordHash) return new Response(null, { status: 303, headers: { location: next } });
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0]!.trim() || "0";
  const rl = await rateLimit(`protect:${host}:${ip}`, 10, 300).catch(() => ({ ok: true }));
  const html = (err: string) =>
    new Response(renderPasswordPage(host, next, err).html, { status: 401, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  if (!rl.ok) return html("Too many attempts. Try again in a few minutes.");
  if (!password || !(await bcrypt.compare(password, p.protection.passwordHash))) return html("Incorrect password.");
  const secure = (req.headers.get("x-forwarded-proto") ?? "").includes("https") ? "; Secure" : "";
  return new Response(null, {
    status: 303,
    headers: {
      location: next,
      "set-cookie": `${AUTH_COOKIE}=${encodeURIComponent(signAuthCookie(p.projectId, p.protection.passwordHash))}; Path=/; Max-Age=${AUTH_TTL_SEC}; HttpOnly; SameSite=Lax${secure}`,
      "cache-control": "no-store",
    },
  });
}
