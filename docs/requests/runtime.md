# Runtime area — notes, contracts & requests

Status: DONE (wave B). Everything below is implemented and was tested end to end against real Docker + Caddy.

## What lives where

| Path | What |
|---|---|
| `src/lib/runtime/deploy.ts` | `runDeploy` (DEPLOYING → containers → health → READY → routes), `switchProduction` (zero-downtime), `rollbackTo`, `restartDeployment` (rolling replace), `stopDeployment`, `scaleProject`, `drainStop`, `removeDeploymentContainers` |
| `src/lib/runtime/containers.ts` | container create (env, limits, restart policy, volumes, labels, json-file log rotation, alias on levant_net), inspect/stop/start/remove, `tailLogs`, `demuxBuffer` |
| `src/lib/runtime/health.ts` | HTTP / TCP / "stays running" health checks, crash-loop detection, last logs on failure |
| `src/lib/runtime/env.ts` | runtime env = shared groups < project < branch override, + database add-on URLs, + `LEVANT_*`, `PORT` |
| `src/lib/runtime/compose.ts` | COMPOSE kind (`docker compose -p levant_{shortId}`) |
| `src/lib/runtime/log-follower.ts` | follows `docker logs` of every live replica → `appendLog(id, "RUNTIME", "[r1] …")` |
| `src/lib/runtime/metrics.ts` | docker stats sampler (30 s) + Caddy access-log tailer → `MetricSample`; `querySeries()` for the UI |
| `src/lib/runtime/databases.ts`, `db-engines.ts` | Postgres/MySQL/Redis/Mongo add-ons, backups, restore, retention |
| `src/lib/runtime/cron.ts`, `cron-expr.ts` | cron parser (5 fields, macros, timezones), one-off containers / HTTP GET runs |
| `src/lib/runtime/cleanup.ts` | prune stopped deployments (keep 5) + images, dangling images, work dirs, expired uploads, logs, metrics |
| `src/lib/proxy/{config,state,sync,hosts,pages}.ts` | Caddy JSON builder (pure), DB → routes, `syncRoutes()` (debounced, Redis lock), host resolution, branded pages |
| `src/lib/domains/{validate,dns,verify,service,platform}.ts` | domain validation, injectable DNS, verification state machine, CRUD service, free subdomain |
| `src/worker/processors/runtime.ts` | queues `deploy`, `domains`, `metrics`, `cron`, `cleanup`, `backups` + start hooks (sync routes, log followers, access-log tailer) |
| `scripts/runtime/dev-caddy.sh` | dev/test Caddy (`levant-caddy`) on levant_net, 80/443 + admin on 127.0.0.1:2019 |
| `tests/runtime/` | `rt.ts` e2e driver, `fake-dns.ts` (UDP fake DNS server), fixture apps (node/static/python/worker/crash/compose) |

## APIs

### Deployment actions (dashboard builds the buttons)
All: session or `Bearer` token (scope `deployments:write`), role MEMBER+. They enqueue a job on the `deploy` queue and return
`202 { deployment, jobId }`; progress lines go to the deployment's BUILD log stream, status changes via `STATUS_CHANNEL`.

| method + path | body | what it does |
|---|---|---|
| `POST /api/v1/deployments/:id/promote` | `{}` | PREVIEW → NEW production deployment (trigger PROMOTE, same image, production env). PRODUCTION (not current) → instant rollback. |
| `POST /api/v1/deployments/:id/rollback` | `{}` | previous production (READY/SUPERSEDED) becomes current: start its stopped containers or recreate from its image → health → switch routes → old production SUPERSEDED, stopped after drain. |
| `POST /api/v1/deployments/:id/restart` | `{}` | rolling replace (new replica healthy → swapped into routes → old removed) — zero downtime, picks up env changes; on a stopped deployment it starts it (`action: "start"`). |
| `POST /api/v1/deployments/:id/stop` | `{ force? }` | routes removed first, then containers stopped (kept for instant restart/rollback). Current production needs `force: true` (409 otherwise). |
| `POST /api/v1/projects/:id/scale` | `{ replicas }` | updates `project.replicas`; scales the live production deployment (new replicas health-checked before traffic). Max = `limits.defaults.maxReplicas`. |
| `GET /api/v1/deployments/:id/runtime` | — | live docker state `{ containers[{name,replica,service,state,running,restartCount,startedAt}], live, stoppedAt }` |
| `GET /api/v1/deployments/:id/runtime-logs?level=&q=&replica=&since=&until=` | — | filtered runtime log download (text/plain). Live tail = foundation SSE `…/logs?stream=RUNTIME`. |

