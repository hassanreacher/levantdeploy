# Ops area — notes, contracts & requests

## What ops ships

| path | |
|---|---|
| `docker-compose.yml` (root) | production stack: postgres, redis, control (`web`), worker, caddy; networks `internal` + `apps` (fixed name `${DOCKER_NETWORK:-levant_net}`) |
| `control/Dockerfile`, `control/.dockerignore`, `control/docker-entrypoint.sh` | one image (Ubuntu 24.04 + Node 22, non-root uid 1000 `levant`): `web` = migrations + `node server.js`, `worker` = `node dist/worker.js`, `migrate` |
| `control/scripts/build-worker.mjs` (+ `empty-module.cjs`) | esbuild bundle of the worker → `dist/worker.js` (all `src/worker/processors/*.ts` imported statically; npm packages external) |
| `control/scripts/regen-initial-migration.sh`, `control/prisma/migrations/0001_init` | initial migration (generated from the schema at the time ops ran) |
| `install/` | `install.sh`, `update.sh`, `backup.sh`, `restore.sh`, `uninstall.sh`, `env.example`, `caddy/` (base config + entrypoint) |
| `src/lib/ops/*`, `src/worker/processors/ops.ts`, `/api/v1/platform/**`, `src/app/(dashboard)/settings/**` | platform settings (owner only): General, Limits, Build *(slot)*, Email, Backups, Updates |
| `src/app/page.tsx`, `src/components/landing/landing.tsx` | public landing at `/` when signed out |
| `README.md`, `docs/INSTALL.md`, `docs/DOMAINS.md`, `docs/USAGE.md`, `docs/DEPLOY-LEVANTCART.md` | owner docs |

## Changes to shared files (small, additive)

* `src/lib/settings.ts` — new keys: `platform.serverIps`, `smtp`, `backups.control`, `updates.checkUrl`
  (`uploads.maxSizeMb` is the git area's key; ops' Limits page edits it).
* `src/lib/queues.ts` — new queue `ops` (`JobData.ops = { kind: "control-backup" | "update-check"; byUserId? }`).
* `src/lib/email.ts` — `sendMail()` now uses `resolveSmtp()` (Settings → Email wins over env `SMTP_*`). Same API.
* `src/middleware.ts` — `/` is public (signed-out visitors get the landing page; `page.tsx` still redirects signed-in users to their team).
* `src/components/shell/user-menu.tsx` — "Platform settings" item when `user.isPlatformOwner` (TopNav already passes the full session user).
* `src/app/(auth)/layout.tsx` — logo links to `/`, footer link "Home".
* `control/.gitignore` — `dist/`.

## Contracts other areas rely on

* **Same-path data dir**: `${LEVANT_DATA_DIR:-/var/lib/levantdeploy}` is bind-mounted at the same absolute path in control + worker;
  `STORAGE_DIR=$LEVANT_DATA_DIR/storage`, `WORK_DIR=$LEVANT_DATA_DIR/work`. Paths given to the Docker daemon (build contexts,
  compose bind mounts, `docker run -v`) are therefore valid host paths. Containers run as uid 1000 with the docker socket's gid
  (`DOCKER_GID`) added.
* **Worker image tooling**: `docker` CLI 28 + buildx + compose plugins, `git`, `openssh-client`, `pg_dump` 16, `tar`, `gzip`.
  `HOME=/home/levant`, `DOCKER_CONFIG=/home/levant/.docker` (writable). No `curl` (use Node `fetch`).
* **Caddy**: admin API at `http://caddy-admin:2019` — the alias exists only on the internal network, so app containers on
  `levant_net` cannot reach it. Env passed to control + worker for the runtime proxy builder: `CADDY_ADMIN_URL`,
  `CADDY_ADMIN_LISTEN=caddy-admin:2019` (keeps the admin listener private after `/load`), `CONTROL_UPSTREAM=control:3000`,
  `PROXY_TLS=$TLS_MODE`, `ACME_EMAIL`, `CADDY_LOG_DIR=/var/log/caddy` (Caddy side), `CADDY_ACCESS_LOG=/var/log/levant-caddy/access.log`
  (worker side, shared volume `caddy_logs`, read-only), `SERVER_IPS`.
  Caddy starts with `--resume`: the last config pushed by `syncRoutes()` survives restarts; until the first sync it serves the
  ops base config (dashboard route + branded 404, on-demand TLS policy). If the rendered base changes (new dashboard host / TLS
  mode) the autosave is discarded — the worker must re-sync on start (it does: `onWorkerStart`).
