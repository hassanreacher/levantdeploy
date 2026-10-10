# Installing LevantDeploy

LevantDeploy runs as one Docker Compose stack on a single Linux server. The installer takes a fresh VPS to a running
platform with HTTPS in about five minutes.

## Requirements

| | minimum | recommended |
|---|---|---|
| OS | Ubuntu 22.04 / 24.04 LTS, Debian 12 (x86_64 or arm64) | Ubuntu 24.04 |
| CPU / RAM | 1 vCPU / 2 GB | 2–4 vCPU / 4–8 GB (Next.js builds use ~1.5 GB; each LevantBase backend idles at ~650 MB) |
| Disk | 20 GB | 40 GB+ (images, build cache, database backups; the backend images are ~3 GB, the AI Builder runtime image ~1.2 GB) |
| AI Builder previews | | each running preview uses ~300–600 MB RAM (capped at `BUILDER_PREVIEW_MEMORY_MB`, default 2 GB); idle previews stop after 20 min |
| Network | public IPv4, ports **80** and **443** (TCP + UDP) reachable | |
| DNS | a domain where you can create an A record and a **wildcard** A record | |

Nothing else needs to be installed: the installer adds Docker Engine + the compose plugin if they are missing.
Do not run another web server on ports 80/443 (stop nginx/apache first).

## 1. Install

Copy the release to the server (or `git clone` it) and run, as root:

```bash
sudo bash install/install.sh --domain example.com --email you@example.com
```

Without flags the installer asks for the values interactively. One-line install from a hosted release:

```bash
curl -fsSL https://<your-host>/install.sh | sudo bash -s -- \
  --source https://<your-host>/levantdeploy.tar.gz --domain example.com --email you@example.com
```

### Options

| flag | default | meaning |
|---|---|---|
| `--domain` | *(asked)* | platform domain — apps get `{project}.example.com`, previews `{project}-{id}.example.com` |
| `--dashboard-host` | `deploy.<domain>` | hostname of the dashboard + API (can be on another domain) |
| `--email` | *(asked)* | Let's Encrypt contact; also the owner account's email |
| `--owner-email`, `--owner-name`, `--owner-password` | email / `Owner` / prompted | first account (platform owner). `LEVANT_OWNER_PASSWORD` env works too. Non-interactive runs without a password generate one and print it once. |
| `--no-owner` | | skip; the first account registered in the browser becomes the owner |
| `--source` | the checkout the script is in | local path, git URL or `.tar.gz`/`.zip` URL |
| `--dir` | `/opt/levantdeploy` | install directory (compose project, `.env`, scripts, source) |
| `--data-dir` | `/var/lib/levantdeploy` | storage (logs, uploads, backups) and build workspaces |
| `--tls` | `acme` | `acme` public certificates · `internal` Caddy's own CA (testing, no public DNS) · `off` plain HTTP |
| `--http-port`, `--https-port` | 80 / 443 | host ports of the edge proxy |
| `--ip` | auto-detected | public IPv4 shown in the DNS instructions |
| `--base-domain` | `base.<domain>` | LevantBase backends: API at `{ref}.<base domain>`, Studio at `studio-{ref}.<base domain>` |
| `--base-db-ports` | off | allow public Postgres ports for backends: opens `BASE_DB_PORT_RANGE` (54000-54999) in ufw |
| `--prefetch-base-images` | off | pull the pinned backend images (~3 GB) during install so the first backend starts in seconds |
| `--base-image-mirror` | — | registry mirror for those images, e.g. `mirror.gcr.io` (Docker Hub rate limits) |
| `--base-egress-proxy`, `--base-egress-ca` | — | outbound proxy (+ its CA, copied into the data dir) for backends on servers behind a proxy |
| `--skip-builder-image` | off | don't build the AI Builder preview runtime image `levant/builder-runtime:next15` during install (build later: `install/builder-image.sh build`) |
| `--build-proxy`, `--build-ca`, `--build-node-image` | — | proxy / CA / Node base-image mirror for building the platform's own images (saved for updates) |
| `--skip-docker`, `--no-firewall`, `--no-backup-cron`, `--no-start`, `--force-os`, `-y` | | self-explanatory |

The installer is **idempotent**: run it again with different flags (e.g. a new `--domain`) to reconfigure. Existing
secrets, data and accounts are kept.

### What it does

