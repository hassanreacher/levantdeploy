# Using LevantDeploy

How to get code running: from GitHub, from any Git URL, from a folder on your PC, from a Docker image or a
docker-compose file — plus environment variables, databases, workers, cron, domains, rollback and the AI agent.

Concepts: a **team** owns **projects**; every build of a project is a **deployment** with its own URL. One deployment
per project is **production** (`{project}.example.com` + custom domains); all others are **previews**.

---

## 1. Deploy from GitHub

1. *(once per server, platform owner)* **New Project → GitHub → Create GitHub App**. LevantDeploy creates a private
   GitHub App for your server via GitHub's manifest flow (webhook URL and permissions pre-filled) — click *Create*, then
   *Install* it on your account or organization and pick the repositories it may see.
2. **New Project → GitHub** → choose a repository → *Import*.
3. Review the detected settings: framework, root directory (monorepos), build/start commands, port, production
   branch (default: the repository's default branch). Add environment variables if the build needs them.
4. **Deploy.** You land on the deployment page with live build logs.

After that:

| event | result |
|---|---|
| push to the production branch | new production deployment (zero downtime switch) |
| push to any other branch | preview deployment at `{project}-git-{branch}.example.com` |
| pull request opened / updated | preview + a comment on the PR with the URL; commit status ✓/✗ |
| branch deleted / PR closed | its previews are stopped |

Turn automatic deploys or previews off per project in **Settings → Git**.

## 2. Deploy from any Git URL (GitLab, Bitbucket, Gitea, self-hosted)

**New Project → Git URL**:

* public repository — paste the HTTPS URL;
* private repository — paste the SSH URL (`git@gitlab.com:me/app.git`). LevantDeploy generates a **deploy key**;
  add the public key to the repository (*Settings → Repository → Deploy keys*, read-only).

New commits are picked up by polling (every few minutes) or instantly with the **deploy hook**: copy the hook URL from
**Settings → Git** and add it as a push webhook in your Git host (or call it from CI: `curl -X POST <hook url>`).

## 3. Deploy from your PC (CLI)

```bash
# Node 20+. Every LevantDeploy server serves its own CLI build:
npm i -g https://deploy.example.com/api/cli/levant.tgz
levant login --server https://deploy.example.com   # opens the browser to approve, stores a token in ~/.levant
cd my-app
levant deploy              # preview deployment of the current folder
levant deploy --prod       # production
```

`levant deploy` packs the folder (respecting `.gitignore` and `.levantignore`, never `node_modules`/`.git`), uploads it,
and streams the build logs. The first run asks which team/project to link (stored in `.levant/project.json`; run
`levant link` to change it).

| command | |
|---|---|
| `levant login --server <url>` (or `--token`), `levant logout`, `levant whoami` | authentication (in CI set `LEVANT_SERVER` + `LEVANT_TOKEN`) |
| `levant link` | link the folder to a project (creates it if needed) |
| `levant deploy [--prod] [--no-wait]` | upload + build + deploy |
| `levant logs [deployment] [--runtime] [-f]` | build or runtime logs |
| `levant env ls`, `env add KEY [value] [--prod/--preview/--dev]`, `env rm KEY`, `env pull [.env.local]` | environment variables |
| `levant domains ls`, `levant domains add www.myshop.com` | domains |
| `levant rollback [deployment]` | make a previous production deployment current again |
| `levant open` | open the production URL |
| `levant base …` | LevantBase backends: `ls`, `create`, `link`, `status`, `keys`, `env pull`, `db push/dump/url`, `sql`, `functions deploy/ls/rm/invoke`, `secrets`, `gen types typescript`, `studio` — see [BASE.md](BASE.md) |

Upload size limit: **Platform Settings → Limits** (default 512 MB).

## 4. What gets built

LevantDeploy looks at the source and picks the first match:

1. a **`docker-compose.yml`** (or `compose.yaml`) at the root directory → **compose project** (see §6)
2. a **`Dockerfile`** → built as is (set another path in Settings → Build, e.g. `docker/Dockerfile.prod`)
3. a detected framework → a generated, cached multi-stage Dockerfile: Next.js (standalone), Nuxt, SvelteKit, Remix,
   Astro, Vite/CRA/Angular/Vue (static, served by a tiny web server), Express/Nest/Fastify, Bun, Deno,
   Django/FastAPI/Flask, Laravel/PHP, Go, Rust, Rails/Rack, Spring (Maven/Gradle), .NET, Phoenix, static HTML.

Override anything in **Settings → Build & Development**: install / build / start command, output directory, Node
version, root directory. Your app must listen on `$PORT` (default 3000; set the port in Settings → Runtime if it
ignores `$PORT`). Health check: `GET /` (or the path you set) must answer before traffic switches — a deployment that
never becomes healthy is marked *Error* and production keeps serving the previous release.

Examples for every stack live in [`examples/`](../examples).

## 5. Deploy a Docker image

**New Project → Docker image**: enter an image reference (`ghcr.io/me/api:1.4.2`, `nginx:alpine`) and the port it
listens on. Private registries: add credentials in **Settings → Build**. Redeploy (or push a new tag + update the
reference) to roll out a new version.

## 6. Compose projects (multi-service apps)

If the repository has a `docker-compose.yml`, the whole stack is deployed as one deployment:

* services with `build:` are built; images are pulled;
* published `ports:` are removed — traffic only enters through Caddy. The **public** service (the first one that
  publishes or exposes a port, else the first service) gets the project's URLs and domains and `PORT`;
* every service joins the platform network; services reach each other by service name as usual;
* named volumes are made stable per project (data survives redeploys);
* the project's environment variables are passed to every service.

Prefer the **Databases** add-on (§8) over a database service inside your compose file for production data: add-ons
have backups and survive project deletion.

## 7. Environment variables

**Project → Environment.** Each variable has targets — **Production**, **Preview**, **Development** — and may be
limited to one branch (e.g. a different `API_URL` for `staging`). Values are encrypted at rest (AES-256-GCM) and shown
masked; mark secrets as *sensitive* to hide them even from team members. Shared groups (team level) let several
projects reuse the same values.

* Build-time vs runtime: all variables are available at build time (as build args/env) and at runtime. Frameworks that
  inline `NEXT_PUBLIC_*` / `VITE_*` values at build time need a **redeploy** after a change.
* Changing a variable doesn't restart anything — redeploy (or *Restart*) to apply it.
* Provided automatically: `PORT`, `LEVANT_ENV` (`production`/`preview`), `LEVANT_URL`, `LEVANT_GIT_BRANCH`,
  `LEVANT_GIT_COMMIT_SHA`, `LEVANT_DEPLOYMENT_ID`, plus the URLs of connected databases.
* `levant env pull` writes the development values into `.env.local` for local work.

## 8. Databases

**Project → Databases → Create** (or team-level, then connect to several projects): PostgreSQL, MySQL, Redis or
MongoDB, with a version. LevantDeploy starts the database container on the internal platform network, stores the
generated credentials encrypted, and injects the connection URL into connected projects:

| engine | variables |
|---|---|
| PostgreSQL | `DATABASE_URL`, `POSTGRES_URL` |
| MySQL | `DATABASE_URL`, `MYSQL_URL` |
| Redis | `REDIS_URL` |
| MongoDB | `MONGODB_URL`, `MONGO_URL` |

A second database of the same engine gets `<NAME>_URL`. Redeploy after connecting a database.
Backups: schedule + *Back up now* + restore on the database page. A public port can be opened temporarily for tools
like TablePlus/pgAdmin (and should be closed again).

## 9. Workers, queues and cron

* **Worker projects** — set the project kind to *Worker* (Settings → Runtime) for processes without HTTP (queue
  consumers, bots). They are considered healthy when they keep running, get logs/metrics/env vars like any app, and no
  URL. Typical setup: two projects from the same repository — the web app, and a worker with start command
  `node worker.js`.
* **Compose** — or run `web` + `worker` services in one compose project (§6).
* **Cron jobs** — Project → **Cron**: a 5-field schedule (+ timezone) and either
  * a **command**, run in a one-off container of the current production image (`npm run cleanup`,
    `python manage.py clearsessions`), or
  * a **path**, requested with HTTP GET on the production deployment (`/api/cron/daily`).
  Runs, durations and output are listed per job; *Run now* triggers one immediately.

## 10. Domains

Project → **Domains**. Every project gets `{project}.example.com` automatically. Add custom domains, redirects
(`myshop.com` → `www.myshop.com`) and branch domains. DNS details: [DOMAINS.md](DOMAINS.md).

## 11. Deployments, rollback and promotion

Project → **Deployments** lists every deployment with status, branch, commit and author. On a deployment:

* **Logs** — build logs and runtime logs (live, searchable, downloadable).
* **Redeploy** — rebuild the same commit (or reuse the image).
* **Promote to production** — make a preview the production release (no rebuild for the same environment).
* **Rollback** — on any previous production deployment: traffic switches back instantly (the last 5 releases are kept
  stopped, ready to start). `levant rollback` does the same.
* **Cancel / Stop / Restart**.

Production switches are zero-downtime: the new containers must pass the health check before traffic moves; the old
ones drain for a few seconds and stop.

Runtime settings (Settings → Runtime): replicas, CPU/memory limits, health check path, restart policy, volumes
(persistent directories such as `/app/uploads`).

## 12. AI agent

Project → **AI** (or the sparkle button): ask in plain language —

* "Why did the last deployment fail?" — reads the build logs and explains the fix;
* "Add `STRIPE_SECRET_KEY` for production", "point shop.example.org at this project", "scale to 2 replicas".

Read-only questions are answered directly; every change is shown as an action you **approve** first, and everything the
agent did is recorded (conversation history + audit log). The platform owner enables it with an Anthropic API key
(Platform Settings or `ANTHROPIC_API_KEY`).

## 13. Teams and access

Team → **Members**: invite by email or link with a role — **Owner**, **Admin** (domains, members, databases),
**Member** (deploy, env vars, projects), **Viewer** (read-only). **Tokens**: API tokens for CI and the CLI, optionally
limited to one team and to scopes (`deployments:write`, `env:read`, …). **Audit log**: who did what, when, from where.

REST API: `https://deploy.example.com/api/v1/…` with `Authorization: Bearer <token>`.
