# LevantDeploy

**Deploy anything to your own server — with a built-in backend.** LevantDeploy is one self-hosted product for your
apps *and* their backends: push to GitHub (or any Git remote, or run `levant deploy` from your PC) and your app is built,
started and served on its own URL with automatic HTTPS; create a **LevantBase** backend project next to it and get a
Postgres database with Auth, an instant REST API, Realtime, Storage, Edge Functions and a database Studio — on a VPS you
control.

Unlike serverless platforms every deployment is a **long-running Docker container** (or a docker-compose stack), so
any language or framework works, and so do WebSockets, background workers, cron jobs and databases.

| | |
|---|---|
| Git push to deploy | GitHub App (push + pull-request previews) or any Git URL with a deploy key |
| Preview deployments | every deployment gets `https://{project}-{id}.your-domain`, every branch `{project}-git-{branch}.your-domain` |
| Any stack | Next.js, Nuxt, SvelteKit, Remix, Astro, Vite/static, Node, Bun, Deno, Python, PHP/Laravel, Go, Rust, Ruby, Java, .NET, Elixir — or your Dockerfile / docker-compose.yml |
| Domains | custom domains, `www` redirects, certificates issued on demand (Let's Encrypt / ZeroSSL) |
| Zero-downtime + rollback | health-checked switch, previous releases kept for instant rollback |
| Built-in backend (LevantBase) | per project: Postgres + Auth + REST/GraphQL + Realtime + Storage + Edge Functions + Studio at `https://{ref}.base.your-domain`, built from the open-source self-hosting stack — works with the standard `supabase-js` client; connect it to a project in one click (env vars injected) |
| Databases | Postgres, MySQL, Redis, MongoDB add-ons with backups; connection URLs injected as env vars |
| Workers & cron | worker processes, scheduled commands or HTTP pings |
| Env vars | per environment (production / preview / development), per branch, encrypted at rest |
| CLI | `levant login · link · deploy · logs · env · domains · rollback · open` |
| AI agent | explains failed builds and performs changes with your approval |
| AI app Builder | describe an app in chat → agents plan, design and code a Next.js 15 + shadcn/ui app with a live preview (`preview-{id}.your-domain`), visual editing, component library, one-click backend (LevantBase) and one-click publish as a project; AI provider keys in Settings → AI providers |

## Quick start

On a fresh **Ubuntu 22.04 / 24.04 or Debian 12** server (2 GB RAM, 20 GB disk minimum) with ports 80/443 open:

```bash
# from the unzipped release / a checkout
sudo bash install/install.sh --domain example.com --email you@example.com
```

The installer sets up Docker, the firewall, secrets, the stack and your owner account, then prints the two DNS records
to create:

```
A   deploy.example.com   →  <server IP>     dashboard
A   *.example.com        →  <server IP>     deployment URLs
A   *.base.example.com   →  <server IP>     backends (LevantBase API + Studio)
```

Open `https://deploy.example.com`, log in and import a project. Full guide: [docs/INSTALL.md](docs/INSTALL.md).

## Documentation

| | |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | requirements, installer flags, what gets installed, updates, backups, uninstall, troubleshooting |
| [docs/DOMAINS.md](docs/DOMAINS.md) | DNS for the dashboard + wildcard previews, custom domains, Cloudflare, certificates |
| [docs/BASE.md](docs/BASE.md) | LevantBase backends: create, keys, client libraries, functions, backups |
| [docs/USAGE.md](docs/USAGE.md) | deploying from GitHub, a Git URL, your PC (CLI), a Docker image or compose file; env vars, databases, cron, rollback, AI agent |
| [docs/DEPLOY-LEVANTCART.md](docs/DEPLOY-LEVANTCART.md) | step by step: the LevantCart / LevantMart Next.js app with Postgres, Redis, worker and cron |
| [docs/SPEC.md](docs/SPEC.md), [docs/CONVENTIONS.md](docs/CONVENTIONS.md) | architecture and contributor conventions |

## Architecture

```
                 :80 / :443 (+ HTTP/3)
                        │
                 ┌──────▼──────┐  admin API (internal network only)
 internet ──────►│    Caddy    │◄─────────────────────────────┐
                 └──┬───────┬──┘                              │ routes (syncRoutes)
     dashboard host │       │ *.domain / custom domains       │
             ┌──────▼──┐  ┌─▼────────────────────────┐   ┌────┴─────┐
             │ control │  │ app containers (levant_net)│◄──│  worker  │── docker.sock
             │ Next.js │  └──────────────────────────┘   │ BullMQ   │   builds + deploys
             └──┬───┬──┘                                 └──┬───┬───┘
                │   └────────────── Redis (queues, logs) ───┘   │
                └────────────────── Postgres (state) ───────────┘
```

* `control/` — Next.js 15 dashboard + REST API (`/api/v1`) and the worker (same image: `web` / `worker` commands)
* `base-stack/` — LevantBase stack template (rendered per backend project into `STORAGE_DIR/base/{ref}`) + vendored upstream
* `install/` — installer, update/backup/restore/uninstall scripts, Caddy image
* `docker-compose.yml` — the production stack (postgres, redis, control, worker, caddy)
* `cli/` — the `levant` CLI · `examples/` — sample apps for every supported framework

## Development

```bash
cd control
docker compose -f docker-compose.dev.yml up -d       # Postgres + Redis
cp .env.example .env && npm install
npx prisma db push && npm run db:seed
npm run dev          # http://localhost:3000  (admin@levantdeploy.local / Admin@12345)
npm run worker       # second terminal
```

Production image: `docker build -t levantdeploy/control ./control` (one image; `web` and `worker` commands).
