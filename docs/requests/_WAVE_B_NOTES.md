# Wave B shared rules (all agents)
- Read docs/SPEC.md and docs/CONVENTIONS.md first. Never run git push / add remotes in /home/user/levantdeploy. Never copy real secrets.
- Services: Postgres localhost:5432 (user postgres), Redis localhost:6379, Docker daemon (/var/run/docker.sock). If one is down, start it:
  - `su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/lib/lc-pg/data -l /var/lib/lc-pg/log -o '-p 5432 -k /tmp' start"`
  - `redis-server --daemonize yes --port 6379 --dir /tmp`
  - `(nohup dockerd > /tmp/dockerd.log 2>&1 &)`
- ISOLATION while testing (workers on a shared Redis would steal each other's jobs):
  | area | Postgres DB | REDIS_URL | dev/start port |
  |---|---|---|---|
  | build | levantdeploy_build | redis://localhost:6379/1 | 3101 |
  | runtime | levantdeploy_runtime | redis://localhost:6379/2 | 3102 |
  | git+cli | levantdeploy_git | redis://localhost:6379/3 | 3103 |
  | dashboard | levantdeploy_dash | redis://localhost:6379/4 | 3104 |
  | ai | levantdeploy_ai | redis://localhost:6379/5 | 3105 |
  | ops | levantdeploy_ops | redis://localhost:6379/6 | 3106 (+ compose on 8080/8443) |
  Create your DB with `createdb -h localhost -U postgres <db>` then `DATABASE_URL=... npx prisma db push && npm run db:seed`. Pass your env inline or via a private `.env.<area>` file (gitignored, not shipped). The shared `control/.env` stays as is.
- Docker: prefix every container/image/volume/network you create in tests with your area (e.g. projects named `build-…`), and remove them when done. Only the runtime agent runs Caddy on host ports 80/443/2019; others must not bind those.
- Internet in this sandbox goes through an HTTPS proxy ($HTTPS_PROXY) with a custom CA (/root/.ccr/ca-bundle.crt). Docker builds reach the internet only with `--network host`, proxy build-args and the CA mounted as a BuildKit secret (the build area implements this as the optional "build proxy" platform setting; other areas use it via the build engine). Real servers don't need it.
- Kill servers you start by pid (`ss -ltnp`), never `pkill -f`.
- Need a change in a shared file (schema, src/lib/{http,crypto,queues,logs,deployments,settings,auth/*}, middleware)? Small additive changes are OK — note them in docs/requests/<area>.md. Otherwise write the request there.
- Finish with: `npx tsc --noEmit` clean for the whole project, `npm test` passing, your screenshots in docs/screenshots/<area>/, notes in docs/requests/<area>.md, and a concise report.

## Wave C isolation (LevantBase)
| area | Postgres DB | REDIS_URL | port |
|---|---|---|---|
| base-runtime | levantdeploy_bruntime | redis://localhost:6379/7 | 3107 |
| base-dashboard | levantdeploy_bdash | redis://localhost:6379/8 | 3108 |
| plans | levantdeploy_plans | redis://localhost:6379/9 | 3109 |
| landing | levantdeploy_landing | redis://localhost:6379/10 | 3110 |
| compat | levantdeploy_compat | redis://localhost:6379/11 | 3111 |
Disk is limited (~13 GB free): the Supabase images are large — only base-runtime and compat pull them; prune what you no longer need; never `docker system prune -a` (other agents' images). Docker Hub may 429 → use `mirror.gcr.io/<image>` and retag.

## Wave E isolation (Builder)
| area | Postgres DB | REDIS_URL | port |
|---|---|---|---|
| llm | levantdeploy_llm | redis://localhost:6379/12 | 3112 |
| builder-core | levantdeploy_bcore | redis://localhost:6379/13 | 3113 |
| builder-agents | levantdeploy_bagents | redis://localhost:6379/14 | 3114 |
| builder-ui | levantdeploy_bui | redis://localhost:6379/15 | 3115 |
Provider keys: /home/user/.levant-secrets/providers.env (never copy into the project). Disk ~8 GB free: keep images small, prune your own.
