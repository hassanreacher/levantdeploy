# Deploying LevantCart / LevantMart on LevantDeploy

Step-by-step guide for the LevantCart/LevantMart multi-tenant commerce app (Next.js 15 + Prisma + PostgreSQL + Redis,
a background worker and scheduled jobs). The repository layout this guide assumes:

```
levantmart/
  web/                  Next.js app (Dockerfile with targets runner / tools, worker bundled to worker.js)
    prisma/schema.prisma
    scripts/worker.ts   background worker (queues, scheduled tasks)
    .env.example        application settings
  docker-compose.yml    the app's own stand-alone production stack (not needed on LevantDeploy)
```

There are two ways to run it. **Option A (recommended)**: a web project + a worker project + database add-ons —
LevantDeploy handles TLS, domains, env vars, backups, previews and rollbacks. **Option B**: deploy the repository's
`docker-compose.yml` as one compose project — fastest if you want exactly the stack you already have.

---

## Before you start

* LevantDeploy installed, DNS for the dashboard + `*.example.com` working ([INSTALL.md](INSTALL.md)).
* The repository is on GitHub (GitHub App connected) or any Git host (deploy key) — see [USAGE.md](USAGE.md) §1–2.
* Decide the shop's public domain. LevantMart is multi-tenant: supermarkets get `{store}.levantmart.com` and can bring
  their own domains, so it needs **its own** wildcard domain (`*.levantmart.com`), separate from LevantDeploy's
  platform domain.
* Server size: 4 GB RAM minimum (Next.js build ≈ 1.5 GB + Postgres + Redis + 2 web replicas).

## Option A — web project + worker project + add-ons

### A1. Create the databases

Team → **Databases → Create**:

1. **PostgreSQL 16**, name `levantmart-db`.
2. **Redis 7**, name `levantmart-redis`.

Leave them unconnected for now; you connect them in A3.

### A2. Create the web project

**New Project → GitHub** (or Git URL) → pick the repository, then in the import screen:

| setting | value |
|---|---|
| Project name | `levantmart` |
| Root directory | `web` |
| Framework | Dockerfile (detected: `web/Dockerfile`; its last stage, `runner`, is the image that runs) |
| Port | `3000` |
| Health check path | `/api/health` |
| Production branch | `main` |

Don't deploy yet — click *Import without deploying* (or let the first build fail; it needs env vars).

### A3. Connect the databases

On the project → **Databases**, connect `levantmart-db` and `levantmart-redis`. LevantDeploy adds `DATABASE_URL` and
`REDIS_URL` (encrypted, production + preview) pointing at the add-on containers on the internal network.

> PgBouncer: the stand-alone stack routes Prisma through PgBouncer. On LevantDeploy connect directly; for very high
> traffic append `?connection_limit=10&pool_timeout=20` by overriding `DATABASE_URL` (Environment → edit).

### A4. Environment variables

Project → **Environment → Import .env**: paste `web/.env.example`, then fill in the values (generate secrets with
`openssl rand -hex 32`). The important ones:

| key | value | notes |
|---|---|---|
| `NODE_ENV` | `production` | |
| `APP_URL` | `https://levantmart.com` | the public URL |
| `PLATFORM_DOMAIN` | `levantmart.com` | the app's own multi-tenant domain |
| `COOKIE_DOMAIN` | `.levantmart.com` | |
| `SUBDOMAINS_ENABLED` | `true` | |
| `SESSION_SECRET`, `ENCRYPTION_KEY`, `INTERNAL_SECRET`, `CRON_SECRET` | random, 32+ chars | mark *sensitive* |
| `STORAGE_DIR` | `/app/storage` | must match the volume in A5 |
| `SMTP_*`, `MAIL_FROM` | your SMTP | |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | | sensitive |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | | **build-time** — redeploy after changing it |
| `SERVER_IPS` | the LevantDeploy server's IP | the app shows it in its own domain instructions |
| `WORKER_APP_URL` | *(worker only, A6)* | |

