import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionJwt } from "@/lib/auth/jwt";
import { builderPreviewFrameSrc, contentSecurityPolicy } from "../security-headers.mjs";

/**
 * builder-ui: the AI Builder pages (/{team}/build, /{team}/build/{id}) frame the live preview
 * (preview-{id}.{PLATFORM_DOMAIN}). The CSP from next.config.mjs is fixed at image build time (no domain known then),
 * so these pages get the same policy plus `frame-src` computed here at runtime.
 */
const BUILDER_PAGE = /^\/[^/]+\/build(?:\/[^/]+)?\/?$/;
function withBuilderCsp(res: NextResponse, pathname: string): NextResponse {
  if (!BUILDER_PAGE.test(pathname)) return res;
  const domain = process.env.PLATFORM_DOMAIN || "";
  res.headers.set("Content-Security-Policy", contentSecurityPolicy({ frameSrc: builderPreviewFrameSrc(domain) }));
  return res;
}

/**
 * Edge middleware (no DB access — authoritative checks happen server-side in layouts / route helpers):
 *  1. CSRF: API mutations must come from our own origin. Exempt: Bearer (API token) requests and requests carrying
 *     neither an Origin/Referer nor the session cookie (CLI / curl — no ambient credentials).
 *  2. Auth gate: every page except the public ones requires a (JWT-valid) session cookie → /login?next=…
 */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Machine endpoints authenticated by their own signatures/secrets. */
const CSRF_EXEMPT = ["/api/webhooks/", "/api/internal/", "/api/v1/github/webhook", "/api/v1/webhooks/", "/api/v1/deploy-hooks/"];
/** Pages reachable without a session. */
const PUBLIC_PAGES = ["/login", "/register", "/forgot-password", "/reset-password", "/invite", "/2fa", "/verify-email", "/features", "/pricing", "/docs"];

function sameOrigin(req: NextRequest) {
  const origin = req.headers.get("origin") || req.headers.get("referer");
  if (!origin) return false;
  try {
    const o = new URL(origin);
    const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
    if (o.host === host) return true;
    const allowed = [process.env.APP_URL, ...(process.env.ALLOWED_ORIGINS || "").split(",")]
      .map((s) => s?.trim())
      .filter(Boolean)
      .map((s) => {
        try {
          return new URL(s!).origin;
        } catch {
          return null;
        }
      });
    return allowed.includes(o.origin);
  } catch {
    return false;
  }
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  if (pathname.startsWith("/api/")) {
    if (MUTATING.has(req.method) && !CSRF_EXEMPT.some((p) => pathname.startsWith(p))) {
      const bearer = req.headers.get("authorization")?.toLowerCase().startsWith("bearer ");
      const hasOrigin = !!(req.headers.get("origin") || req.headers.get("referer"));
      const hasCookie = !!req.cookies.get(SESSION_COOKIE);
      // no ambient credentials (CLI/curl without cookie) is not a CSRF vector
      if (!(bearer || sameOrigin(req) || (!hasOrigin && !hasCookie))) {
        return NextResponse.json({ error: { code: "CSRF", message: "Invalid request origin" } }, { status: 403 });
      }
    }
    return NextResponse.next();
  }

  // "/" is public too: signed-out visitors get the product landing page (src/app/page.tsx), signed-in users their team
  const isPublic = pathname === "/" || PUBLIC_PAGES.some((p) => pathname === p || pathname.startsWith(p + "/"));
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const signedIn = token ? !!(await verifySessionJwt(token)) : false;

  if (!isPublic && !signedIn) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
    const res = NextResponse.redirect(url);
    if (token) res.cookies.delete(SESSION_COOKIE); // stale/invalid
    return res;
  }
  if (signedIn && (pathname === "/login" || pathname === "/register")) {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return withBuilderCsp(NextResponse.next(), pathname);
}

export const config = {
  // everything except static assets
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt|fonts/).*)"],
};
