# base-stack — LevantBase per-project stack

LevantBase runs one copy of the official open-source self-hosting stack (github.com/supabase/supabase `docker/`,
Apache-2.0) per Base project. This directory holds:

| Path | What |
|---|---|
| `upstream/` | the upstream `docker/` directory, vendored unchanged (`UPSTREAM.txt` = commit). Reference only — never rendered directly. |
| `template/docker-compose.yml` | our render template, derived from `upstream/docker-compose.yml` |
| `template/volumes/` | files copied from `upstream/volumes/` (`api/envoy`, `db/*.sql`, `functions/{main,hello,deno.jsonc}`, `pooler/pooler.exs`, `snippets/`); three of them are patched (below) |

`control/src/lib/base/render.ts` copies `template/` into `STORAGE_DIR/base/<ref>/`, writes `.env` (compose
interpolation: secrets, URLs, images, resource limits), `auth.env` (extra `GOTRUE_*`: OAuth providers, MFA, hooks) and
`functions.env` (function secrets, per-function JWT opt-out, optional egress proxy), then runs
`docker compose -p lb_<ref> --project-directory STORAGE_DIR/base/<ref> --env-file .env up -d`.
Every change against upstream is marked `LEVANTBASE:` in the files.

## Deviations from upstream (complete list)

### docker-compose.yml
1. **No host port bindings** in the template. Upstream publishes the gateway (`8000`) and the pooler (`5432`, `6543`) on
   the host; we publish nothing. Caddy reaches the gateway over the shared Docker network. The single exception is the
   optional public DB port: `render.ts` then writes `docker-compose.public.yml` (an override added with `-f`) that
   publishes `${BASE_DB_PORT_BIND:-0.0.0.0}:<port>:5432` on `api-gw` (pooler session mode, TLS enforced).
2. **Networks.** Instead of the implicit `default` network:
   - `lb_<ref>_net` — `internal: true` (no outbound internet, unreachable from any other network); every service is on it.
   - `lb_<ref>_egress` — normal bridge, only `auth` (SMTP, OAuth providers) and `functions` (outbound `fetch`) join it.
   - `${LB_PUBLIC_NETWORK}` (= `levant_net`, external) — **only `api-gw`** joins it, with the alias `base-<ref>`.
3. **Container names** `lb_<ref>_<service>` (upstream: fixed `supabase-*`, which would collide between projects). The
   pooler runs as `lb_<ref>_pooler`. `realtime` keeps upstream's `realtime-dev.supabase-realtime` as a network alias on
   the project network (the gateway rewrites the Host header to that literal for tenant parsing — unchanged).
4. **Labels** `levant.managed=true`, `levant.base=<ref>` on every container, network and named volume; json-file log
   rotation (10 MB × 3).
5. **Resource limits** (`deploy.resources.limits.cpus/memory`) on every service from the team's plan
   (`control/src/lib/base/limits.ts` → `LB_CPU_*` / `LB_MEM_*`).
