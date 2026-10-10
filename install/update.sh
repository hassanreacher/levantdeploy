#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# LevantDeploy update
#
#   sudo /opt/levantdeploy/install/update.sh [--source <path|git URL|tar.gz/zip URL>] [--no-backup] [--yes]
#
# 1. backs up the database (install/backup.sh --db-only)
# 2. fetches the new source (git pull when the install dir is a git checkout, or --source)
# 3. rebuilds the images (or pulls them when LEVANT_PULL=1 is set in .env); pulls new LevantBase images on version bumps
# 4. recreates the containers — migrations run automatically when the control container starts
# Deployed apps are separate containers and keep running during the update.
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail
INSTALL_DIR="${LEVANT_INSTALL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="$INSTALL_DIR/.env"
SOURCE=""
BACKUP=1
while [ $# -gt 0 ]; do
  case "$1" in
    --source) SOURCE="$2"; shift 2 ;;
    --no-backup) BACKUP=0; shift ;;
    -y | --yes) shift ;;
    -h | --help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
done
die() { echo "update failed: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run as root"
[ -f "$ENV_FILE" ] || die "$ENV_FILE not found"
COMPOSE=(docker compose --project-directory "$INSTALL_DIR" --env-file "$ENV_FILE")
env_get() { { grep -E "^$1=" "$ENV_FILE" || true; } | tail -n1 | cut -d= -f2-; }

before="$(grep -m1 '"version"' "$INSTALL_DIR/control/package.json" | cut -d'"' -f4)"

if [ "$BACKUP" = 1 ]; then
  echo "→ backing up the database"
  "$INSTALL_DIR/install/backup.sh" --db-only --keep 14
fi

echo "→ fetching the new version"
if [ -n "$SOURCE" ]; then
  # reuse the installer's source handling (keeps .env, data and secrets; --no-start: we restart below)
  bash "$INSTALL_DIR/install/install.sh" --source "$SOURCE" --dir "$INSTALL_DIR" --yes --no-start --no-firewall --skip-docker
elif [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" pull --ff-only
else
  echo "  (no --source and not a git checkout — rebuilding the current source)"
fi
after="$(grep -m1 '"version"' "$INSTALL_DIR/control/package.json" | cut -d'"' -f4)"

echo "→ building images ($before → $after)"
if [ "$(env_get LEVANT_PULL)" = 1 ]; then "${COMPOSE[@]}" pull; else "${COMPOSE[@]}" build --pull; fi

# LevantBase: pre-pull the backend images when this release pins new versions (existing backends keep their
# versions until upgraded from the dashboard; new backends and upgrades then start without waiting for pulls)
if [ -f "$INSTALL_DIR/install/base-images.sh" ]; then
  new_fp="$(bash "$INSTALL_DIR/install/base-images.sh" fingerprint 2>/dev/null || true)"
  old_fp="$(cat "$INSTALL_DIR/.base-images" 2>/dev/null || true)"
  if [ -n "$new_fp" ] && [ "$new_fp" != "$old_fp" ]; then
    echo "→ pulling LevantBase images (new pinned versions)"
    if bash "$INSTALL_DIR/install/base-images.sh" pull; then echo "$new_fp" > "$INSTALL_DIR/.base-images"
    else echo "  (some images could not be pulled now — they are pulled on first use)"; fi
  fi
fi

# AI Builder preview runtime: rebuilt only when builder-template/runtime or the template's dependencies changed
if [ -f "$INSTALL_DIR/install/builder-image.sh" ] && [ -d "$INSTALL_DIR/builder-template" ]; then
  echo "→ AI Builder runtime image"
  bash "$INSTALL_DIR/install/builder-image.sh" ensure || echo "  (Builder runtime image build failed — previews keep using the old image)"
fi

echo "→ restarting"
"${COMPOSE[@]}" up -d --remove-orphans
for i in $(seq 1 90); do
  state="$("${COMPOSE[@]}" ps --format '{{.Service}} {{.Health}}' 2>/dev/null | awk '$1=="control"{print $2}')"
  [ "$state" = healthy ] && break
  [ "$i" = 90 ] && { "${COMPOSE[@]}" logs --tail 80 control >&2; die "control did not become healthy — previous DB backup is in $(env_get LEVANT_DATA_DIR)/backups"; }
  sleep 2
done
docker image prune -f >/dev/null 2>&1 || true
echo "✓ LevantDeploy $after is running"
