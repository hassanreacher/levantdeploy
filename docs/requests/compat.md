# compat (LevantBase) — notes, fixes & requests

Status: DONE (wave D). Isolation: DB `levantdeploy_compat`, Redis db 11, port 3111, `control/.env.compat` (gitignored),
storage `control/storage-compat/`, Caddy container `compat-caddy` on `levant_net` (fixed IP, **no host ports** — the
suite connects to the container address like `curl --resolve`, so /etc/hosts was never touched).

## Deliverables
| Path | What |
|---|---|
| `control/tests/base/compat/` | real client suite: `@supabase/supabase-js` 2.117.3 (exact pin, own `package.json`), `run.sh` (sandbox wiring) + `run.ts` (entry) + one file per area; results in `results/` (gitignored) |
| `control/tests/base/compat/smtp-sink.mjs` | dependency-free SMTP sink (throwaway `node:22-alpine` container attached to the project's egress network) for confirmation / OTP / recovery mails |
| `docs/BASE-COMPAT.md` | pass/fail table + versions — final run **103/103** |
| `cli/src/commands/base.ts`, `cli/src/base/lib.ts`, `cli/test/base.test.ts` | `levant base …` (ls, create, link, status, keys, env pull, db url/dump/push, sql, functions deploy/ls/rm/invoke, secrets set/ls/unset, gen types typescript, studio) |
| `control/src/app/api/v1/base/projects/[ref]/types/route.ts` + `src/lib/base/types.ts` | **new** `GET /api/v1/base/projects/:ref/types?lang=typescript&schemas=public` (VIEWER, base:read) — postgres-meta generator through the gateway's `/pg` with the service key |
| `docs/BASE.md` | owner/user guide |
| `control/tests/base/lb.ts` | + `api-token [name]` (dev helper used by the suite / CLI checks) |

`POST /api/v1/base/projects/:ref/sql` already existed (base-dashboard, MEMBER+, audited) — used as is by `db push`.

## Runtime bugs found by the suite and fixed (base-runtime area)
1. **pg_graphql disabled** → `/graphql/v1` answered `pg_graphql extension is not enabled` on every project.
   Fix: `base-stack/template/volumes/db/graphql.sql` (`create extension if not exists pg_graphql`) mounted as
   `migrations/99-graphql.sql` (new projects; existing ones: run the statement once). README deviation #17.
2. **Concurrent stack jobs of one project raced** (queue concurrency 3): a function-secret change and an auth-settings
   change a second apart ran two `docker compose up` at once → `Conflict. The container name … is already in use` →
   project ERROR → Caddy 502 for all traffic. Fix: `src/worker/processors/base.ts` serialises every stack-changing job
   of the same ref with a Redis lock (`lb:lock:{ref}`, waits up to 30 min, compare-and-delete release; other projects
   still run in parallel; restore jobs resolve their ref from the backup row).
3. **Stuck in ERROR after a later successful settings apply**: `applySettings` succeeded (all services healthy) but the
   status stayed ERROR (502). Fix: `stack.ts › applySettings` returns ERROR → ACTIVE + `syncRoutes()` on success.
4. **Objects created through the SQL API were owned by `supabase_admin`** (`runSql` logged in as the superuser): a
   table made in the SQL editor / `levant base db push` / the AI agent could not be altered by `postgres`, i.e. by apps
   and migration tools (Prisma/Drizzle via `postgres.<ref>` on the pooler) — `ERROR: must be owner of table`. Hosted
   projects run the SQL editor as `postgres`. Fix: `service.ts › runSql` logs in as `postgres` (API roles still via
   `SET LOCAL ROLE`, postgres is a member of anon/authenticated/service_role). Verified as postgres: tables, RLS
   policies, `storage.objects` policies, `alter publication supabase_realtime`, triggers on `auth.users`
   (handle_new_user pattern), `insert into storage.buckets`, `create extension`. Side effect (intended): user SQL can
   no longer `RESET ROLE` to the superuser. **Existing projects** keep `supabase_admin`-owned tables created before
   this change → request below.
5. **Pooler crash-loop on hosts with a Docker nofile hard limit < 100000** (sandbox: 20000): supavisor's entrypoint
   does `ulimit -n 100000` under `set -e`. Fixed together with base-runtime (it landed in the template from both
   sides at the same minute; one copy kept): `RLIMIT_NOFILE: "10000"` (as upstream's realtime).
6. (applied concurrently by base-runtime as well) jose vendored for the functions main router so the edge runtime
   boots without outbound internet — the sandbox has no container egress, functions came up healthy with it.

## base-dashboard area — bugs / requests (not changed by compat)
1. **Invoke tester ignores `auth`**: `POST /functions/:slug/invoke` passes `headers: { "x-levant-auth": input.auth }`
   to the adapter but never `auth: input.auth` → the request always carries the **anon** key (`auth: "none"` and
   `"service_role"` have no effect; verified: `levant base functions invoke hello --no-auth` → 200 on a verify_jwt
   function). Fix: `invokeFunction(ref, slug, { method, body, headers: input.headers, auth: input.auth })`.
2. **Studio for API tokens**: `POST /studio` refuses token actors ("only from the dashboard"). A MEMBER token can
   already run any SQL through `/sql`, so Studio adds no privilege; please allow tokens with `base:write` so
   `levant base studio` can open the SSO link directly (the CLI currently falls back to the project page).
3. `POST /sql` caps statements at 100 000 characters. `levant base db push` splits bigger migration files on
   statement boundaries (not atomic across parts, warned); a higher cap (or an upload/restore endpoint for
   `pg_dump` files) would make migrating existing projects from the CLI simpler.
4. Functions API: **additive** change by compat — `files: { "rel/path.ts": source }` accepted by
   `POST /functions` and `PATCH /functions/:slug` (≤ 100 files, relative paths, no `..`), passed to the runtime's
   `deployFunction({ files })`, `adapters.deployFunction` got the optional `files`. Used by
   `levant base functions deploy` for multi-file functions and `../_shared` imports. Redeploying with fewer files
   leaves old files on disk (runtime: consider clearing the folder before writing).

## Requests to base-runtime
- Existing projects: a one-time job (or upgrade step) that hands objects in user schemas owned by `supabase_admin` to
  `postgres`, so projects created before fix 4 behave the same (otherwise `levant base db push` fails there with
  `permission denied for schema levant` / `must be owner`). What compat ran by hand on its own older project (as
  `supabase_admin` via `psql()`):
  ```sql
  alter schema levant owner to postgres; alter table levant.levant_migrations owner to postgres;
  do $$ declare r record; begin
    for r in select schemaname, tablename from pg_tables where schemaname = 'public' and tableowner = 'supabase_admin' loop
      execute format('alter table %I.%I owner to postgres', r.schemaname, r.tablename); end loop;
    for r in select p.oid::regprocedure as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and pg_get_userbyid(p.proowner) = 'supabase_admin' loop
      execute format('alter function %s owner to postgres', r.f); end loop;
    for r in select t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace
             where n.nspname = 'public' and t.typtype = 'e' and pg_get_userbyid(t.typowner) = 'supabase_admin' loop
      execute format('alter type public.%I owner to postgres', r.typname); end loop;
  end $$;
  ```
  (a complete version should also cover views, sequences not owned by a table, and other user schemas).
- `deployFunction({ files })`: remove files that are no longer part of the function (see above).

## How it was run
```
cd control && set -a && . ./.env.compat && set +a
npx next dev -p 3111 & npx tsx src/worker/index.ts &             # NEXT_DIST_DIR=.next-compat
docker run -d --name compat-caddy --network levant_net --ip 172.18.11.2 --add-host host.docker.internal:host-gateway \
  -v $PWD/storage-compat/caddy:/var/log/caddy caddy:2-alpine caddy run --config /var/log/caddy/bootstrap.json
npx tsx tests/base/lb.ts api-token compat > token                # admin token (scopes *)
cd tests/base/compat && LB_API=http://localhost:3111 LB_TOKEN=$(cat ../../../token) ./run.sh
```
Without `LB_REF` the suite creates the project through `POST /api/v1/base/projects`, waits for ACTIVE (≈ 25 s with
cached images), runs every check and deletes it again. CLI: every command was run against a real project (see
docs/BASE-COMPAT.md › CLI).

## Shared-file changes (all additive / small)
- `src/worker/processors/base.ts` (per-project lock), `src/lib/base/stack.ts` (ERROR → ACTIVE), `src/lib/base/service.ts`
  (runSql as postgres), new `src/lib/base/types.ts`, `base-stack/template/{docker-compose.yml, volumes/db/graphql.sql}`,
  `base-stack/README.md` (#17).
- base-dashboard files: `functions/route.ts`, `functions/[slug]/route.ts`, `base-ui/adapters.ts` (optional `files`);
  new `types/route.ts`.