Do **not** set `DATABASE_URL`/`REDIS_URL` by hand — they come from the add-ons. Use the *Preview* target for
staging-safe values (e.g. Stripe test keys) so preview deployments never touch live payments.

### A5. Persistent uploads

Product images and other uploads are written to `STORAGE_DIR`. Settings → Runtime → **Volumes → Add**:
name `uploads`, mount path `/app/storage`. The volume survives redeploys and rollbacks.
With more than one replica every replica mounts the same volume (fine for this app: files are write-once).

### A6. Schema, seed, first deploy

LevantMart's `runner` image contains only the built app (no Prisma CLI), so apply the schema from your PC (or CI)
through the database's temporary public port:

1. Database `levantmart-db` → **Connect → Open public port** — note the host/port/password it shows.
2. On your PC, in `levantmart/web`:
   ```bash
   export DATABASE_URL='postgresql://<user>:<password>@deploy.example.com:<public port>/<db>'
   npx prisma db push && npm run db:indexes
   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='<strong password>' npm run db:seed
   ```
3. **Close the public port** again.
4. **Deploy** (Deployments → *Deploy*, or push to `main`) and watch the build logs. When it is *Ready* open the project
   URL — the storefront should load and you can sign in with the seeded admin.

Future schema changes: run step 2 before (additive changes) or right after deploying. Alternatively add the Prisma CLI
to the `runner` stage (`COPY --from=builder /app/node_modules ./node_modules` keeps it simple at the cost of image
size) and run `npx prisma db push --skip-generate` as a Cron job with **Run now** — command jobs run in a one-off
container of the production image with the project's env vars.

### A7. The worker

LevantMart's worker (`node worker.js`, bundled from `web/scripts/worker.ts`) processes queues and periodic tasks.

**New Project** → same repository → name `levantmart-worker`:

| setting | value |
|---|---|
| Root directory | `web` |
| Dockerfile / target | same as the web project |
| Project kind | **Worker** (Settings → Runtime) — no URL, healthy while running |
| Start command | `node worker.js` |
| Replicas | 1 |

Connect the same two databases (A3) and copy the environment (Environment → *Copy from project* `levantmart`, or put
the shared keys in a **shared env group** and link both projects). Add:

| key | value |
|---|---|
| `WORKER_APP_URL` | `http://<web container alias>:3000` — shown on the web project's deployment page (*Internal URL*), or simply the public URL `https://levantmart.com` |
| `WORKER_RUN_ON_START` | `true` |

Both projects build from the same commit on every push to `main`. Turn off previews for the worker project
(Settings → Git) — preview workers would consume production queues.

### A8. Scheduled jobs

If you prefer platform-managed schedules over the worker's internal timers, add **Cron** jobs on the web project:

| name | schedule | type | value |
|---|---|---|---|
| daily digest | `0 6 * * *` | path | `/api/cron/daily?secret=<CRON_SECRET>` |
| cleanup | `30 3 * * *` | command | `node worker.js --once cleanup` *(if your worker supports one-shot tasks)* |

HTTP-path jobs call the production deployment; command jobs run in a one-off container with the project env.

### A9. Domains

LevantMart needs its root, `www`, the wildcard for stores, and stores' own domains:

1. DNS at your provider for `levantmart.com`:
   ```
   A    levantmart.com      → <server IP>
   A    *.levantmart.com    → <server IP>
   ```