6. **Images** come from `LB_IMAGE_*` (default = upstream's pinned tags, see `control/src/lib/base/versions.ts`), optionally
   behind a registry mirror (`BASE_IMAGE_MIRROR=mirror.gcr.io` → `mirror.gcr.io/supabase/postgres:…`).
7. **Studio** is in profile `studio` (started on demand by the worker, stopped after 30 min idle); `api-gw` no longer
   `depends_on: studio`. `NEXT_TELEMETRY_DISABLED=1`.
8. **Supavisor** is in profile `pooler`, started when the plan includes the pooler (Pro+) or a public DB port is enabled.
   It is not on `levant_net`: the gateway forwards TCP `5432` (session) / `6543` (transaction) to it, so LevantDeploy
   apps connect to `base-<ref>:5432|6543` as `postgres.<ref>`. Additions: a per-project self-signed TLS certificate
   generated on first start (`openssl` in the image, CN = `<ref>.<BASE_DOMAIN>`, named volume `lb_<ref>_pooler-tls`,
   `GLOBAL_DOWNSTREAM_CERT_PATH/KEY_PATH`), `POOLER_ENFORCE_SSL` (true while the DB is public) and
   `RLIMIT_NOFILE=10000` (the image's default 100000 crash-loops on hosts with a lower hard limit).
9. **Storage + database data on named volumes** (`lb_<ref>_storage-data`, `lb_<ref>_db-data`, plus upstream's
   `db-config`, `deno-cache` renamed `lb_<ref>_*`) instead of `./volumes/storage` / `./volumes/db/data` bind mounts;
   `docker compose down -v` removes everything. `imgproxy` mounts the storage volume read-only.
10. **Health checks**: `meta` got one (upstream has none) so provisioning can wait for it; `storage` checks `localhost`
    instead of its own service name. Everything else unchanged.
11. **auth**: `env_file: ./auth.env` (extra `GOTRUE_*` keys; keys in `environment:` still win) and optional
    `HTTP(S)_PROXY` (`BASE_EGRESS_PROXY`, empty by default).
12. **functions**: `env_file: ./functions.env` (function secrets, `LEVANT_NO_VERIFY_JWT`, optional proxy/`DENO_CERT`),
    `./ca` mounted read-only at `/etc/levant-ca`.
13. **storage**: `FILE_SIZE_LIMIT` = the plan's max upload (upstream: fixed 50 MB).
14. **realtime**: `DB_ENC_KEY` is a per-project random 16-char key (upstream falls back to the public default
    `supabaserealtime`).
15. **analytics / vector / logflare** are not used. (The current upstream default compose already moved them to
    `docker-compose.logs.yml`, so nothing had to be removed; `volumes/db/logs.sql` and `_supabase.sql` are kept so the
    database layout stays identical to upstream.) Studio runs with `ENABLED_FEATURES_LOGS_ALL=false` as upstream.
16. **No `ports`, no `docker.sock`** mount anywhere (upstream's optional vector service mounts the socket; not used).
17. **db**: one extra init script `volumes/db/graphql.sql` (→ `/docker-entrypoint-initdb.d/migrations/99-graphql.sql`)
    runs `create extension if not exists pg_graphql` so `/graphql/v1` works on new projects like on hosted projects
    (upstream's image ships the extension disabled → "pg_graphql extension is not enabled"). Found by the compat suite.

### volumes/api/envoy (the API gateway)
- `lds.template.yaml`: removed the upstream routes `/api/mcp`, `/mcp` and the catch-all `/` → Studio (behind HTTP basic
  auth). The public API host therefore serves only the API paths (`/auth/v1`, `/rest/v1`, `/graphql/v1`,
  `/realtime/v1`, `/storage/v1`, `/functions/v1`, `/pg` with the service key, OAuth well-knowns); anything else → 404.
  Added a second listener `studio_gate` on `:8001` → Studio, which requires the header `x-levant-studio-gate` to equal
  the per-project `LB_STUDIO_GATE_SECRET` (Envoy RBAC; header stripped before forwarding). Only Caddy, after the SSO
  forward-auth, adds it.
- Two TCP listeners `:5432` / `:6543` (`tcp_proxy`, no idle timeout) → clusters `pooler_session` / `pooler_tx`
  (`lb_${LB_REF}_pooler`). The Postgres protocol including TLS passes through untouched (Supavisor terminates TLS).
- A third HTTP listener `:8002` serves the dashboard's e-mail templates to GoTrue (`direct_response` files).
- `cds.yaml` → `cds.template.yaml`: upstream clusters address `auth`, `rest`, … by service name; we address them by the
  unique container name `lb_${LB_REF}_<service>` so that nothing on `levant_net` (the gateway's second network) can
  shadow an upstream via a network alias.
- `docker-entrypoint.sh`: also substitutes `${LB_STUDIO_GATE_SECRET}` in the listener template, renders
  `cds.template.yaml` with `LB_REF`, and refuses to start without `LB_REF` / a 32+ char gate secret.

### volumes/pooler/pooler.exs
- Tenant gets `enforce_ssl` from `POOLER_ENFORCE_SSL`, and an existing tenant is updated on every start (upstream only
  creates it once).

### volumes/functions/main/index.ts
- `jsr:@panva/jose@6` is replaced by a vendored copy (`main/_vendor/jose/`, npm `jose` 6.2.12 webapi build — same
  library and author, MIT, see `VENDORED.txt`) so the edge runtime boots on servers without outbound internet
  (upstream downloads it from jsr.io at first start). When updating upstream, re-vendor the matching jose version.
- Per-function JWT opt-out: requests for a function slug listed in `LEVANT_NO_VERIFY_JWT` skip the global
  `VERIFY_JWT` check (upstream TODO "Allow configuring VERIFY_JWT per function"). Everything else is upstream's router.

### Not copied
`volumes/api/kong*` (Kong gateway — we use upstream's default Envoy), `volumes/logs/vector.yml`, `volumes/proxy/*`
(Caddy/nginx front proxies — LevantDeploy's Caddy is the front proxy), `volumes/db/init/data.sql` (not mounted upstream
either), the alternative compose files (`docker-compose.{caddy,nginx,kong,s3,rustfs,pgbouncer,logs,pg15,pg17}.yml`) and
the helper scripts (`setup.sh`, `run.sh`, `reset.sh`, `update.sh`, `utils/`).

## Secrets
Generated per project at creation (`control/src/lib/base/secrets.ts`), stored encrypted in `BaseProject.secretsEnc`,
never upstream's example values: `POSTGRES_PASSWORD` (40 alnum), `JWT_SECRET` (64 alnum), `ANON_KEY` /
`SERVICE_ROLE_KEY` (HS256 JWTs, `iss: levantbase`, `ref`, 10-year expiry), `SECRET_KEY_BASE` (64), `VAULT_ENC_KEY` (32),
`PG_META_CRYPTO_KEY` (48), `REALTIME_DB_ENC_KEY` (16), S3 protocol keys, `DASHBOARD_PASSWORD` (unused, random),
`LB_STUDIO_GATE_SECRET` (48), dummy Logflare tokens. The rendered `.env`, `auth.env`, `functions.env` are mode 0600.

## Updating to a newer upstream commit
1. Re-vendor: replace `base-stack/upstream/` with the new upstream `docker/` directory and update `UPSTREAM.txt`.
2. Diff against the old upstream to see what changed:
   `git diff --no-index <old-upstream>/docker-compose.yml base-stack/upstream/docker-compose.yml` and the same for
   `volumes/api/envoy/*`, `volumes/db/*.sql`, `volumes/functions/main/index.ts`, `volumes/pooler/pooler.exs`
   (also read upstream `CHANGELOG.md` / `versions.md`).
3. Port the changes into `template/` keeping every `LEVANTBASE:` deviation above (new env vars → `buildEnv()` in
   `control/src/lib/base/render.ts`; new services → template + `CORE_SERVICES` in `config.ts` + health wait).
   For the Envoy listener: re-apply the removal of the Studio routes and re-append the `studio_gate` listener; for
   `cds.yaml`: re-apply the `lb_${LB_REF}_<service>` addresses.
4. Bump the image tags in `control/src/lib/base/versions.ts` (`DEFAULT_VERSIONS`). The unit test
   `src/lib/base/base.test.ts › versions match the vendored upstream compose file` fails until both agree, and
   `renders every variable the template references` fails if the template uses a variable `buildEnv()` doesn't set.
5. `cd control && npx vitest run src/lib/base && npx tsc --noEmit`, then provision a test project and run the e2e checks
   from `docs/requests/base-runtime.md`.
6. Existing projects keep their stored versions (`BaseProject.versions`) until upgraded:
   `stackAction(ref, "upgrade")` (→ current defaults) or `stackAction(ref, "upgrade", { versions: { db: "…" } })`.
   Major Postgres upgrades (e.g. 15 → 17) need upstream's `utils/upgrade-pg17.sh` procedure, not an image bump.