`redeploy` and `cancel` were built by the dashboard area (`/api/v1/deployments/:id/{redeploy,cancel}`) — runtime did not duplicate them.

### Domains (ADMIN for writes, scope `domains:*`)
```
GET    /api/v1/projects/:id/domains                       → { items: DomainDTO[], config: { platformDomain, serverIps, cnameTarget } }
POST   /api/v1/projects/:id/domains                       { hostname, redirectTo?, redirectStatus?, gitBranch?, withWww? } → 201 { items }
PATCH  /api/v1/projects/:id/domains/:domainId             { redirectTo?|null, redirectStatus?, gitBranch?|null, isPrimary?: true, subdomain? (PLATFORM rename) }
DELETE /api/v1/projects/:id/domains/:domainId             (PLATFORM domain can't be removed — rename it)
POST   /api/v1/projects/:id/domains/:domainId/verify      → { domain }  ("Verify now", synchronous DNS check)
```
DomainDTO includes `dns: [{type,name,value,purpose,alternative}]` (instructions) and `check` (last lookup result).

### Other
```
GET  /api/v1/projects/:id/metrics?range=1h|6h|24h|7d[&deploymentId=]   → { from, to, step, points[{t,requests,errors,s4xx,p50,p95,cpu,mem,memLimit,rx,tx,restarts}], totals }
GET|POST /api/v1/projects/:id/volumes        PATCH|DELETE /api/v1/projects/:id/volumes/:volumeId[?purge=1]
GET|POST /api/v1/projects/:id/cron           PATCH|DELETE /api/v1/projects/:id/cron/:cronId
POST /api/v1/projects/:id/cron/:cronId/run → 202 { runId }      GET /api/v1/projects/:id/cron/:cronId/runs
GET  /api/v1/projects/:id/databases          → { items (connected), available (team), engines }
GET|POST /api/v1/teams/:team/databases       { name, engine, version?, projectId?, publicAccess?, backupSchedule?, backupRetention? }
GET|PATCH|DELETE /api/v1/databases/:id       PATCH { projectId?|null, publicAccess?, backupSchedule?|null, backupRetention? }
GET  /api/v1/databases/:id/credentials       (ADMIN, audited)       POST /api/v1/databases/:id/actions { action: start|stop|restart }
GET|POST /api/v1/databases/:id/backups       DELETE /api/v1/databases/:id/backups/:backupId
POST /api/v1/databases/:id/backups/:backupId/restore              GET /api/v1/databases/:id/backups/:backupId/download
GET  /api/internal/tls-ask?domain=           200 only for known hosts (dashboard, deployment URLs, branch aliases, PLATFORM + ACTIVE custom domains)
GET  /api/internal/pages/host?host=&state=   branded 404 "Deployment not found" / 503 "building/starting/stopped" (auto refresh) / 502 "failed"
GET|POST /api/internal/proxy/sync            platform owner: last sync status / force a sync
```

## UI
Project tabs (replaced placeholders): **Logs**, **Domains**, **Storage**, **Databases**, **Cron**, and a NEW **Observability** tab
(added to `PROJECT_TABS` in `src/components/shell/nav.ts`, after Logs). Shared chart: `src/components/runtime/line-chart.tsx`
(dependency-free SVG, crosshair tooltip). Screenshots: `docs/screenshots/runtime/`.

## Contracts other areas rely on

- **Build → deploy hand-off**: build sets DEPLOYING `{imageTag, meta.build}` and enqueues `deploy`. The build engine calls
  `endLogs`/`archiveLogs(BUILD)` when it hands over; the runtime re-opens the stream (`reopenLogs`: drops the end marker) and
  writes deploy-phase lines into the same BUILD stream, then ends + archives it again at READY/ERROR. Nothing to change on the
  build side, but if the build area stops ending the stream on success that also works.
- **COMPOSE**: runtime consumes the build area's `meta.build.composeSpecEnc` (encrypted normalized spec with built images),
  `meta.build.composePrimary` and `meta.build.port`. Fallback: `meta.compose = { file, projectDir?, services?[] }`. Host `ports`
  are dropped, services join levant_net with alias `ld-{shortId}-{service}`, named volumes become `levant_vol_{projectId}_{name}`.