2. Project → **Domains → Add** `levantmart.com` and `www.levantmart.com` (redirect → `levantmart.com`).
3. **Store subdomains** (`{store}.levantmart.com`): add the **wildcard domain** `*.levantmart.com` to the project
   (Domains → Add → `*.levantmart.com`). LevantDeploy shows two records — the `*` record (step 1 already covers it, or a
   `CNAME * → cname.<platform domain>`) and an ownership TXT record `_levant-verify.levantmart.com` with the token.
   Once both resolve the domain turns **Active** and every `name.levantmart.com` is served by the production
   deployment — new stores work immediately, no API call per store:
   * one level deep: `freshmart.levantmart.com` matches, `a.b.levantmart.com` does not;
   * hostnames added explicitly (to this or another project, e.g. `levantmart.com`, `www.levantmart.com`,
     `admin.levantmart.com`) always win over the wildcard;
   * HTTPS: each store subdomain gets its **own certificate on its first visit** (on-demand TLS; LevantDeploy's
     `tls-ask` allows any single-label subdomain of an active wildcard). A real `*.levantmart.com` wildcard
     certificate would need the ACME DNS-01 challenge with your DNS provider's API — not configured by default. Mind Let's
     Encrypt's limit of 50 new certificates per registered domain per week when onboarding many stores at once.
   Your app reads the store from the `Host` header as usual (Caddy passes it through unchanged).
4. Supermarkets' own domains (`shop.example.org`): same API call (or Domains → Add) as they onboard, after their DNS
   points at the server.

> If the app runs its own TLS-ask logic (`/api/internal/tls-ask` in LevantMart) it is **not** used here — LevantDeploy's
> Caddy only issues certificates for domains attached to a project.

### A10. Payments webhooks, backups, scaling

* Stripe webhook endpoint: `https://levantmart.com/api/webhooks/stripe` (or the path your app uses).
* Backups: database page → Backups → schedule daily, keep 14. Uploads volume: included in `install/backup.sh` only if
  you mount it under the storage dir — otherwise back it up with the volume backup on the Storage page.
* Scale: Settings → Runtime → replicas `2`, memory `1024` MB. Rolling, health-checked.
* Rollback: Deployments → previous production → **Rollback** (the database is not rolled back — keep schema changes
  backwards compatible, i.e. add columns before you use them).

## Option B — the repository's docker-compose.yml

LevantDeploy can deploy the whole `docker-compose.yml` as one **compose project**: services with `build:` are built,
host `ports:` are dropped (traffic goes through LevantDeploy's Caddy to the first service that exposes a port), named
volumes become persistent per project.

Adapt the file first (or keep a `docker-compose.levant.yml` and set it in Settings → Build → *Compose file*):

1. **Remove the `caddy` service** — LevantDeploy's edge proxy replaces it (TLS, domains, HTTP/3).
2. Make `web` the public service: it must be the first service with `expose: ["3000"]` (or `ports`), or move it to the
   top of the file.
3. Remove `deploy.replicas` for `web` (scale with Settings → Runtime instead) and the `backup` service if you use
   LevantDeploy's backups.
4. `env_file: ./web/.env` → put those values into **Project → Environment** instead (they are passed to every
   service); never commit `.env`.
5. Keep `internal: true` networks as they are — LevantDeploy attaches only the public service to its proxy network.

Then **New Project → Git** → repository → root directory `/` → LevantDeploy detects the compose file → Deploy.
Migrations: keep the compose `migrate` service (target `tools`) but remove `profiles: ["tools"]` and add
`restart: "no"` — it then runs `prisma db push` + indexes once on every deployment before exiting.

Trade-offs vs. Option A: previews start a complete copy of the stack (including an empty database) per branch —
disable previews (Settings → Git) or keep them for throwaway testing; database backups are your compose file's job.

## Checklist

- [ ] `levantmart.com`, `www`, `*.levantmart.com` A records → server
- [ ] Postgres + Redis add-ons connected (Option A)
- [ ] all secrets set, `NEXT_PUBLIC_*` set before the build
- [ ] uploads volume at `/app/storage`
- [ ] schema pushed + seeded through the temporary public port, port closed again
- [ ] worker project running (kind Worker, previews off)
- [ ] domains Active, certificates issued (open each once)
- [ ] database backups scheduled; `install/backup.sh` cron on the server