* **Schema sync at start** (`LEVANT_DB_SYNC`, default `auto`): `prisma migrate deploy`, then — only if the DB still differs from
  `schema.prisma` — a non-destructive `prisma db push`. So installs work even when the initial migration lags behind the schema.
  **Lead: run `control/scripts/regen-initial-migration.sh` once the schema is final for the release.**

## Requests

### runtime
1. DONE by ops (runtime agent had finished): `mode: "0644"` added to the `levant_access` writer in `src/lib/proxy/config.ts` —
   Caddy created the access log `0600` (root), so the uid-1000 worker could not tail it through the shared volume (verified).
2. Server IPs: Settings → General stores `platform.serverIps` (`{ ipv4, ipv6 }`, owner-editable + auto-detect). Please read it
   (falling back to env `SERVER_IPS`) where you show A-record targets / verify domains.
3. Docs reference `POST /api/v1/projects/:id/domains` `{ hostname }` (adding a domain with an API token, scope `domains:write`)
   and a database "public port" toggle — keep those names or tell ops to adjust `docs/USAGE.md` / `docs/DEPLOY-LEVANTCART.md`.
4. Wildcard project domains (`*.shop.com` routed to one project, on-demand certs per subdomain) are rejected by
   `domains/validate.ts`. Multi-tenant apps like LevantMart need them; the guide currently says "add each store hostname via the API".

### build
* Platform Settings has a **Build** slot at `src/app/(dashboard)/settings/build/page.tsx` (placeholder card inside the settings
  layout — no `PageHeader`). Replace it with the build proxy / CA / registry form. `build.concurrency` and `build.timeoutMinutes`
  are edited on the **Limits** page (ops) — please read them from settings.

### git+cli
* `uploads.maxSizeMb` is edited in Settings → Limits (1–2047 MB, your schema).

### foundation / lead
* `requirePlatformOwner()` is used for `/api/v1/platform/**`; the `/settings` layout returns 404 to non-owners.
* `settings` is already in `RESERVED_TEAM_SLUGS`, so `/settings` never collides with a team.

## Verification (real, this sandbox)
* `docker compose -p levantops` build + up on 8080/8443 (`TLS_MODE=internal`, domain `ops.test`, network `ops_levant_net`),
  then a second time **through `install/install.sh` itself** (scratch `--dir/--data-dir`, `--skip-docker --no-firewall
  --no-backup-cron`): migrations, health, owner created through the API, summary printed. Stack came back by itself after a
  Docker daemon restart (restart policies).
* Through Caddy (`curl --resolve`, Chromium with host-resolver rules): landing, login, all Settings pages (HTTP/2 + h3 alt-svc,
  :8080 → 308 https), Back up now (worker `pg_dump` → file listed/downloadable), validation errors.
* CLI installed from `GET /api/cli/levant.tgz`, then `levant deploy --prod` of `examples/static-html`, `examples/node-express`
  (needs the build proxy setting with `network: "host"` in this sandbox) and `examples/compose-app` → Ready, served with valid
  TLS from Caddy's CA via on-demand certs; unknown hosts get no certificate; redeploy/supersede works.
* Isolation: an app container cannot resolve/reach `caddy-admin:2019`, Caddy's admin port, or Postgres.
* `bash -n` + shellcheck 0.11 clean on all scripts; `npx tsc --noEmit` clean; `npm test` 170/170.

## Found issues for other areas
* **build/git+cli/runtime**: `examples/compose-app` deployed with the CLI is detected as "Docker Compose" in the build log but
  runs as ONE container (`levant_ops-compose_*_1`, no redis service → app prints "redis unavailable"). The CLI-created
  project keeps `kind` WEB, so runtime deploys it as a single image. Compose detection should set the project kind (or the
  runtime should honour `meta.build.composeSpecEnc` regardless of kind).
* **build**: no UI/API yet for `build.proxy` (Settings → Build slot is still the ops placeholder); `network: "host"` is required
  for proxies on 127.0.0.1. I set it directly in the DB for the test.
* Docker Hub rate-limits (429) hit base-image resolution in this sandbox; the ops sandbox override used `mirror.gcr.io`
  build args (`NODE_IMAGE`, `UBUNTU_IMAGE`, `DOCKER_CLI_IMAGE`, `CADDY_IMAGE`) — production defaults stay on Docker Hub.

## Round 2 — LevantBase (backend projects)
* Image: `base-stack/` copied in via named build context `basestack` (compose `additional_contexts`; plain
  `docker build ./control` falls back to an empty stage) → `/app/base-stack/{template,upstream}`, `BASE_TEMPLATE_DIR=/app/base-stack/template`.
