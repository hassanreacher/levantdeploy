// base-runtime area: LevantBase hosts (see ./base.ts)
import { buildBaseRoutes, baseErrorRoute, type BaseRoute } from "./base";
// builder-core area: AI builder live previews preview-{id}.{PLATFORM_DOMAIN} (see ./builder.ts)
import { buildBuilderPreviewRoutes, builderPreviewErrorRoute } from "./builder";

/**
 * Pure builder: route state (derived from the DB by state.ts) → full Caddy JSON config.
 * Everything Caddy serves is in here, so `POST /load` of the result is idempotent.
 *
 * Layout:
 *   servers.levant_https (:443, on-demand TLS gated by /api/internal/tls-ask)
 *   servers.levant_http  (:80, same routes when PLATFORM_SCHEME=http, otherwise 308 → https)
 *   routes = one terminal subroute (no top-level host matchers → Caddy doesn't eagerly manage certificates for
 *            hundreds of deployment hosts; certificates are obtained on demand at the first handshake):
 *     1. dashboard host            → control app
 *     2. redirect domains          → 308 Location: <scheme>://<target><uri>
 *     3. live sites (host list)    → reverse_proxy over the replicas (round robin, retries, passive health)
 *     4. everything else           → control app /api/internal/pages/host?host=… (branded 404 / 503 "building" pages)
 *   errors (upstream down)         → control app /api/internal/pages/host?state=unavailable
 */

export type SiteRoute = {
  /** hostnames (lowercase, no port) */
  hosts: string[];
  /** host:port dial addresses (container aliases on levant_net) */
  upstreams: string[];
  projectId: string;
  deploymentId: string;
  /** subset of `hosts` behind deployment protection (Project.protection) */
  protectedHosts?: string[];
  protection?: SiteProtection;
};

/** password = control-served password page + signed cookie (forward-auth); basic = Caddy basic_auth with the bcrypt hash */
export type SiteProtection = { mode: "password" | "basic"; username?: string; passwordHash?: string };

export type RedirectRoute = { host: string; to: string; status: number; projectId: string };

export type ProxyState = {
  dashboardHost: string;
  controlUpstream: string;
  scheme: "http" | "https";
  tls: "acme" | "internal" | "off";
  acmeEmail?: string;
  logDir: string;
  adminListen: string;
  adminOrigins: string[];
  sites: SiteRoute[];
  redirects: RedirectRoute[];
  /** LevantBase projects ({ref}.BASE_DOMAIN + studio-{ref}.BASE_DOMAIN) — base-runtime area */
  bases?: BaseRoute[];
  /** builder-core: platform domain for the static preview-{id}.{domain} route (null/undefined = no builder previews) */
  builderPreviewDomain?: string | null;
};

export type HostInfo = { projectId: string; deploymentId: string | null };

const stripPort = (h: string) => h.replace(/:\d+$/, "").toLowerCase();

function controlProxy(controlUpstream: string, dashboardHost: string) {
  return {
    handler: "reverse_proxy",
    upstreams: [{ dial: controlUpstream }],
    headers: { request: { set: { Host: [dashboardHost], "X-Levant-Original-Host": ["{http.request.host}"] } } },
  };
}

function hostPage(state: ProxyState, stateName?: string) {
  const q = `host={http.request.host}${stateName ? `&state=${stateName}` : ""}`;
  return [{ handler: "rewrite", uri: `/api/internal/pages/host?${q}` }, controlProxy(state.controlUpstream, state.dashboardHost)];
}

function siteProxy(s: SiteRoute) {
  return {
    handler: "reverse_proxy",
    upstreams: s.upstreams.map((dial) => ({ dial })),
    // keep retrying other/recovering replicas for up to 10 s (restarts, crashes) before giving up
    load_balancing: { selection_policy: { policy: "round_robin" }, try_duration: "10s", try_interval: "250ms" },
    // passive: only failed connections count (an app answering 500 is still "up"); short so restarted replicas return fast
    health_checks: { passive: { fail_duration: "3s", max_fails: 1 } },
    transport: { protocol: "http", dial_timeout: "2s" },
    headers: { request: { set: { "X-Levant-Deployment": [s.deploymentId] }, delete: ["X-Levant-Auth"] } },
    flush_interval: -1,
  };
}