- **Containers**: `Deployment.containerIds = [{ id, name, replica, port, alias, service?, public? }]`. Names
  `levant_{slug}_{shortId}_{replica}`, alias `ld-{shortId}-{replica}`; labels `levant.managed/team/project/deployment/kind`,
  `levant.replica`, `levant.target`, `levant.role` (app|compose|cron|db). `Deployment.stoppedAt` = containers stopped (URL serves
  the "stopped" page); `meta.containersRemoved = true` after pruning (rollback then recreates from the image if it still exists).
- **Runtime env vars** injected into every container: user env (shared groups < project < preview branch override), database
  add-on URLs (`DATABASE_URL`/`POSTGRES_URL`, `MYSQL_URL`, `REDIS_URL`, `MONGODB_URL`/`MONGO_URL`; extra DBs of the same engine
  → `<NAME>_URL`), `LEVANT=1`, `LEVANT_ENV`, `LEVANT_URL`, `LEVANT_DEPLOYMENT_ID/_NUMBER/_URL`, `LEVANT_PROJECT(_ID)`,
  `LEVANT_PROJECT_PRODUCTION_URL`, `LEVANT_GIT_BRANCH`, `LEVANT_GIT_COMMIT_SHA/_MESSAGE`, `LEVANT_REPLICA`, `PORT` (forced);
  overridable defaults `HOST=0.0.0.0`, `HOSTNAME=0.0.0.0`, `NODE_ENV=production` (production only).
- **`Project.runtimeSettings`** keys (dashboard settings UI may expose them): `drainSeconds`, `startCommand`,
  `healthcheck { type: http|tcp|none, path, timeoutSeconds (120), intervalSeconds (1), accept: lt500|2xx3xx|any }`,
  `workerStableSeconds` (10), `keepPreviewsPerBranch` (1), `cronTimeoutSeconds` (900), `logMaxSize` ("10m"), `logMaxFile` (3).
  Health default: HTTP GET `healthcheckPath` on `port`, 2xx–4xx = alive, 5xx not; `healthcheckPath = null` → TCP; WORKER kind →
  running for N s (WORKER projects get no HTTP routes; their URL shows "No HTTP endpoint").
- **Notify events** enqueued on `notify` (dashboard processor): `domain.verified`, `domain.failed`
  (`{ teamId, projectId, payload: { domainId, hostname, reason } }`) — please add them to the notification channels' event list.
- **Audit actions**: `deployment.promote|rollback|restart|start|stop`, `project.scale`, `domain.add|update|remove|verify`,
  `volume.create|update|delete`, `cron.create|update|delete|run`, `database.create|update|delete|start|stop|restart|backup|restore|backup_download|backup_delete|reveal_credentials`.

## Proxy (Caddy) — for the ops area
- `syncRoutes()` POSTs the **whole** config to `{CADDY_ADMIN_URL}/load` (idempotent, derived from DB). It sets
  `admin.listen = CADDY_ADMIN_LISTEN || "0.0.0.0:2019"` and `admin.origins` (`caddy:2019`, `levant-caddy:2019`, localhost…). Requests
  carry an `Origin` header matching `CADDY_ADMIN_URL` (Caddy enforces origins for fetch-style clients). **Do not publish 2019
  publicly** — keep it on the internal network (dev script binds 127.0.0.1 only).
- Caddy must start with a bootstrap config whose admin listens on `0.0.0.0:2019` (see `scripts/runtime/dev-caddy.sh`), be on
  `levant_net` (it dials container aliases), and reach the control app at `CONTROL_UPSTREAM` (default prod `control:3000`).
