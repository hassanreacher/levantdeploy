# base-runtime (LevantBase) — notes, contracts & results

Status: DONE (wave C). Verified end to end against real Docker + Caddy in the sandbox (results below).
Isolation used: DB `levantdeploy_bruntime`, Redis db 7, port 3107, `control/.env.bruntime` (gitignored), storage
`control/storage-bruntime/`.

## What lives where

| Path | What |
|---|---|
| `base-stack/template/**` | render template derived from `base-stack/upstream` (deviations: `base-stack/README.md`) |
| `base-stack/README.md` | every deviation from upstream + how to move to a newer upstream commit |
| `control/src/lib/base/config.ts` | refs, hosts, names, paths (`lb_{ref}`, `lb_{ref}_<svc>`, `base-{ref}` alias, `STORAGE_DIR/base/{ref}`) |
| `control/src/lib/base/secrets.ts` | per-project secrets + HS256 anon/service_role JWTs (jose) |
| `control/src/lib/base/limits.ts` | plan limits (via plans area `baseResourceLimits`) → per-service CPU/memory |
| `control/src/lib/base/settings.ts` | `BaseSettings` (auth/SMTP/providers/authExtra/api/functions/templates/customDomain), patch schema |
| `control/src/lib/base/versions.ts` | pinned upstream image tags (unit-tested against the vendored compose) + mirror prefix |
| `control/src/lib/base/render.ts` | template → `STORAGE_DIR/base/{ref}/` (`.env`, `auth.env`, `functions.env`, `volumes/templates`) |
| `control/src/lib/base/compose.ts` | `docker compose -p lb_{ref}`, health waiting, `docker exec` (psql, pg_dump) |
| `control/src/lib/base/stack.ts` | worker operations: provision/pause/resume/restart/upgrade/settings/delete/backup/restore/studio/functions |
| `control/src/lib/base/service.ts` | **library contract for the dashboard / API / AI agent** (below) |
| `control/src/lib/base/studio.ts` | Studio SSO (one-time token → signed host-only cookie → forward-auth) |
| `control/src/lib/base/usage.ts` | access-log tailer (requests, function invocations, egress, last activity) + SQL gauges → `BaseUsageSample` |
| `control/src/lib/base/routes.ts`, `pages.ts` | DB → Caddy routes, tls-ask, branded pages |
| `control/src/lib/proxy/base.ts` | Caddy JSON for base hosts (additive to `proxy/config.ts`, `state.ts`, `hosts.ts`) |
| `control/src/app/api/internal/base/{page,studio-auth,studio-sso}/route.ts` | Caddy-facing endpoints |
| `control/src/worker/processors/base.ts` | queue `base` + schedules |
| `control/src/lib/base/base.test.ts` | unit tests (secrets/JWT, rendering, routes, cookies, usage parsing, …) |
| `control/tests/base/e2e.sh`, `tests/base/lb.ts` | the end-to-end check used below (`tests/base/e2e.sh <ref>`) |

## Library contract (`import … from "@/lib/base"`)

Long operations are queued (`base` queue) and reported via `BaseProject.status`, `BaseEvent` rows and Redis pub/sub
`BASE_STATUS_CHANNEL` (`"lb:base:status"`, JSON `{ref, status?}` / `{ref, event: {type, level, message}}`).
Errors: `BaseError { code: "NOT_FOUND" | "CONFLICT" | "LIMIT" | "BAD_REQUEST" | "STATE" }`; plan caps throw the plans
area's `PlanLimitError` (→ 402 via `route()`).

