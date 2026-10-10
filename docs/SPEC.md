# LevantDeploy — self-hosted Vercel-style platform (read this first)

LevantDeploy lets the owner deploy ANY project (from GitHub, any Git URL, or a local folder on their PC) to their own server, with automatic builds, unique deployment URLs, preview deployments, custom domains with automatic HTTPS, and an AI agent that helps. Unlike Vercel it is **not serverless**: every deployment is a long-running Docker container (or a docker-compose stack), so any language/framework, WebSockets, background workers, cron and databases work.

NEVER run git push / create remotes in /home/user/levantdeploy. It is delivered as a zip. Never copy real secrets into the project.

## Stack (same family as LevantCart/LevantMart)
- `control/` — Next.js 15 App Router (TypeScript, React 19, Tailwind 3), Prisma 6 + PostgreSQL 16, Redis (ioredis) + BullMQ queues, zod, jose (sessions), bcryptjs, dockerode. Dashboard UI + REST API (`/api/v1/**`) in one app.
- `control/src/worker/` — the worker process (`npm run worker`): BullMQ consumers for build, deploy, domain checks, cron triggers, metrics sampling, backups, cleanup. Talks to the local Docker Engine via `/var/run/docker.sock`.
- Edge proxy: **Caddy 2** in Docker, configured dynamically through its admin API (`http://caddy:2019`, JSON config). On-demand TLS gated by `GET /api/internal/tls-ask?domain=`.
- `cli/` — `levant` CLI (Node 20+, zero-config): `login`, `link`, `deploy` (uploads the current folder as a tarball, respecting .gitignore/.levantignore, streams build logs), `logs`, `env ls/add/rm/pull`, `domains ls/add`, `rollback`, `open`.
- `install/` — `install.sh` (Ubuntu/Debian VPS one-liner: installs Docker, writes .env, starts `docker compose`), `docker-compose.yml` (postgres, redis, caddy, control, worker), update/backup scripts.

## Core concepts (Prisma models — names are binding)
- `User` (email, passwordHash, name, avatar, totpSecret?), `Session`, `Team` (slug), `Membership` (role OWNER/ADMIN/MEMBER/VIEWER), `Invite`, `ApiToken` (hashed, scopes), `AuditLog`.
- `Project` (teamId, name, slug unique per team, framework, sourceType GITHUB/GIT/UPLOAD/IMAGE, repo fields: gitUrl, githubInstallationId, githubRepoId, githubRepoFullName, productionBranch, rootDirectory, buildSettings Json {installCommand, buildCommand, startCommand, outputDirectory, dockerfilePath, nodeVersion…}, runtime settings: port, healthcheckPath, replicas, cpuLimit, memoryLimitMb, restartPolicy, autoDeploy, previewDeployments, kind WEB/WORKER/STATIC/COMPOSE).
- `Deployment` (projectId, number, target PRODUCTION/PREVIEW, status QUEUED/BUILDING/DEPLOYING/READY/ERROR/CANCELED/SUPERSEDED, source info: branch, commitSha, commitMessage, commitAuthor, prNumber, uploadId; imageTag, containerIds Json, url `{project}-{shortid}.{PLATFORM_DOMAIN}`, buildStartedAt/readyAt/duration, errorMessage, isCurrentProduction, createdById, meta Json).
- `DeploymentLog` lines are stored in Redis streams while live and archived gzip to `storage/logs/{deploymentId}.log.gz` (model `LogArchive`) — build and runtime logs separated by `stream` BUILD/RUNTIME.
- `EnvVar` (projectId, key, valueEnc (AES-256-GCM via ENCRYPTION_KEY), targets PRODUCTION/PREVIEW/DEVELOPMENT[], isSecret, branch?), `SharedEnvGroup` + link table.
- `Domain` (projectId, hostname unique, kind PLATFORM/CUSTOM, status PENDING/VERIFYING/ACTIVE/FAILED/DISABLED, verifyToken, redirectTo?, redirectStatus, gitBranch? (domain pinned to a branch), lastCheckedAt, lastError, isPrimary).
- `Volume` (projectId, name, mountPath, sizeHint), `CronJob` (projectId, schedule, command or path, lastRunAt, lastStatus), `Database` add-on (teamId, projectId?, engine POSTGRES/MYSQL/REDIS/MONGO, version, name, credentialsEnc, status, containerId, internalHost, port, publicPort?, backupSchedule) + `Backup`.
- `Upload` (tarball from CLI/dashboard: path, size, sha256, expiresAt), `GitHubInstallation`, `Webhook` (outgoing: url, events, secret), `Notification` channels (EMAIL/WEBHOOK/TELEGRAM/SLACK), `Server` (single local server row now; field kept for future multi-server), `MetricSample` (rolled up per minute), `Setting` (key/value JSON: platform domain, build proxy, registry, limits).
- `AgentConversation`, `AgentMessage`, `AgentAction` (AI agent history + every tool call it made, with approval status).

