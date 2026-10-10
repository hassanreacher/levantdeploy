/**
 * Builder live previews in the Caddy config (builder-core area; additive to config.ts, like ./base.ts).
 *
 *   preview-{id}.{PLATFORM_DOMAIN}   (id = 20–40 [a-z0-9], a BuilderProject id)
 *     /__levant/sso, /__levant/share  → control /api/internal/builder/preview-sso   (one-time token / share token → cookie)
 *     /__levant/errors                → control /api/internal/builder/preview-errors (bridge-forwarded browser errors)
 *     everything else                 → forward-auth GET control /api/internal/builder/preview-auth
 *                                       2xx → reverse_proxy lvb-{id}:3000 (next dev; HMR websockets pass through)
 *                                       otherwise the control response (login / starting page) is returned as is
 *   upstream failure (container stopped / restarting) → control /api/internal/builder/preview-page?state=starting
 *
 * ONE static route for all previews: the host is matched with a header_regexp on Host and the dial address uses the
 * captured id ({http.regexp.lvpreview.1}), so creating/deleting builder projects needs no Caddy resync. Exact site
 * hosts (deployments) are matched earlier, so they always win.
 */

type Ctx = { controlUpstream: string; dashboardHost: string };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const PREVIEW_ID_RE = "[a-z0-9]{20,40}";

export function previewHostPattern(platformDomain: string) {
  return `^preview-(${PREVIEW_ID_RE})\\.${escapeRe(platformDomain.toLowerCase())}(:[0-9]+)?$`;
}

function control(ctx: Ctx) {
  return {
    handler: "reverse_proxy",
    upstreams: [{ dial: ctx.controlUpstream }],
    headers: { request: { set: { Host: [ctx.dashboardHost], "X-Levant-Original-Host": ["{http.request.host}"] } } },
  };
}

function hostMatch(platformDomain: string, extra: Record<string, unknown> = {}) {
  return { header_regexp: { Host: { name: "lvpreview", pattern: previewHostPattern(platformDomain) } }, ...extra };
}

export function buildBuilderPreviewRoutes(ctx: Ctx, platformDomain: string): unknown[] {
  return [
    {
      match: [hostMatch(platformDomain, { path: ["/__levant/sso", "/__levant/share"] })],
      handle: [{ handler: "rewrite", uri: "/api/internal/builder/preview-sso?path={http.request.uri.path}&{http.request.uri.query}" }, control(ctx)],
      terminal: true,
    },
    {
      match: [hostMatch(platformDomain, { path: ["/__levant/errors"] })],
      handle: [{ handler: "rewrite", uri: "/api/internal/builder/preview-errors" }, control(ctx)],
      terminal: true,
    },
    {
      match: [hostMatch(platformDomain)],
      handle: [
        {
          handler: "reverse_proxy",
          upstreams: [{ dial: ctx.controlUpstream }],
          rewrite: { method: "GET", uri: "/api/internal/builder/preview-auth" },
          headers: {
            request: {
              set: {
                Host: [ctx.dashboardHost],
                "X-Levant-Original-Host": ["{http.request.host}"],
                "X-Forwarded-Method": ["{http.request.method}"],
                "X-Forwarded-Uri": ["{http.request.uri}"],
              },
              // the auth sub-request must be a plain GET: an HMR websocket upgrade would otherwise be forwarded to
              // control (→ 502). Only the sub-request is affected; the original request keeps its upgrade headers.
              delete: ["Connection", "Upgrade", "Sec-WebSocket-Key", "Sec-WebSocket-Version", "Sec-WebSocket-Extensions", "Sec-WebSocket-Protocol"],
            },
          },
          // 2xx → continue to the preview container; anything else (login / starting page) goes back to the client
          handle_response: [{ match: { status_code: [2] }, routes: [{ handle: [{ handler: "vars", levant_preview: "ok" }] }] }],
        },
        {
          handler: "reverse_proxy",
          upstreams: [{ dial: "lvb-{http.regexp.lvpreview.1}:3000" }],
          transport: { protocol: "http", dial_timeout: "3s" },
          flush_interval: -1,
          headers: { request: { delete: ["X-Levant-Original-Host", "X-Forwarded-Method", "X-Forwarded-Uri"] } },
        },
      ],
      terminal: true,
    },
  ];
}

/** Error route: upstream failures on preview hosts → "starting preview" page (auto-refresh; start enqueued). */
export function builderPreviewErrorRoute(ctx: Ctx, platformDomain: string): unknown {
  return {
    match: [hostMatch(platformDomain, { expression: "{http.error.status_code} >= 500" })],
    handle: [{ handler: "rewrite", uri: "/api/internal/builder/preview-page?host={http.request.host}&state=starting" }, control(ctx)],
    terminal: true,
  };
}
