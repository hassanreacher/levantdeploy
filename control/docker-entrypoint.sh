#!/bin/sh
# LevantDeploy control image entrypoint (ops area).
#   web     → apply database migrations, then start the Next.js dashboard/API (node server.js)
#   worker  → wait for the database schema, then start the BullMQ worker (node dist/worker.js)
#   migrate → apply migrations and exit
#   *       → exec the given command (e.g. `sh`, `node -e …`)
set -eu

SCHEMA_FILE=/app/prisma/schema.prisma
prisma() { node /opt/prisma/node_modules/prisma/build/index.js "$@"; }

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [entrypoint] $*"; }

wait_for_db() {
  i=0
  until node -e '
    const u = new URL(process.env.DATABASE_URL);
    const s = require("net").connect(Number(u.port || 5432), u.hostname, () => { s.end(); process.exit(0); });
    s.on("error", () => process.exit(1));
    setTimeout(() => process.exit(1), 2000);
  ' 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -ge 60 ] && { log "database not reachable after 120s"; exit 1; }
    sleep 2
  done
}

# LEVANT_DB_SYNC: auto (default) = migrate deploy, then a non-destructive `db push` if the schema still drifts
#                 migrate = migrate deploy only (warn on drift) · push = db push only
migrate() {
  wait_for_db
  mode="${LEVANT_DB_SYNC:-auto}"
  if [ -d /app/prisma/migrations ] && [ "$mode" != "push" ]; then
    log "applying migrations (prisma migrate deploy)"
    prisma migrate deploy --schema "$SCHEMA_FILE"
    if ! prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel "$SCHEMA_FILE" --exit-code >/dev/null 2>&1; then
      if [ "$mode" = "auto" ]; then
        log "schema has changes not covered by migrations → prisma db push (non-destructive)"
        prisma db push --schema "$SCHEMA_FILE" --skip-generate
      else
        log "WARNING: database schema differs from prisma/schema.prisma after migrations (LEVANT_DB_SYNC=migrate)."
      fi
    fi
  else
    log "syncing schema (prisma db push)"
    prisma db push --schema "$SCHEMA_FILE" --skip-generate
  fi
}

ensure_dirs() {
  for d in "${STORAGE_DIR:-/var/lib/levantdeploy/storage}" "${WORK_DIR:-/var/lib/levantdeploy/work}"; do
    mkdir -p "$d" 2>/dev/null || true
    [ -w "$d" ] || log "WARNING: $d is not writable by uid $(id -u) — fix with: chown -R $(id -u):$(id -g) <host dir>"
  done
}

VERSION="${LEVANT_VERSION:-$(node -p "require('/app/package.json').version" 2>/dev/null || echo dev)}"

cmd="${1:-web}"
case "$cmd" in
  web)
    ensure_dirs
    migrate
    # shellcheck disable=SC3028 # HOSTNAME is set by the image (ENV HOSTNAME=0.0.0.0)
    log "starting dashboard on ${HOSTNAME:-0.0.0.0}:${PORT:-3000} (LevantDeploy $VERSION)"
    exec node /app/server.js
    ;;
  worker)
    ensure_dirs
    wait_for_db
    # the web container owns migrations; give it time to finish on first boot
    i=0
    until prisma migrate status --schema "$SCHEMA_FILE" >/dev/null 2>&1 || [ ! -d /app/prisma/migrations ] || [ "$i" -ge 90 ]; do
      i=$((i + 1)); sleep 2
    done
    if [ -S "${DOCKER_SOCKET:-/var/run/docker.sock}" ]; then
      docker version --format 'docker engine {{.Server.Version}}' 2>/dev/null | sed 's/^/[entrypoint] /' || log "WARNING: cannot talk to the Docker socket (group permissions? set DOCKER_GID)"
    else
      log "WARNING: Docker socket ${DOCKER_SOCKET:-/var/run/docker.sock} is not mounted — builds and deployments will fail"
    fi
    log "starting worker (LevantDeploy $VERSION)"
    exec node /app/dist/worker.js
    ;;
  migrate)
    migrate
    ;;
  *)
    exec "$@"
    ;;
esac