```ts
createBaseProject({ teamId, name, dbPassword?, createdById?, projectId?, settings?: BaseSettingsPatch }): Promise<BaseProject>
    // PROVISIONING row + enqueue provision. assertCanCreateProject(teamId,"base") (plans). projectId = owning Deploy
    // project (same team, one backend per project → BaseError CONFLICT). dbPassword: 16–128 letters/digits.
getBaseProject(ref): Promise<BaseProject | null>          listBaseProjects(teamId): Promise<BaseProject[]>
baseProjectForDeployProject(projectId): Promise<BaseProject | null>
toDTO(p): BaseProjectDTO      // no secrets; + url, internalUrl, studioUrl, apiHost, studioHost, settings (publicSettings)
baseKeys(ref): Promise<{ url, internalUrl, anonKey, serviceRoleKey, jwtSecret }>   // service key/jwtSecret: ADMIN+, audit
baseEnvVars(ref, { includeServiceRole? }): Promise<Record<string,string>>
    // SUPABASE_URL = internal http://base-{ref}:8000 (server-side code in LevantDeploy apps)
    // SUPABASE_PUBLIC_URL / NEXT_PUBLIC_SUPABASE_URL / VITE_SUPABASE_URL = public https://{ref}.{BASE_DOMAIN} (browsers)
    // SUPABASE_ANON_KEY / NEXT_PUBLIC_… / VITE_…, optional SUPABASE_SERVICE_ROLE_KEY
connectionStrings(ref, publicHost?): Promise<{ user, poolerUser, password, database, direct, internal /* = direct */,
    pooler: { host, session, transaction } | null, public: string | null, publicHost, publicPort, sslRequired }>
    // direct (host `db`) only inside the stack; pooler = base-{ref}:5432 (session) / :6543 (transaction) as
    // postgres.{ref} for LevantDeploy app containers; public = {publicHost ?? BASE_DB_HOST ?? {ref}.{BASE_DOMAIN}}:{port}
    // ?sslmode=require. Leave publicHost undefined (the API host resolves to the server via the wildcard DNS).
setPublicPort(ref, enabled, byUserId?): Promise<{ port: number | null, jobId }>
    // plan publicDbPort required (PlanLimitError 402); port from BASE_DB_PORT_RANGE (default 54000-54999)
runSql(ref, sql, { role?: "postgres"|"service_role"|"authenticated"|"anon", readOnly?, timeoutMs?, maxRows? })
    : Promise<{ columns, fields: {name}[], rows: Record<string,string|null>[], rowCount, truncated, notices }>
    // psql inside the db container as supabase_admin; role ≠ postgres → BEGIN; SET LOCAL ROLE (RLS applies);
    // readOnly → SET TRANSACTION READ ONLY. Result = last statement's rows (values as strings).
stackAction(ref, action, { byUserId?, service?, versions?, backupId?, confirm? }): Promise<{ jobId, backupId? }>
    // action: pause | resume | restart (service? = db|auth|rest|realtime|storage|imgproxy|meta|functions|api-gw|studio)
    //       | upgrade (versions? partial map, default = this release's DEFAULT_VERSIONS) | delete (confirm: ref required)
    //       | backup (creates the BaseBackup row) | restore (backupId) | studio-start | studio-stop | settings | functions
    // allowed-from-status table in service.ts → BaseError STATE otherwise
updateBaseSettings(ref, patch: BaseSettingsPatch, byUserId?): Promise<{ settings (public), changed: string[], jobId }>
    // validated by baseSettingsPatchSchema; secrets (SMTP pass, provider secrets, function secrets) encrypted at rest;
    // re-render + `compose up -d` → only services whose effective config changed are recreated (verified: auth/URL
    // change recreated exactly api-gw + auth). Unknown top-level keys (dashboard) are preserved.
deployFunction(ref, { slug, name?, source, files?, verifyJwt?, byUserId? }): Promise<{ function, jobId, url }>
deleteFunction(ref, slug, byUserId?)        functionSource(ref, slug): Promise<string | null>
setFunctionSecrets(ref, { KEY: value | null }, byUserId?)   listFunctionSecrets(ref): Promise<string[]>
invokeFunction(ref, slug, { method?, body?, headers?, key?: "anon"|"service_role" }): Promise<{ status, headers, body, durationMs }>
createBackup(ref, byUserId?)  restoreBackup(ref, backupId, byUserId?)  listBackups(ref)  deleteBackup(ref, backupId)
backupFilePath(backup): Promise<string | null>            // absolute path for download streams (.sql.gz)
baseServices(ref) / serviceHealth(ref): Promise<{ service, container, state, health, running, healthy }[]>
baseLogs(ref, service, tail?): Promise<string>
baseLogStream(ref, service, { signal?, tail?, follow?, since? }): Promise<Response>   // SSE in the LogViewer format
baseUsage(ref): Promise<{ dbBytes, storageBytes, mau, egressBytes, invocations, functions, at, dbSizeBytes,
                         storageSizeBytes, month: { requests, functionInvocations, egressBytes }, lastActivityAt, limits }>
issueStudioToken(ref, userId): Promise<{ url, token, expiresIn }>   studioSsoUrl(ref, userId): Promise<string>
    // MEMBER+ only; also enqueues studio-start if Studio isn't running
canOpenStudio(ref, userId), studioRunning(ref)
projectUrl(ref), studioUrl(ref), apiHost(ref), studioHost(ref), internalUrl(ref), baseDomain(), parseBaseHost(host)
syncBaseRoutes()                      // after the dashboard changes settings.customDomain
backupStorageFilePath(backup)         // .storage.tar.gz next to the .sql.gz (download)
baseLimitsForTeam(teamId, overrides?), BASE_PLAN_DEFAULTS, readSettings, publicSettings, baseSettingsPatchSchema,
OAUTH_PROVIDERS, DEFAULT_VERSIONS, ALL_SERVICES, CORE_SERVICES
```