- One terminal subroute (no top-level host matchers) + on-demand TLS gated by `/api/internal/tls-ask` → certificates only for
  known hosts, at first handshake. `PROXY_TLS=acme` (prod: Let's Encrypt + ZeroSSL, `ACME_EMAIL`) | `internal` (local CA) | `off`.
  With `PLATFORM_SCHEME=https`, :80 only 308-redirects to https (ACME HTTP challenges are still answered by Caddy).
- Load balancing: round robin, `try_duration 10s`, passive health (failed dials only, 3 s) — restarts/crashes are retried on
  other replicas instead of failing requests.
- JSON access log → `${CADDY_LOG_DIR}/access.log` inside Caddy; the **worker** tails the same file at `CADDY_ACCESS_LOG`
  (default `STORAGE_DIR/caddy/access.log`) → share a volume between caddy and worker.
- The **worker container** needs: the Docker socket, the `docker` CLI with the compose plugin (COMPOSE kind), membership in
  `levant_net` (health checks hit container IPs), and `STORAGE_DIR` (backups, compose specs, access log).

### New env vars (added to `src/lib/env.ts`, all optional)
`CONTROL_UPSTREAM`, `PROXY_TLS`, `ACME_EMAIL`, `CADDY_LOG_DIR`, `CADDY_ACCESS_LOG`, `SERVER_IPS` (A/AAAA targets shown in DNS
instructions and verified; empty = any A record accepted), `DNS_RESOLVERS` (default `1.1.1.1,8.8.8.8`, `ip[:port]`),
`CADDY_ADMIN_LISTEN` (read directly, default `0.0.0.0:2019`). Please add them to `.env.example` / installer.

## Domains behaviour
- Validation: punycode, no IPs / wildcards / single labels / reserved TLDs (.local, .test, .localhost …), nothing under
  `PLATFORM_DOMAIN`, not the dashboard host; one hostname globally (409 otherwise).
- DNS: apex → `A` (+`AAAA`) to `SERVER_IPS`; subdomain → `CNAME cname.{PLATFORM_DOMAIN}` (or A); plus TXT
  `_levant-verify.{host}` = token. Both routing and ownership are required.
- Checks (domains queue tick every minute, per-domain `nextCheckAt`): every minute for the first hour, every 10 min up to 48 h,
  then daily; ACTIVE domains daily. PENDING→ACTIVE syncs routes + notifies; ACTIVE→FAILED after 2 consecutive failed automatic
  checks (or one manual "Verify now"). Free subdomain `{slug}.{PLATFORM_DOMAIN}` (kind PLATFORM) is created on first deploy /
  Domains visit and can be renamed (`-git-` and a few names reserved).

## Schema changes (additive, `prisma db push`)
- `MetricSample`: `kind` ("container" | "http", default "container"), `restarts`, `status4xx`, `p50Ms`, `p95Ms`; index `(projectId, kind, bucket)`.
- `Domain`: `nextCheckAt`, `dnsRecords` (Json).
- `CronRun`: `trigger` ("SCHEDULED" | "MANUAL"), `durationMs`.

## Shared-file changes (additive)
- `src/lib/queues.ts` `JobData`: `deploy.action/replicas/byUserId`, `domains.tick`, `cron.manual/runId`, `backups.action`,
  `cleanup.kind += "workdirs" | "metrics" | "drain"`, `cleanup.deploymentId`.
- `src/lib/settings.ts`: `deploy.drainSeconds` default 15 → **30** (as specified).
- `src/lib/env.ts`: env vars above. `src/components/shell/nav.ts`: Observability tab. `.gitignore`: `.env.*` (except
  `.env.example`), `storage-*/`.

## Tested end to end (real Docker 29 + Caddy 2.11, levant_net)
- Deploy node / nginx static / python / worker / crash-looping images; HTTP + HTTPS (`-k`, Caddy local CA, on-demand cert via
  tls-ask) through Caddy with Host headers; crash → ERROR with the container's last logs.
- Zero downtime: continuous curl loop during production switch v1→v2 (948/948 OK), rollback (601/601 OK), rolling restart +
  killed replica + scale-down (669/669 OK); old production stopped after drain.
- 3 replicas → perfect round robin (3/3/3); scale up/down live.
- Preview + branch alias `{project}-git-feature-login`; promote preview → new production deployment with production env.
- COMPOSE stack (node web + redis with password, named volume) — routed public service, no host ports, service DNS works.
- Domains with the fake DNS server: PENDING → (records published) → Verify now → ACTIVE, www → apex 308 redirect, HTTPS cert for
  the custom domain, ACTIVE → FAILED after records removed (2 checks) → ACTIVE again; unknown host → tls-ask 404 (no cert).
- Database add-ons: Postgres + Redis connected → app `/db` (pg client) and `/redis` work with injected `DATABASE_URL`/`REDIS_URL`;
  manual + scheduled backups for all 4 engines; restore verified for Postgres and Redis; download via API.
  (MySQL/Mongo restore code paths exist but a destructive restore check for them was not run in this sandbox.)
- Cron: scheduled command job (one-off container, `LEVANT_ENV=production`), HTTP path job, failing job (exit 2), manual runs.
- Volumes persist across deploys; metrics rows (container + http) and Observability charts; runtime logs with replica prefixes;
  cleanup (keep N stopped, recreate on rollback).

## Follow-up round (dashboard requests, docs/requests/dashboard.md)
1. **Deployment protection** (`Project.protection`, read with `readProtection()`) is applied by `syncRoutes()`:
   - scope `previews`: deployment URLs (`{project}-{shortid}`), branch aliases and branch-pinned custom domains; `all`: every host incl.
     the free domain and custom production domains (redirect domains just redirect).
   - `basic`: Caddy `authentication`/`http_basic` handler with the stored bcrypt hash (base64), realm "Protected deployment" → 401 +
     `WWW-Authenticate` on failure.
   - `password`: Caddy forward-auth (reverse_proxy `rewrite` GET → control `GET /api/internal/protection/check`; 2xx continues to
     the app, otherwise control's 401 password page is returned). The form posts to `/__levant/auth` on the same host → control
     `POST /api/internal/protection/login` (bcrypt.compare, 10 attempts / 5 min per IP+host) → host-only cookie `__levant_auth`
     (7 days, HttpOnly, SameSite=Lax, Secure over https; HMAC(SESSION_SECRET) over projectId + expiry + hash fingerprint, so changing
     the password logs everyone out) → 303 to the original path (relative paths only).
   - Mode `none` or a missing hash = unprotected. Server `errors` routes now only render the branded 503 for upstream 5xx errors;
     other handler errors (401 from basic auth) keep their status.
   - Shared-file edit: `PATCH /api/v1/projects/:id` (dashboard) now calls `requestSync()` when `protection`, `slug` or `kind` changes.
2. **Env vars**: `buildRuntimeEnv()` now uses the dashboard's `resolveEnv(projectId, target, branch)` (same precedence as before).
3. **Project delete**: `cleanup { kind: "all", projectId }` for a project row that no longer exists runs `purgeProject()`: removes
   containers (app/compose/cron), project images and volumes (`levant.project=<id>` label + `levant_vol_{projectId}_*`), compose
   specs, then re-syncs routes. Database add-ons are kept (team-owned; `projectId` becomes null).
4. **Screenshots**: skipped (no headless browser in the worker image); the dashboard's favicon fallback stays in place.

Tested end to end: password page (401) → wrong password (401 "Incorrect password") → right password (303 + cookie) → app (200),
cookie forged / other project → 401, `Secure` cookie over https, production host unprotected with scope `previews`; basic auth with
scope `all` on production + preview (401 without / with wrong credentials, 200 with the right ones); mode `none` → open again;
upstream down still → branded 503; `DELETE /api/v1/projects/:id` removed the 3 containers + project volume and the routes (404).

## Wildcard custom domains (`*.example.com`)
- Validator: exactly one leading `*.` label; the base must be a real domain (`*.com`, `*.co.uk` and other common
  multi-label public suffixes refused) and not the platform domain. No redirects on/to wildcards, no www counterpart.
- DNS: routing record `CNAME *` (or `A *`) → checked by resolving a random `levant-probe-…` name under the base; ownership TXT
  `_levant-verify.{base}` (same name as the apex's).
- Caddy: wildcard host matchers are emitted after all exact host routes, so exact hosts (any project) always win; one level
  deep. `resolveHost()` / `tls-ask` / branded pages / password protection / metrics attribution fall back to `*.{parent}`
  when no exact host matches; tls-ask allows single-label subdomains of an ACTIVE wildcard and never a literal `*` name.
  Certificates are on-demand per hostname (a real wildcard cert would need DNS-01 — not configured).
- Test-only env `DOMAINS_ALLOW_RESERVED_TLDS=1` (ignored in production) lets `.test` hosts through validation for e2e with
  the fake DNS server (which now answers wildcard records too).
- Tested e2e: `*.example.test` (project A) + exact `special.example.test` (project B) via fake DNS → both ACTIVE;
  `a.`/`b.example.test` → A over HTTP and HTTPS (separate on-demand certs), `special.example.test` → B, `x.y.example.test` and
  `example.test` → 404; tls-ask 200 for `a.example.test` only after verification, 404 for `x.y.` / apex. Docs:
  `docs/DOMAINS.md` (new section) and `docs/DEPLOY-LEVANTCART.md` A9 step 3 (wildcard instead of per-store API calls).
  Screenshot `docs/screenshots/runtime/15-domains-wildcard.png`.

## Known limitations / follow-ups
- Database add-ons run a single container each (no HA); resource limits for DB containers are not configurable yet.
- Runtime log follower runs inside the single worker process (fine for one server; multi-worker would need leader election).
- Metrics rollup lives in worker memory until each minute is flushed (a worker restart loses at most the current minute).
- Wildcard certificates for `*.PLATFORM_DOMAIN` (DNS challenge) are not configured; on-demand certs are used instead.