/**
 * Protected hosts:
 *  - basic:    `authentication` handler (http_basic, bcrypt hash base64-encoded as Caddy expects) → app
 *  - password: `/__levant/auth` (login form POST) → control; every other request first does a forward-auth GET to
 *              control `/api/internal/protection/check` (2xx = signed cookie valid → continue to the app,
 *              otherwise control's response — the password page — is returned as is)
 */
function protectedRoutes(state: ProxyState, hosts: string[], p: SiteProtection, proxy: unknown): unknown[] {
  if (p.mode === "basic") {
    const hash = p.passwordHash ?? "";
    return [
      {
        match: [{ host: hosts }],
        handle: [
          {
            handler: "authentication",
            providers: { http_basic: { accounts: [{ username: p.username || "levant", password: Buffer.from(hash).toString("base64") }], realm: "Protected deployment" } },
          },
          proxy,
        ],
        terminal: true,
      },
    ];
  }
  const ctl = controlProxy(state.controlUpstream, state.dashboardHost);
  return [
    {
      match: [{ host: hosts, path: ["/__levant/auth"] }],
      handle: [{ handler: "rewrite", uri: "/api/internal/protection/login?{http.request.uri.query}" }, ctl],
      terminal: true,
    },
    {
      match: [{ host: hosts }],
      handle: [
        {
          handler: "reverse_proxy",
          upstreams: [{ dial: state.controlUpstream }],
          rewrite: { method: "GET", uri: "/api/internal/protection/check" },
          headers: {
            request: {
              set: {
                Host: [state.dashboardHost],
                "X-Levant-Original-Host": ["{http.request.host}"],
                "X-Forwarded-Method": ["{http.request.method}"],
                "X-Forwarded-Uri": ["{http.request.uri}"],
              },
            },
          },
          // 2xx → continue with the next handler (the app); anything else is written back to the client
          handle_response: [{ match: { status_code: [2] }, routes: [{ handle: [{ handler: "vars", levant_auth: "ok" }] }] }],
        },
        proxy,
      ],
      terminal: true,
    },
  ];
}

export function buildRoutes(state: ProxyState) {
  const dashboard = stripPort(state.dashboardHost);
  const routes: unknown[] = [];
  routes.push({
    match: [{ host: [dashboard] }],
    handle: [{ handler: "reverse_proxy", upstreams: [{ dial: state.controlUpstream }], flush_interval: -1 }],
    terminal: true,
  });
  for (const r of state.redirects) {
    routes.push({
      match: [{ host: [r.host] }],
      handle: [{ handler: "static_response", status_code: r.status, headers: { Location: [`{http.request.scheme}://${r.to}{http.request.uri}`] } }],
      terminal: true,
    });
  }
  // exact hosts first, wildcard hosts (`*.example.com`) after them → an exact host always wins over a wildcard
  const wildcardRoutes: unknown[] = [];
  for (const s of state.sites) {
    if (!s.hosts.length || !s.upstreams.length) continue;
    const proxy = siteProxy(s);
    for (const [hosts, into] of [
      [s.hosts.filter((h) => !h.startsWith("*.")), routes],
      [s.hosts.filter((h) => h.startsWith("*.")), wildcardRoutes],
    ] as const) {
      if (!hosts.length) continue;
      const guarded = s.protection ? (s.protectedHosts ?? []).filter((h) => hosts.includes(h)) : [];
      const open = hosts.filter((h) => !guarded.includes(h));
      if (guarded.length) into.push(...protectedRoutes(state, guarded, s.protection!, proxy));
      if (open.length) into.push({ match: [{ host: open }], handle: [proxy], terminal: true });
    }
  }
  routes.push(...wildcardRoutes);
  if (state.bases?.length) routes.push(...buildBaseRoutes(state, state.bases));
  if (state.builderPreviewDomain) routes.push(...buildBuilderPreviewRoutes(state, state.builderPreviewDomain));
  routes.push({ handle: hostPage(state), terminal: true });
  return [{ handle: [{ handler: "subroute", routes }], terminal: true }];
}