Worker-only (`@/lib/base/stack`): `provision, pause, resume, restart, upgrade, applySettings, destroy, studioStart,
studioStop, studioIdleSweep, runBackup, restoreBackup (by backup id), reloadFunctions, probeGateway`.

### Statuses
`PROVISIONING → ACTIVE`; `ACTIVE → PAUSING → PAUSED → PROVISIONING("Resuming") → ACTIVE`; `ACTIVE → UPGRADING → ACTIVE`;
`ACTIVE → RESTORING → ACTIVE`; anything → `ERROR` (statusMessage = first line, full error + last container logs in a
`BaseEvent` of type `error`) / `DELETING`. From `ERROR`: resume (re-render + up + health), restart, upgrade, restore, pause.
Routing: ACTIVE/UPGRADING/RESTORING → gateway; PAUSED/PAUSING → 503 "Project paused — restore it from the dashboard";
PROVISIONING → 503 "starting" (auto refresh); ERROR → 502 page; Studio only when ACTIVE.

### Dashboard requests (docs/requests/base-dashboard.md) — answered
- `readSettings` keeps unknown top-level keys ✔. `templates` are part of `baseSettingsPatchSchema` (or stored directly):
  bodies are rendered to `volumes/templates/<id>.html`, served by a third gateway listener `:8002` (Envoy
  `direct_response`), `GOTRUE_MAILER_TEMPLATES_<ID>=http://lb_{ref}_api-gw:8002/templates/<id>` + `…_SUBJECTS_<ID>`;
  the gateway is recreated when templates change (`LB_TEMPLATES_HASH`). Verified from inside the auth container.
- `settings.customDomain = { hostname, status: "ACTIVE" }` → routed to the gateway (same upload limit) and allowed by
  tls-ask; call `syncBaseRoutes()` after verify/remove. (Usage metering only counts `{ref}.{BASE_DOMAIN}` traffic.)
- Names: `serviceHealth`, `baseLogStream` (SSE), `studioSsoUrl`, `setFunctionSecrets`/`listFunctionSecrets`,
  `invokeFunction`, `createBackup`/`restoreBackup`/`backupFilePath`, `setPublicPort` (implemented in the follow-up round), `runSql` returns
  `{rows, fields, rowCount, truncated}` (+ columns, notices), `baseUsage` has the flat names. `testSmtp`: not provided —
  use nodemailer with the decrypted `settings.smtp` (`decryptString(passEnc)`).

## Deploy ↔ Base (product decision: a Deploy project can own its backend)
- `BaseProject.projectId String? @unique` → `Project.baseProject` (onDelete SetNull); `createBaseProject({ projectId })`
  checks same team + one backend per project.
- **Internal URL for server-side code**: the gateway joins `levant_net` with the alias `base-{ref}` → apps use
  `SUPABASE_URL=http://base-{ref}:8000` (no TLS, no public DNS round trip; same API, same keys). Browsers / mobile apps use
  `https://{ref}.{BASE_DOMAIN}` (`NEXT_PUBLIC_SUPABASE_URL` …). `baseEnvVars(ref)` returns exactly this split.