* Compose: `BASE_DOMAIN`, `BASE_IMAGE_MIRROR`, `BASE_EGRESS_PROXY`, `BASE_EGRESS_CA_FILE`, `BASE_DB_PORT_RANGE` (54000-54999)
  passed to control + worker; **control now joins `apps`** (invokeFunction); worker stays on `apps`.
* Installer: `--base-domain` (default `base.<domain>`), `--base-db-ports` (ufw opens the range; persisted as
  `BASE_DB_PUBLIC_PORTS=1`), `--prefetch-base-images`, `--base-image-mirror`, `--base-egress-proxy`, `--base-egress-ca`
  (copied to `$DATA_DIR/base-egress-ca.pem` so the path is valid in the worker and for the host daemon). Prints the extra
  DNS record `*.<base domain>` (A or CNAME).
* `install/base-images.sh list|pull|fingerprint` reads the pinned images from `control/src/lib/base/versions.ts`
  (DEFAULT_VERSIONS), applies the mirror rule of `imageRef()`. `update.sh` pulls them when the fingerprint changes.
* Docs: README (one product: apps + built-in backend), INSTALL (flags, DNS, sizing, env table, updates), DOMAINS (backend wildcard,
  one-label wildcard rule, Cloudflare, public DB ports). README links `docs/BASE.md` (compat area, not written yet).
* Verified: control image built with the sandbox proxy/CA/mirror args (template + upstream present, worker bundle includes the
  base processor, uid 1000 with only the docker group), `docker compose config` OK, `bash -n` + shellcheck clean on all
  install scripts, `npx tsc --noEmit` clean; images removed afterwards.
* Request (base-runtime): `BASE_DB_PORT_RANGE` is now in the env of control/worker but nothing reads it yet — use it when
  `setPublicPort` gets implemented (and add it to `env.ts`).

## Round 3 — AI Builder
* Image: `builder-template/` via named context `buildertemplate` → `/app/builder-template` (`BUILDER_TEMPLATE_DIR`); the agent prompts
  (`src/lib/builder/agents/prompts/**`, incl. `docs/`) are copied to `/app/src/lib/builder/agents/prompts`, which `prompts.ts` resolves
  via `<cwd>/src/lib/builder/agents/prompts` (cwd `/app` for both web and worker). Verified inside the image.
* `builder-template/.dockerignore` (added by ops): `**/node_modules`, `**/.next`, `**/.levant` — keeps both the control image and
  `runtime/build.sh` contexts small.
* `control/.dockerignore`: now also excludes `storage*` and `tests` — other agents' `storage-*` test dirs had grown the context to 296 MB
  (now 4 MB). Installer copy excludes them too.
* `install/builder-image.sh ensure|build|fingerprint` builds `levant/builder-runtime:next15` with `builder-template/runtime/build.sh`
  (fingerprint = runtime/ + next15 package.json/pnpm-lock/.npmrc, stamp `.builder-image`). Installer runs `ensure` (skip with
  `--skip-builder-image`; failure only warns); `update.sh` runs `ensure`. Build proxy for the platform's own images:
  `--build-proxy`, `--build-ca` (copied to `<install>/.build-ca.pem`), `--build-node-image` → saved as `LEVANT_BUILD_*` in `.env`.
* Compose: `BUILDER_RUNTIME_IMAGE`, `BUILDER_PREVIEWS`, `BUILDER_PREVIEW_IDLE_MIN`, `BUILDER_PREVIEW_MEMORY_MB`, `BUILDER_EGRESS_*` and the
  AI provider keys (empty pass-through). `env.example` lists the provider keys empty. Installer summary: "Add your AI provider keys in
  Settings → AI providers". `BUILDER_HOST_STORAGE_DIR` is not needed: STORAGE_DIR is the same path on the host.
* Docs: README (Builder feature), INSTALL (flags, sizing: runtime image ~1.2 GB, ~300–600 MB RAM per running preview, update behaviour,
  env table), DOMAINS (`preview-{id}.<domain>` covered by `*.<domain>`).
* Verified: control image build (sandbox proxy/CA/mirror args), template + library + prompts inside, `docker compose config`, `bash -n` +
  shellcheck clean. `install/builder-image.sh ensure` was exercised for real but the runtime image export hit ENOSPC (the disk had
  < 1 GB free from other activity at that moment); the script logic/flags worked up to the docker build. Images + build cache removed.
