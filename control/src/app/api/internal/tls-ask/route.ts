import { hostAllowedForTls } from "@/lib/proxy/hosts";

export const dynamic = "force-dynamic";

/**
 * GET /api/internal/tls-ask?domain=<host>
 * Caddy on-demand TLS permission check: 200 → Caddy may obtain a certificate for this host, anything else → refuse.
 * Known hosts: dashboard host, deployment URLs, branch aliases, PLATFORM domains, ACTIVE custom domains.
 */
export async function GET(req: Request) {
  const domain = new URL(req.url).searchParams.get("domain") ?? "";
  try {
    const ok = domain.length > 0 && domain.length <= 253 && (await hostAllowedForTls(domain));
    return new Response(ok ? "ok" : "unknown host", { status: ok ? 200 : 404, headers: { "cache-control": "no-store" } });
  } catch (e) {
    console.warn("[tls-ask]", (e as Error).message);
    return new Response("error", { status: 503 });
  }
}
