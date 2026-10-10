#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# LevantDeploy backup: control database (pg_dump custom format) + storage (logs, uploads, DB add-on backups,
# control-DB dumps) + the .env (holds ENCRYPTION_KEY — without it encrypted env vars cannot be restored).
#
#   sudo /opt/levantdeploy/install/backup.sh [--dest DIR] [--keep N] [--db-only] [--quiet]
#
# Output: DEST/levantdeploy-YYYYmmdd-HHMMSS/{db.dump, storage.tar.gz, env, MANIFEST}; the newest N are kept.
# Not included: build workspaces/caches (re-creatable) and data inside app containers' Docker volumes
# (use the Databases → Backups feature for add-on databases).
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail
INSTALL_DIR="${LEVANT_INSTALL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="$INSTALL_DIR/.env"
DEST=""
KEEP=7
DB_ONLY=0
QUIET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    --db-only) DB_ONLY=1; shift ;;
    --quiet) QUIET=1; shift ;;
    -h | --help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
done
log() { [ "$QUIET" = 1 ] || echo "$*"; }
die() { echo "backup failed: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run as root"
[ -f "$ENV_FILE" ] || die "$ENV_FILE not found (is LevantDeploy installed in $INSTALL_DIR?)"
[[ "$KEEP" =~ ^[0-9]+$ ]] && [ "$KEEP" -ge 1 ] || die "--keep must be a positive number"

env_get() { { grep -E "^$1=" "$ENV_FILE" || true; } | tail -n1 | cut -d= -f2-; }
DATA_DIR="$(env_get LEVANT_DATA_DIR)"; DATA_DIR="${DATA_DIR:-/var/lib/levantdeploy}"
DEST="${DEST:-$DATA_DIR/backups}"
COMPOSE=(docker compose --project-directory "$INSTALL_DIR" --env-file "$ENV_FILE")

ts="$(date -u +%Y%m%d-%H%M%S)"
out="$DEST/levantdeploy-$ts"
mkdir -p "$out"
chmod 700 "$DEST" "$out"
trap 'rm -rf "$out"; die "line $LINENO"' ERR

log "→ database"
# shellcheck disable=SC2016 # expanded inside the postgres container
"${COMPOSE[@]}" exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --compress=6 --no-owner' > "$out/db.dump"
[ -s "$out/db.dump" ] || die "empty database dump"

cp "$ENV_FILE" "$out/env"
chmod 600 "$out/env"

if [ "$DB_ONLY" = 0 ] && [ -d "$DATA_DIR/storage" ]; then
  log "→ storage ($DATA_DIR/storage)"
  tar -C "$DATA_DIR" --exclude='./storage/work' --exclude='./storage/cache' --exclude='./storage/backups/control/*.partial' \
      -czf "$out/storage.tar.gz" ./storage
fi

{
  echo "created=$ts"
  echo "version=$(grep -m1 '"version"' "$INSTALL_DIR/control/package.json" 2>/dev/null | cut -d'"' -f4)"
  echo "db_only=$DB_ONLY"
  (cd "$out" && sha256sum db.dump env storage.tar.gz 2>/dev/null || true)
} > "$out/MANIFEST"
trap - ERR

# rotation: keep the newest $KEEP backup directories
mapfile -t all < <(find "$DEST" -maxdepth 1 -type d -name 'levantdeploy-*' | sort -r)
for old in "${all[@]:$KEEP}"; do rm -rf -- "$old"; done

log "✓ $out ($(du -sh "$out" | cut -f1))"
