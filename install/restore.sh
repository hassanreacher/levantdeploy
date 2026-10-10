#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# LevantDeploy restore
#
#   sudo /opt/levantdeploy/install/restore.sh <backup dir | db.dump | levantdeploy-*.dump> [--with-env] [--yes]
#
#   • a directory made by backup.sh → restores db.dump, storage.tar.gz (if present) and, with --with-env, the .env
#   • a single .dump file (backup.sh or Settings → Backups) → restores the database only
# The control + worker containers are stopped during the restore and started again afterwards.
# IMPORTANT: encrypted values (env vars, DB credentials) need the ENCRYPTION_KEY of the server the backup came from
# (use --with-env when restoring onto a fresh server).
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail
INSTALL_DIR="${LEVANT_INSTALL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="$INSTALL_DIR/.env"
SRC=""
WITH_ENV=0
YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --with-env) WITH_ENV=1; shift ;;
    -y | --yes) YES=1; shift ;;
    -h | --help) sed -n '2,13p' "$0"; exit 0 ;;
    -*) echo "unknown option $1" >&2; exit 1 ;;
    *) SRC="$1"; shift ;;
  esac
done
die() { echo "restore failed: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run as root"
[ -n "$SRC" ] || die "usage: restore.sh <backup dir | file.dump> [--with-env] [--yes]"
[ -e "$SRC" ] || die "$SRC not found"
[ -f "$ENV_FILE" ] || die "$ENV_FILE not found — run install.sh first (use --no-start), then restore"

if [ -d "$SRC" ]; then DUMP="$SRC/db.dump"; STORAGE="$SRC/storage.tar.gz"; ENVBAK="$SRC/env"; else DUMP="$SRC"; STORAGE=""; ENVBAK=""; fi
[ -s "$DUMP" ] || die "no database dump at $DUMP"

echo "This replaces the LevantDeploy database${STORAGE:+ and storage} with the backup:"
echo "  $SRC"
if [ "$YES" = 0 ]; then
  read -r -p "Type 'restore' to continue: " a </dev/tty
  [ "$a" = restore ] || die "aborted"
fi

if [ "$WITH_ENV" = 1 ]; then
  [ -f "$ENVBAK" ] || die "--with-env: no env file in the backup"
  cp "$ENV_FILE" "$ENV_FILE.before-restore.$(date +%s)"
  cp "$ENVBAK" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "→ .env restored (previous one kept as .env.before-restore.*)"
fi

env_get() { { grep -E "^$1=" "$ENV_FILE" || true; } | tail -n1 | cut -d= -f2-; }
DATA_DIR="$(env_get LEVANT_DATA_DIR)"; DATA_DIR="${DATA_DIR:-/var/lib/levantdeploy}"
COMPOSE=(docker compose --project-directory "$INSTALL_DIR" --env-file "$ENV_FILE")

echo "→ stopping control + worker"
"${COMPOSE[@]}" stop control worker >/dev/null 2>&1 || true
"${COMPOSE[@]}" up -d postgres redis >/dev/null
for _ in $(seq 1 60); do
  # shellcheck disable=SC2016
  "${COMPOSE[@]}" exec -T postgres sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1 && break
  sleep 1
done

echo "→ restoring the database"
# shellcheck disable=SC2016 # expanded inside the postgres container
"${COMPOSE[@]}" exec -T postgres sh -c '
  set -e
  psql -q -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE IF EXISTS \"$POSTGRES_DB\" WITH (FORCE)"
  psql -q -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE \"$POSTGRES_DB\" OWNER \"$POSTGRES_USER\""
  pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error
' < "$DUMP"

if [ -n "$STORAGE" ] && [ -f "$STORAGE" ]; then
  echo "→ restoring storage into $DATA_DIR"
  tar -C "$DATA_DIR" -xzf "$STORAGE"
  chown -R 1000:1000 "$DATA_DIR/storage"
fi

# queued jobs / live log streams in Redis refer to the old state
echo "→ clearing transient Redis state"
# shellcheck disable=SC2016
"${COMPOSE[@]}" exec -T redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning FLUSHALL' >/dev/null

echo "→ starting LevantDeploy"
"${COMPOSE[@]}" up -d
echo "✓ restored. The worker re-creates proxy routes on start; redeploy apps whose containers no longer exist."