- Only the gateway is on `levant_net`: app containers (of any project) reach the API like the public internet would, but
  **never** the database, meta, auth or any other service (verified: names don't resolve, container IPs time out).
  Because the API is public anyway, restricting the alias to the owning project's containers would add no security;
  the DB of other projects is unreachable for everyone.

## Proxy (Caddy) — additions to `syncRoutes()`
- `{ref}.{BASE_DOMAIN}` (+ ACTIVE custom domain) → `request_body.max_size = plan max upload + 1 MB` → `reverse_proxy
  lb_{ref}_api-gw:8000` (flush_interval -1; websockets for realtime are proxied automatically).
- `studio-{ref}.{BASE_DOMAIN}`: `/__levant/sso` → control `/api/internal/base/studio-sso` (redeem one-time token, 60 s,
  single use → cookie `__levant_studio` = `userId.ref.exp.HMAC(SESSION_SECRET)`, host-only, HttpOnly, SameSite=Lax,
  Secure over https, 12 h → 303 `/project/default`); everything else → forward-auth `GET /api/internal/base/studio-auth`
  (cookie signature/expiry/ref + team role ≥ MEMBER re-checked every 30 s; 401 branded page otherwise; 503 "Studio is
  starting" + start enqueued when it isn't running) → `reverse_proxy lb_{ref}_api-gw:8001` with header
  `X-Levant-Studio-Gate: <per-project secret>`. Envoy's `:8001` listener rejects any request without that exact header
  (RBAC 403), so Studio is unreachable without the SSO cookie even from inside levant_net.
- Error route: upstream failures on base hosts → `/api/internal/base/page?state=unavailable` (503, auto refresh).
- tls-ask: base hosts only for existing (non-DELETING) refs; ACTIVE custom API domains.
- `BASE_DOMAIN` env (default `base.{PLATFORM_DOMAIN}`) → wildcard DNS `*.base.example.com` → server.

## Security review of the template (all verified in the sandbox unless noted)
| Check | Result |
|---|---|
| Only the gateway exposed | no `ports:` anywhere; only `api-gw` on levant_net; everything else on `lb_{ref}_net` (`internal: true`) — unit-tested + `docker inspect` |
| `/pg` requires the service key | upstream Envoy RBAC + Lua key check kept: anon key → **403**, empty/invalid key → **401**, service key → **200** |
| Studio not on the API host | upstream `/`, `/mcp`, `/api/mcp` routes removed; `/` → 401/404 |
| Studio gate | `:8001` without/with a wrong `x-levant-studio-gate` → **403 RBAC** (tested from a container on levant_net); via Caddy without cookie / forged cookie / forged gate header → **401** |
| Default passwords never used | every secret random per project; unit test asserts none of them appears in upstream `.env.example`; realtime `DB_ENC_KEY` per project (upstream default `supabaserealtime` not used); envoy basic-auth password random |
| JWT secret unique per project | 64-char random; keys verified to fail with another project's secret (unit test) |
| DB not reachable from other networks | test container on levant_net (= every LevantDeploy app): `lb_{ref}_db`, `db`, `lb_{ref}_meta`, `lb_{ref}_auth` → DNS ENOTFOUND; DB/meta container IPs → TCP timeout; gateway alias `base-{ref}:8000` → reachable (API key required) |
| Upstream DNS hijack via levant_net aliases | the gateway (the only dual-homed container) addresses its upstreams by unique container names `lb_{ref}_<svc>` (cds template), not bare service names |
| Docker socket | never mounted into any base service (unit test) |
| Resource limits | `deploy.resources.limits` on every service (verified with `docker stats`: e.g. db 2.4 GiB / realtime 1.36 GiB caps on the unlimited plan) |
| Egress | only `auth` and `functions` have outbound network (`lb_{ref}_egress`) |
| Files | `.env`, `auth.env`, `functions.env` mode 0600 in a 0700 project dir; secrets encrypted in the DB (`encryptJson`) |

## Verified end to end (one real project through Caddy, HTTPS with Caddy's local CA + on-demand certs via tls-ask)
Driver: `tests/base/e2e.sh <ref>` (curl `--resolve` to 127.0.0.1:443). Final run: **45/45 checks passed**:

- **Provision** (pull + `compose up` + health of db/auth/rest/realtime/storage/imgproxy/meta/functions/api-gw + gateway
  probes of auth/rest/storage/meta): all services healthy ≈ 25 s after start with cached images; a failure (Docker Hub 429
  for the pooler image; functions without egress) ended in `ERROR` with the container logs in the `BaseEvent`, and
  `resume` from ERROR recovered both times.
- **Auth**: signup 200 (autoconfirm on — no SMTP), password login → access token, wrong password 400, no apikey 401,
  `/auth/v1/user` 200.
- **REST + RLS**: table + `auth.uid()` policy created via `runSql`; insert as the user 201, the user sees own rows,
  anon sees 0 rows, anon insert 401, no apikey 401; `runSql(…, { role: "anon" })` sees 0 rows; `readOnly` enforced.
- **Storage**: bucket create, 300 KB upload, byte-identical download, private object refused for anon.
- **Realtime**: websocket upgrade through Caddy → `101 Switching Protocols`.
- **Edge functions**: deploy via `deployFunction` → invoke returns the JSON (`SUPABASE_FUNCTION_SLUG` set); without a JWT
  401 (verify_jwt default on); `invokeFunction()` from the lib 200 in 136 ms.
- **/pg**: anon 403, empty key 401, service key 200; `/` on the API host 401/404 (no Studio).
- **Studio**: no cookie 401 page, forged cookie 401, forged gate header 401; SSO hand-off 303 + cookie (host-only,
  HttpOnly, Secure); token single-use (2nd use 403); Studio started on demand ("starting" page meanwhile) → 200 HTML;
  idle sweep stopped + removed the Studio container.
- **Pause → 503 branded page → resume**: rows and storage objects intact.
- **Backup → insert → restore**: back to the backup state (row added later gone), same auth user can still log in;
  "Backup restored" with 0 warnings (27 KB dump of `auth, public, storage`).
- **Settings apply**: switching to https URLs recreated exactly `api-gw, auth, storage, functions`; an auth/template
  change recreated only `api-gw, auth`; template served to GoTrue (`wget` from the auth container).
- **Upgrade** (same versions — no newer images were pulled, disk), **restart one service** (`rest`), **usage sample**
  (db 12 MB, storage 600 KB, MAU 3, 58 requests, 4 invocations, 1.6 MB egress, `lastActivityAt` from the access log),
  **auto-pause decision** (7-day plan: not now, yes at now+8 d; unlimited plan: never).
- **Quota enforcement** (second project, limits overridden to 1 MB DB / 0.01 MB storage): DB → read-only (PostgREST
  writes 507 `LB507`, SQL writes "cannot execute INSERT in a read-only transaction", reads 200), uploads 507, downloads
  200; relaxed → writes 201 and uploads 200 again; `BaseEvent`s for each switch.
- **Follow-up round, fresh project provisioned with NO outbound internet (egress relay off): 59/59 checks passed** —
  everything above plus: functions reload job waited for; pooler transaction mode (`base-{ref}:6543`) and session mode
  (`:5432`) from a container on levant_net, wrong password refused; public port 54000 enabled (`api-gw` + `pooler`
  recreated), `psql sslmode=require` connects, plaintext refused with `ESSLREQUIRED`, certificate
  `CN = {ref}.base.levant.localhost`, connection string shows `host:port`, disabled → port closed; backup contains a
  storage archive, a file uploaded after the backup is gone after restore while the original is intact.
  Then the same stack re-rendered with Hobby limits (1536 MB / 0.5 CPU, ceilings summing to exactly 1536 MB: db 318,
  realtime 320, storage 243, meta 207, functions 188, gateway 75, imgproxy 75, auth 55, rest 55; idle RSS 12–181 MB each)
  passed the 38 non-lifecycle checks.
  Two robustness fixes came out of it: the gateway probe now needs 4 consecutive successes (Envoy kept a stale
  endpoint of a restarted container in its round robin for ~1 min → alternating 503s after restore), and the functions
  reload waits until the gateway reaches the restarted runtime.
- **Delete** (`stackAction(ref, "delete", { confirm: ref })`): containers, 4 named volumes, both networks and
  `STORAGE_DIR/base/<ref>` removed, row deleted, routes gone (404), tls-ask 404.

## Images (cached for the compat agent)
Left in the local image store (upstream tags, pulled through `mirror.gcr.io` and retagged; ≈ 7.7 GB as listed by
`docker images`): `supabase/postgres:17.6.1.136` 1.69 GB, `supabase/studio:2026.09.07-sha-7996410` 1.69 GB,
`supabase/storage-api:v1.74.0` 1.31 GB, `supabase/edge-runtime:v1.76.2` 1.12 GB, `supabase/postgres-meta:v0.99.0`
569 MB, `supabase/realtime:v2.134.10` 559 MB, `darthsim/imgproxy:v3.31.4` 317 MB, `envoyproxy/envoy:v1.39.1` 293 MB,
`supabase/gotrue:v2.196.0` 93 MB, `postgrest/postgrest:v14.17` 28 MB, and (follow-up round) `supabase/supavisor:2.9.12`.

## Shared-file changes (additive)
- `prisma/schema.prisma`: enums `BaseStatus`, `BaseBackupStatus`; models `BaseProject` (incl. `projectId @unique` →
  Project, onDelete SetNull), `BaseBackup`, `BaseFunction`, `BaseUsageSample`, `BaseEvent`; back-relations
  `Team.baseProjects`, `User.baseProjectsCreated`, `Project.baseProject`.
- `src/lib/queues.ts`: queue `base` + `JobData.base` + default job options (attempts 1).
- `src/lib/env.ts`: `BASE_DOMAIN`, `BASE_IMAGE_MIRROR`, `BASE_TEMPLATE_DIR`, `BASE_EGRESS_PROXY`, `BASE_EGRESS_CA_FILE`.
- `src/lib/proxy/config.ts` (`ProxyState.bases`, routes before the fallback page, error route), `state.ts`
  (`loadBaseRoutes()`), `hosts.ts` (tls-ask for base hosts).

## Requests
- **ops**: the worker image needs `base-stack/template` (e.g. `additional_contexts: base: ./base-stack` +
  `COPY --from=base template /app/base-stack/template`, or set `BASE_TEMPLATE_DIR`), plus `BASE_DOMAIN` in `.env` /
  installer (wildcard DNS `*.base.<domain>`). `STORAGE_DIR` must be the same path inside the worker and on the host
  (already true: `${LEVANT_DATA_DIR}` is bind-mounted at the same path) because compose bind mounts are resolved by the
  host daemon. The worker must stay on the `apps` network (gateway probes); `invokeFunction()` from the control container
  needs it on `apps` too (or call it from the worker). Optional: `BASE_IMAGE_MIRROR=mirror.gcr.io` for Docker Hub 429s.
- **dashboard / plans**: `createBaseProject` and `stackAction(ref, "resume")` already call
  `assertCanCreateProject(teamId, "base")`; `deployFunction` calls `assertCanAddFunction` for new slugs. `PlanLimitError`
  propagates (→ 402 through `route()`).

## Quota enforcement (plans area semantics) — `src/lib/base/enforce.ts`, run after every usage sample
- DB over `dbSizeMb` (enforce.dbSize) → `ALTER DATABASE postgres SET default_transaction_read_only = on` + terminate client
  sessions, **and** Caddy answers PostgREST writes (`POST/PUT/PATCH/DELETE /rest/v1/*`) with 507 — PostgREST opens
  explicit `READ WRITE` transactions, so the DB default alone does not stop it (verified). Reverted below 95 %.
  While read-only, auth writes fail too (sign-ups; logins that update `last_sign_in_at`). Each switch costs one failed
  (503) request per pooled connection that was terminated.
- Storage over `storageMb` (enforce.storage) → Caddy 507 on uploads (`/storage/v1/object|upload|s3/*` POST/PUT/PATCH).
- MAU over / team egress this month over (enforce.mau / enforce.egress) on plans that auto-pause (Hobby) → pause.
- State: `BaseProject.settings.enforcement = { dbReadOnly, uploadsBlocked, at }`; `BaseEvent` type `limits`.
- `stackAction(ref, "resume")` of a PAUSED backend calls `assertCanCreateProject(teamId, "base")` (active backends).

## Follow-up round (pooler, public DB port, storage backups, memory, offline functions)
- **Connection pooler (Supavisor 2.9.12, upstream config)**: runs when the plan includes it (Pro+, i.e. `publicDbPort`)
  or a public port is enabled. It stays on the project network; the gateway forwards TCP `5432` (session) and `6543`
  (transaction) → LevantDeploy app containers use `postgresql://postgres.{ref}:<pw>@base-{ref}:6543/postgres`
  (`connectionStrings(ref).pooler`). The DB itself remains unreachable from levant_net.
- **Public DB port** (`setPublicPort(ref, true|false)`): plan-gated, port from `BASE_DB_PORT_RANGE` (54000-54999),
  rendered as `docker-compose.public.yml` (`${BASE_DB_PORT_BIND:-0.0.0.0}:<port>:5432` on the gateway → pooler session
  mode). TLS: per-project self-signed certificate (CN = `{ref}.{BASE_DOMAIN}`, generated by the pooler container on first
  start, kept in volume `lb_{ref}_pooler-tls`), Supavisor tenant `enforce_ssl = true` while the port is open → plaintext
  is refused (`ESSLREQUIRED`); clients use `sslmode=require` (`verify-full` would need the cert exported — follow-up).
  While public access is on, internal pooler connections need SSL too (the connection strings then include
  `sslmode=require`). **Ops / firewall**: open `BASE_DB_PORT_RANGE` (or single ports) in the server firewall only if
  public DB access should work; Docker-published ports bypass ufw — filter in the `DOCKER-USER` chain or a cloud
  firewall. New env: `BASE_DB_PORT_RANGE`, `BASE_DB_PORT_BIND`, `BASE_DB_HOST`.
- **Backups include storage files**: `tar czf` of the storage volume (through the storage container) next to the dump
  (new columns `BaseBackup.storagePath` / `storageSizeBytes`); restore puts the files back first (storage running), then
  the database. Retention/delete remove both files. `backupStorageFilePath(backup)` for downloads.
- **Memory**: per-service ceilings now sum exactly to the plan's memory (floors + weighted share of the rest; below the
  1344 MB floor sum they are scaled down proportionally). Hobby default changed **1 GB → 1.5 GB** in
  `src/lib/plans/limits.ts` (+ plans unit test updated). `ensureDefaultPlans()` doesn't overwrite existing rows →
  existing installs keep 1024 MB until the owner edits the Hobby plan; 1024 still renders, but every ceiling is ~76 % of
  its floor (OOM risk under load).
- **Functions boot offline**: `jsr:@panva/jose@6` is vendored (`functions/main/_vendor/jose`, npm jose 6.2.12, MIT).
  Verified: a fresh project provisioned and passed the e2e with the sandbox egress relay **off** (no outbound access).
  User functions importing `npm:`/`jsr:` packages still need egress (or `BASE_EGRESS_PROXY`).
- Supavisor needs `RLIMIT_NOFILE=10000` (the image default 100000 crash-loops where the hard limit is lower). The compat
  agent hit and patched the same line in the template concurrently; one copy kept.

## Known limitations / not done
- Tested with Docker 29 / compose v5.1 in the sandbox; the egress relay (`BASE_EGRESS_PROXY=http://172.17.0.1:3128` +
  `BASE_EGRESS_CA_FILE=/root/.ccr/ca-bundle.crt`) is a sandbox-only helper; real servers need neither.
- Backups are logical `pg_dump --clean --if-exists` of the user-relevant schemas (`public`, `auth`, `storage`,
  `supabase_migrations` and any user schema — platform schemas like `realtime`, `vault`, `extensions` are recreated by
  the image) + a tar of the storage files.
- CPU shares are 2× weighted (bursting); Studio (768 MB) and the pooler (256 MB) are on-demand extras outside the plan
  memory.
- Studio's own "Logs" pages are disabled (no Logflare), as in upstream's default compose.
- Usage: egress counts response bytes through Caddy for `{ref}.{BASE_DOMAIN}` only (not custom domains, not Studio).

## Compat requests (docs/requests/compat.md) — round 3
- **Function redeploys replace the directory atomically** (`service.ts › writeFunctionDir`): index.ts + `files` are
  written to `volumes/.fn-staging/<slug>-<rand>` (same filesystem, outside the functions mount), then swapped in with
  renames; files missing from a redeploy disappear. Paths are validated before anything is written (no `..`, no absolute
  paths); `_shared/` and other functions are never touched. Verified live: v1 with `lib/v.ts` + `lib/old.ts` and a
  `../_shared/greet.ts` import → v2 with only `lib/v.ts` → `old.ts` gone, `_shared` intact, both versions answered.
- **One-time ownership fix** (`src/lib/base/ownership.ts`) for projects created before `runSql` ran as postgres:
  supabase_admin-owned objects in public + user schemas (non-public schemas, tables, views, materialized views, foreign
  tables, free-standing sequences, functions/procedures/aggregates, enum/domain/range/composite types) → postgres.
  Never auth/storage/realtime/extensions/vault/… (list `PLATFORM_SCHEMAS`), never extension members, public schema owner
  unchanged. Runs on worker start for every ACTIVE project without `settings.maintenance.ownershipFixedAt` and after a
  resume; new projects are marked fixed at creation. Verified live: 9 legacy objects (schema `levant`, table + serial,
  identity table, view, matview, sequence, enum, domain, function) handed to postgres, `auth.should_stay` untouched,
  `postgres` can `ALTER` afterwards (was "must be owner"), second worker start → no re-run.
