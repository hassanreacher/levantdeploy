#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# LevantDeploy uninstall
#
#   sudo /opt/levantdeploy/install/uninstall.sh            stop + remove the platform containers (data kept)
#   sudo /opt/levantdeploy/install/uninstall.sh --apps     … and remove all deployed app containers + images
#   sudo /opt/levantdeploy/install/uninstall.sh --purge    … and delete ALL data: database, certificates,
#                                                          /var/lib/levantdeploy, /opt/levantdeploy (asks first)
# Docker itself is left installed.
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail
INSTALL_DIR="${LEVANT_INSTALL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="$INSTALL_DIR/.env"
APPS=0
PURGE=0
YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apps) APPS=1; shift ;;
    --purge) PURGE=1; APPS=1; shift ;;
    -y | --yes) YES=1; shift ;;
    -h | --help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
done
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "$ENV_FILE not found" >&2; exit 1; }
env_get() { { grep -E "^$1=" "$ENV_FILE" || true; } | tail -n1 | cut -d= -f2-; }
DATA_DIR="$(env_get LEVANT_DATA_DIR)"; DATA_DIR="${DATA_DIR:-/var/lib/levantdeploy}"
NETWORK="$(env_get DOCKER_NETWORK)"; NETWORK="${NETWORK:-levant_net}"
COMPOSE=(docker compose --project-directory "$INSTALL_DIR" --env-file "$ENV_FILE")

if [ "$PURGE" = 1 ] && [ "$YES" = 0 ]; then
  echo "This permanently deletes the LevantDeploy database, certificates, app containers and"
  echo "  $DATA_DIR and $INSTALL_DIR"
  read -r -p "Type 'delete everything' to continue: " a </dev/tty
  [ "$a" = "delete everything" ] || { echo "aborted"; exit 1; }
fi

if [ "$APPS" = 1 ]; then
  echo "→ removing deployed app containers"
  docker ps -aq --filter label=levant.managed=true | xargs -r docker rm -f >/dev/null
  docker images -q --filter label=levant.managed=true | sort -u | xargs -r docker rmi -f >/dev/null 2>&1 || true
  if [ "$PURGE" = 1 ]; then docker volume ls -q --filter label=levant.managed=true | xargs -r docker volume rm -f >/dev/null; fi
fi

echo "→ stopping the platform"
if [ "$PURGE" = 1 ]; then "${COMPOSE[@]}" down -v --remove-orphans; else "${COMPOSE[@]}" down --remove-orphans; fi
docker network rm "$NETWORK" >/dev/null 2>&1 || true
rm -f /etc/cron.d/levantdeploy-backup

if [ "$PURGE" = 1 ]; then
  rm -rf -- "$DATA_DIR"
  cd /
  rm -rf -- "$INSTALL_DIR"
  echo "✓ LevantDeploy removed completely"
else
  echo "✓ stopped. Data kept in $DATA_DIR and Docker volumes; start again with: cd $INSTALL_DIR && docker compose up -d"
fi