1. checks the OS, RAM and disk; installs `curl git openssl gnupg unzip` if missing
2. installs Docker Engine + buildx + compose plugin from `download.docker.com` (unless present)
3. copies the source to `/opt/levantdeploy`
4. writes `/opt/levantdeploy/.env` (mode 600) — generates `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `ENCRYPTION_KEY`,
   `SESSION_SECRET` with `openssl rand` **once** (re-runs never rotate them)
5. creates `/var/lib/levantdeploy/{storage,work,backups}` (owned by uid 1000, the container user)
6. firewall: `ufw allow` SSH (detected port), 80/tcp, 443/tcp, 443/udp, then enables ufw
7. installs `/etc/cron.d/levantdeploy-backup` (nightly `backup.sh`, keeps 7)
8. builds the images and starts the stack, waits until the dashboard is healthy (database migrations run automatically)
9. builds the AI Builder preview runtime image (`install/builder-image.sh ensure`, skipped with `--skip-builder-image`)
10. creates the owner account through the registration API (the first account becomes **platform owner**)
11. prints the DNS records and the login URL — then add your AI provider keys in **Settings → AI providers**

## 2. DNS

Create these records pointing at the server (details, Cloudflare and custom domains: [DOMAINS.md](DOMAINS.md)):

```
A   deploy.example.com   →  203.0.113.10
A   *.example.com        →  203.0.113.10
A   *.base.example.com   →  203.0.113.10     (LevantBase backends; a CNAME to deploy.example.com works too)
```

`*.example.com` does **not** cover `x.base.example.com` (a wildcard matches one label only) — the third record is required
for backends.

Certificates are requested automatically on the first HTTPS request to each hostname.

## 3. First login

Open `https://deploy.example.com` and log in with the owner account. Then:

* **Platform Settings** (avatar menu → *Platform settings*, owner only): server IP + DNS records, registration
  (invite-only by default), build limits, SMTP for emails, control-database backups, updates.
* **New Project** → import from GitHub (create the GitHub App from the dashboard in one click), a Git URL, or deploy
  from your PC with the CLI — see [USAGE.md](USAGE.md).

## What runs where

```
/opt/levantdeploy/
  .env                      configuration + secrets (chmod 600)
  docker-compose.yml        the stack
  control/                  dashboard/API/worker source (built into the levantdeploy/control image)
  install/                  install.sh update.sh backup.sh restore.sh uninstall.sh, caddy/ image
/var/lib/levantdeploy/
  storage/                  build/runtime log archives, uploads, compose files, control-DB dumps (storage/backups/control)
  work/                     build workspaces (temporary)
  backups/                  install/backup.sh output
```

| container | role |
|---|---|
| `postgres` | control-plane database (volume `pgdata`) |
| `redis` | queues, live logs, cache (AOF persistence, volume `redisdata`) |
| `control` | dashboard + REST API (internal only — reached through Caddy) |
| `worker` | builds (docker CLI + buildx), deploys, domain checks, cron, metrics, backups; renders and runs each LevantBase backend as its own compose project `lb_{ref}` |
| `caddy` | edge proxy on 80/443 (+HTTP/3), on-demand TLS; admin API only on the internal network |

Networks: `internal` (control plane, never joined by apps) and `levant_net` (fixed name — every deployed app container
joins it; Caddy proxies to them). The data directory is mounted at the **same path** inside `control` and `worker`, so
paths handed to the Docker daemon (build contexts, compose bind mounts) resolve identically on the host.

Local customisations go into `/opt/levantdeploy/docker-compose.override.yml` (merged automatically by
`docker compose`, never overwritten by the installer or updates) — e.g. build args for a corporate proxy, resource limits.

No systemd unit is needed: Docker starts on boot and every service has `restart: unless-stopped`.

## Everyday operations

```bash
cd /opt/levantdeploy
docker compose ps                         # status
docker compose logs -f control worker     # logs
docker compose restart worker             # restart one service
sudo install/update.sh                    # update (backs up the DB first)
sudo install/backup.sh                    # full backup now (DB + storage + .env), keeps 7
sudo install/restore.sh /var/lib/levantdeploy/backups/levantdeploy-20260101-024100
sudo install/uninstall.sh [--apps] [--purge]
```

### Updates

`install/update.sh` takes a database backup, fetches the new source (`git pull` in a git checkout, or
`--source <path|url>`), rebuilds the images and recreates the containers. When a release pins new LevantBase versions it
pre-pulls those images (`install/base-images.sh pull`); existing backends keep running their versions until you upgrade
them from the dashboard. The AI Builder runtime image is rebuilt only when its template changed
(`install/builder-image.sh ensure` compares a fingerprint; running previews are recreated on the new image). Migrations run when `control` starts.
Deployed apps are separate containers and keep serving traffic during the update. **Settings → Updates** shows the
running version and whether a newer one is available (configure a version URL there or `LEVANT_UPDATE_URL` in `.env`).