## Lifecycle (contract between areas)
1. A deployment is created by: GitHub push/PR webhook, "Deploy" button / redeploy, CLI upload, API. Call `createDeployment({projectId, target, source})` in `src/lib/deployments.ts` → row QUEUED → `queues.build.add(deploymentId)`.
2. **Build** (`src/lib/build/**`, worker job `build`): fetch source into `/var/lib/levantdeploy/work/{deploymentId}` (git clone shallow at sha / extract upload) → detect framework → use the repo's Dockerfile / docker-compose if present, else generate a Dockerfile from a template → `docker build` (BuildKit, cache per project, labels) → push nothing (local images) → status DEPLOYING → `queues.deploy.add(deploymentId)`. Logs: `appendLog(deploymentId, "BUILD", line)`.
3. **Deploy** (`src/lib/runtime/**`, worker job `deploy`): create container(s) on network `levant_net` with env vars, limits, volumes, labels (`levant.project`, `levant.deployment`) → wait for health (HTTP `healthcheckPath` on `port`, or TCP, or "running for N s" for workers) → `proxy.setRoutes(...)` → READY. Preview deployments get their own URL; production deployments additionally move all production domains to the new containers (zero downtime) then stop the previous production containers after a drain period (kept stopped for instant rollback, last 5 per project).
4. **Rollback/promote**: re-point production domains to a previous READY deployment's image (start it again if stopped).
5. **Routing** (`src/lib/proxy/**`): Caddy routes are fully derived from DB state (`syncRoutes()` rebuilds the whole `apps` server config idempotently; called after every change and at worker start). Hosts: deployment URLs, `{project}.{PLATFORM_DOMAIN}` (production), `{project}-git-{branch}.{PLATFORM_DOMAIN}` (latest preview per branch), custom domains, redirects (www→apex), dashboard host `{DASHBOARD_HOST}`.

## Areas & ownership (wave B, parallel)
| Area | Owns |
|---|---|
| foundation (wave A) | scaffold, schema, auth, teams, tokens, audit, http/crypto/queue/log helpers, UI kit + dashboard shell, settings, `src/lib/deployments.ts` contract, dev compose, CONVENTIONS |
| build | `src/lib/build/**`, `src/lib/sources/**` (git clone, upload extract), worker `build` job, framework detection + Dockerfile templates for: Next.js, Nuxt, SvelteKit, Remix, Astro, Vite/CRA/Angular/Vue static, generic Node (Express/Nest/Fastify), Bun, Deno, Python (Django/FastAPI/Flask/generic), PHP (Laravel/plain), Go, Rust, Ruby (Rails/Rack), Java (Spring Maven/Gradle), .NET, Elixir/Phoenix, static HTML, Dockerfile, docker-compose; build cache; build proxy/CA setting; sample apps in `examples/` and tests |
| runtime | `src/lib/runtime/**`, `src/lib/proxy/**`, `src/lib/domains/**`, worker `deploy`/`domains`/`metrics`/`cron`/`cleanup` jobs, `/api/internal/**`, databases add-on + backups, volumes, runtime logs, metrics; UI pages: domains, env-independent runtime settings, logs, metrics, databases, storage, cron |
| git+cli | GitHub App (manifest flow for self-hosting, install, repo picker, webhooks push/PR/delete-branch, commit statuses + deployment PR comments), generic Git URL + deploy keys, upload API (chunked), `cli/**`; UI: "New project" import flow (GitHub / Git URL / upload / template), git settings |
| dashboard | projects list, project overview, deployments list + deployment detail (live build/runtime log streaming via SSE, status timeline, promote/rollback/redeploy/cancel), env vars UI + API, project settings (build & runtime), team/members/invites/tokens/audit/notifications UI, global search, activity feed, notifications (email/webhook/Telegram on deploy fail/success) |
| ai | `src/lib/ai/**`, `src/components/ai/**`, `/api/v1/ai/**`: LevantDeploy Agent (Claude API, tool-use loop, streaming) |
| ops | `install/**`, root `docker-compose.yml`, Caddy base config, `README.md`, `docs/INSTALL.md`, `docs/DOMAINS.md`, backup/update scripts, landing/login page polish |

Shared files (`prisma/schema.prisma`, `src/lib/{http,crypto,queues,logs,deployments,auth/*}.ts`, middleware) belong to foundation/lead; need a change → write `docs/requests/<area>.md` (small additive schema fields are allowed if you note them there and run `npx prisma db push`).
