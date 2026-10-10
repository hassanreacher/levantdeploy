import type { BaseStatus } from "@prisma/client";

/**
 * LevantBase hosts in the Caddy config (base-runtime area; additive to config.ts):
 *   {ref}.{BASE_DOMAIN}         → project gateway lb_{ref}_api-gw:8000 (REST/Auth/Storage/Realtime websockets/Functions/pg)
 *                                 request bodies capped at the plan's max upload (+1 MB); not running → branded page
 *   studio-{ref}.{BASE_DOMAIN}  → /__levant/sso → control (one-time token → cookie); everything else: forward-auth to
 *                                 control /api/internal/base/studio-auth, then the gateway's Studio listener (:8001)
 *                                 with the per-project gate header. Studio is never reachable without the SSO cookie.
 */
export type BaseRoute = {
  ref: string;
  apiHost: string;
  /** ACTIVE custom API hostnames (BaseProject.settings.customDomain) → same gateway */
  customHosts?: string[];
  studioHost: string;
  status: BaseStatus;
  /** host:port of the gateway on levant_net */
  gatewayDial: string;
  studioDial: string;
  studioGateSecret: string;
  maxBodyBytes: number;
  /** storage over the plan limit (enforced) → uploads answered with 507 */
  uploadsBlocked?: boolean;
  /** DB over the plan limit (enforced): DB default_transaction_read_only + PostgREST writes answered with 507
   *  (PostgREST opens explicit READ WRITE transactions, so the DB default alone doesn't stop it) */
  dbReadOnly?: boolean;
};

type Ctx = { controlUpstream: string; dashboardHost: string };

/** statuses during which the gateway receives traffic */
export const BASE_ROUTED: BaseStatus[] = ["ACTIVE", "UPGRADING", "RESTORING"];

function control(ctx: Ctx) {
  return {
    handler: "reverse_proxy",
    upstreams: [{ dial: ctx.controlUpstream }],
    headers: { request: { set: { Host: [ctx.dashboardHost], "X-Levant-Original-Host": ["{http.request.host}"] } } },
  };
}

export function basePage(ctx: Ctx, state?: string) {
  return [
    { handler: "rewrite", uri: `/api/internal/base/page?host={http.request.host}${state ? `&state=${state}` : ""}` },
    control(ctx),
  ];
}

export function buildBaseRoutes(ctx: Ctx, bases: BaseRoute[]): unknown[] {
  const routes: unknown[] = [];
  for (const b of bases) {
    const routed = BASE_ROUTED.includes(b.status);
    const apiHosts = [b.apiHost, ...(b.customHosts ?? [])];
    // ── API host ──
    if (routed && b.dbReadOnly) {
      routes.push({
        match: [{ host: apiHosts, method: ["POST", "PUT", "PATCH", "DELETE"], path: ["/rest/v1/*"] }],
        handle: [
          {
            handler: "static_response",
            status_code: 507,
            headers: { "Content-Type": ["application/json"] },
            body: '{"code":"LB507","message":"The database is larger than this project\'s plan allows and is read-only. Delete data or upgrade the plan.","details":null,"hint":null}',
          },
        ],
        terminal: true,
      });
    }
    if (routed && b.uploadsBlocked) {
      routes.push({
        match: [{ host: apiHosts, method: ["POST", "PUT", "PATCH"], path: ["/storage/v1/object/*", "/storage/v1/upload/*", "/storage/v1/s3/*"] }],
        handle: [
          {
            handler: "static_response",
            status_code: 507,
            headers: { "Content-Type": ["application/json"] },
            body: '{"statusCode":"507","error":"Storage quota exceeded","message":"This project has used all the file storage its plan includes. Uploads are blocked until files are removed or the plan is upgraded."}',
          },
        ],
        terminal: true,
      });
    }
    if (routed) {
      routes.push({
        match: [{ host: apiHosts }],
        handle: [
          { handler: "request_body", max_size: b.maxBodyBytes },
          {
            handler: "reverse_proxy",
            upstreams: [{ dial: b.gatewayDial }],
            transport: { protocol: "http", dial_timeout: "3s" },
            // streaming responses (realtime long-polling, SSE, large downloads) + websockets (automatic upgrade)
            flush_interval: -1,
            headers: { request: { set: { "X-Levant-Base": [b.ref] }, delete: ["X-Levant-Studio-Gate"] } },
          },
        ],
        terminal: true,
      });
    } else {
      routes.push({ match: [{ host: apiHosts }], handle: basePage(ctx), terminal: true });
    }
    // ── Studio host ──
    const sso = {
      match: [{ host: [b.studioHost], path: ["/__levant/sso"] }],
      handle: [{ handler: "rewrite", uri: "/api/internal/base/studio-sso?{http.request.uri.query}" }, control(ctx)],
      terminal: true,
    };
    if (b.status !== "ACTIVE") {
      routes.push({ match: [{ host: [b.studioHost] }], handle: basePage(ctx), terminal: true });
      continue;
    }
    routes.push(sso, {
      match: [{ host: [b.studioHost] }],
      handle: [
        {
          handler: "reverse_proxy",
          upstreams: [{ dial: ctx.controlUpstream }],
          rewrite: { method: "GET", uri: "/api/internal/base/studio-auth" },
          headers: {
            request: {
              set: {
                Host: [ctx.dashboardHost],
                "X-Levant-Original-Host": ["{http.request.host}"],
                "X-Forwarded-Method": ["{http.request.method}"],
                "X-Forwarded-Uri": ["{http.request.uri}"],
              },
            },
          },
          // 2xx → continue to Studio; anything else (401 page) is returned to the visitor as is
          handle_response: [{ match: { status_code: [2] }, routes: [{ handle: [{ handler: "vars", levant_studio: "ok" }] }] }],
        },
        {
          handler: "reverse_proxy",
          upstreams: [{ dial: b.studioDial }],
          transport: { protocol: "http", dial_timeout: "3s" },
          flush_interval: -1,
          headers: { request: { set: { "X-Levant-Studio-Gate": [b.studioGateSecret] } } },
        },
      ],
      terminal: true,
    });
  }
  return routes;
}

/** Error route: upstream failures on base hosts → branded base page ("starting / unavailable"). */
export function baseErrorRoute(ctx: Ctx, bases: BaseRoute[]): unknown | null {
  const hosts = bases.flatMap((b) => [b.apiHost, ...(b.customHosts ?? []), b.studioHost]);
  if (!hosts.length) return null;
  return {
    match: [{ host: hosts, expression: "{http.error.status_code} >= 500" }],
    handle: basePage(ctx, "unavailable"),
    terminal: true,
  };
}