Using prebuilt images instead of building on the server: set `LEVANT_PULL=1`, `LEVANT_IMAGE`, `LEVANT_CADDY_IMAGE`
and `LEVANT_VERSION` in `.env`.

### Backups

| what | how | where |
|---|---|---|
| Control database | Settings → Backups (schedule, keep N, *Back up now*, download) — `pg_dump` by the worker | `storage/backups/control/*.dump` |
| Full (DB + storage + `.env`) | `install/backup.sh` (nightly via cron) | `/var/lib/levantdeploy/backups/levantdeploy-*/` |
| App databases | project → Databases → Backups | `storage/…` (runtime area) |

Copy backups off the server (e.g. `rclone`, `restic`, `rsync`) — a backup on the same disk does not survive a lost
server. The `.env` in a full backup contains `ENCRYPTION_KEY`; without it encrypted env vars and database credentials
cannot be decrypted. Restore onto a new server: install with `--no-start`, then
`sudo install/restore.sh <backup dir> --with-env`.

### Changing the domain

```bash
sudo bash /opt/levantdeploy/install/install.sh --domain new-domain.com --dashboard-host deploy.new-domain.com
```

Update DNS first. Existing deployment URLs move to the new domain; custom domains are unaffected.

## Configuration reference (`.env`)

See [`install/env.example`](../install/env.example). Notable keys:

| key | |
|---|---|
| `PLATFORM_DOMAIN`, `DASHBOARD_HOST`, `APP_URL`, `PLATFORM_SCHEME` | URLs (written by the installer) |
| `TLS_MODE` | `acme` \| `internal` \| `off` (passed to Caddy and to the route builder as `PROXY_TLS`) |
| `ACME_EMAIL` | certificate contact |
| `HTTP_PORT`, `HTTPS_PORT` | host ports |
| `SERVER_IPS` | public IPs (DNS instructions + domain verification) |
| `REGISTRATION` | `invite` (default) or `open`; also editable in Settings → General |
| `LEVANT_DB_SYNC` | `auto` (migrations, then a non-destructive `db push` if needed) \| `migrate` \| `push` |
| `DOCKER_GID` | group of `/var/run/docker.sock` on the host (the containers run as uid 1000 and need it) |
| `WORKER_CONCURRENCY` | parallel jobs per queue (build concurrency is also in Settings → Limits) |
| `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, … | optional AI provider keys (empty by default). Prefer **Settings → AI providers** (stored encrypted); env values are a fallback |
| `BUILDER_RUNTIME_IMAGE`, `BUILDER_PREVIEWS`, `BUILDER_PREVIEW_IDLE_MIN`, `BUILDER_PREVIEW_MEMORY_MB`, `BUILDER_EGRESS_*` | AI Builder previews |
| `BASE_DOMAIN` | LevantBase domain (default `base.<PLATFORM_DOMAIN>`) |
| `BASE_IMAGE_MIRROR`, `BASE_EGRESS_PROXY`, `BASE_EGRESS_CA_FILE` | backend image mirror / outbound proxy (+ CA file inside the data dir) |
| `BASE_DB_PORT_RANGE`, `BASE_DB_PUBLIC_PORTS` | host ports for public Postgres connections (plan-gated) and whether ufw opens them |
| `SMTP_*` | email (or Settings → Email) |

## Troubleshooting

| symptom | check |
|---|---|
| installer stops at "waiting for the dashboard" | `docker compose logs control` — usually the database (wrong `POSTGRES_PASSWORD` after editing `.env` by hand) |
| browser shows a certificate error | DNS not pointing at the server yet, or port 80/443 blocked by a cloud firewall (security group). `docker compose logs caddy` shows ACME errors. |
| `permission denied … docker.sock` in worker logs | `DOCKER_GID` in `.env` must equal `stat -c %g /var/run/docker.sock`; re-run the installer |
| builds fail with "no space left" | `docker system df`; the cleanup job removes old images, `docker builder prune` frees the build cache |
| "This deployment could not be found" page | the hostname has no deployment (check the project's domains) |
| forgot the owner password | use *Forgot password* — without SMTP the reset link is printed in `docker compose logs control` |

Testing on a machine without public DNS: `--tls internal --http-port 8080 --https-port 8443`, then
`curl -k --resolve deploy.example.test:8443:127.0.0.1 https://deploy.example.test:8443/api/health`.