export function buildCaddyConfig(state: ProxyState) {
  const routes = buildRoutes(state);
  // upstream failures (502/503/504) → branded "starting / unavailable" page; other handler errors (e.g. 401 from
  // basic_auth, which keeps its WWW-Authenticate header) keep their status with a plain body
  const baseErr = state.bases?.length ? baseErrorRoute(state, state.bases) : null;
  const errors = {
    routes: [
      ...(baseErr ? [baseErr] : []),
      ...(state.builderPreviewDomain ? [builderPreviewErrorRoute(state, state.builderPreviewDomain)] : []),
      { match: [{ expression: "{http.error.status_code} >= 500" }], handle: hostPage(state, "unavailable"), terminal: true },
      { handle: [{ handler: "static_response", status_code: "{http.error.status_code}", body: "{http.error.status_code} {http.error.status_text}\n" }], terminal: true },
    ],
  };
  const servers: Record<string, unknown> = {};
  if (state.tls !== "off") {
    servers.levant_https = {
      listen: [":443"],
      routes,
      errors,
      tls_connection_policies: [{}],
      automatic_https: { disable_redirects: true },
      logs: { default_logger_name: "levant" },
    };
  }
  const serveHttp = state.scheme === "http" || state.tls === "off";
  servers.levant_http = {
    listen: [":80"],
    routes: serveHttp
      ? routes
      : [{ handle: [{ handler: "static_response", status_code: 308, headers: { Location: ["https://{http.request.host}{http.request.uri}"] } }], terminal: true }],
    ...(serveHttp ? { errors } : {}),
    automatic_https: { disable: true },
    logs: { default_logger_name: "levant" },
  };

  const config: Record<string, unknown> = {
    admin: { listen: state.adminListen, origins: state.adminOrigins },
    logging: {
      logs: {
        default: { level: "INFO", exclude: ["http.log.access.levant"] },
        levant_access: {
          writer: { output: "file", filename: `${state.logDir.replace(/\/$/, "")}/access.log`, roll_size_mb: 50, roll_keep: 3, mode: "0644" },
          encoder: { format: "json" },
          include: ["http.log.access.levant"],
        },
      },
    },
    apps: { http: { servers } } as Record<string, unknown>,
  };
  if (state.tls !== "off") {
    const issuer =
      state.tls === "internal"
        ? [{ module: "internal" }]
        : [{ module: "acme", ...(state.acmeEmail ? { email: state.acmeEmail } : {}) }, { module: "zerossl", ...(state.acmeEmail ? { email: state.acmeEmail } : {}) }];
    (config.apps as Record<string, unknown>).tls = {
      automation: {
        policies: [{ issuers: issuer, on_demand: true }],
        on_demand: { permission: { module: "http", endpoint: `http://${state.controlUpstream}/api/internal/tls-ask` } },
      },
    };
  }
  return config;
}

/** host → project/deployment (used by the metrics tailer to attribute access-log lines). */
export function buildHostMap(state: ProxyState): Record<string, HostInfo> {
  const m: Record<string, HostInfo> = {};
  for (const s of state.sites) for (const h of s.hosts) m[h] = { projectId: s.projectId, deploymentId: s.deploymentId }; // incl. "*.example.com"
  for (const r of state.redirects) m[r.host] ??= { projectId: r.projectId, deploymentId: null };
  return m;
}
