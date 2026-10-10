#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# LevantDeploy installer — Ubuntu 22.04 / 24.04, Debian 12 (x86_64 / arm64)
#
#   From a checkout / unzipped release:
#     sudo bash install/install.sh --domain example.com --email you@example.com
#   One-liner (the source tarball / git URL must be reachable from the server):
#     curl -fsSL https://<host>/install.sh | sudo bash -s -- --source https://<host>/levantdeploy.tar.gz --domain example.com
#
# Idempotent: re-running keeps existing secrets and data, applies new flags (e.g. a new --domain) and restarts.
# Everything lives in /opt/levantdeploy (compose project + .env) and /var/lib/levantdeploy (storage, builds, backups).
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail

INSTALL_DIR="${LEVANT_INSTALL_DIR:-/opt/levantdeploy}"
DATA_DIR="${LEVANT_DATA_DIR:-/var/lib/levantdeploy}"
SOURCE="${LEVANT_SOURCE:-}"
DOMAIN=""
DASHBOARD_HOST=""
EMAIL=""
OWNER_EMAIL=""
OWNER_NAME=""
OWNER_PASSWORD="${LEVANT_OWNER_PASSWORD:-}"
TLS_MODE=""
HTTP_PORT=""
HTTPS_PORT=""
SERVER_IP=""
ASSUME_YES=0
SKIP_DOCKER=0
SKIP_FIREWALL=0
SKIP_OWNER=0
SKIP_START=0
FORCE_OS=0
BACKUP_CRON=1
BASE_DOMAIN=""
BASE_DB_PORTS=""
PREFETCH_BASE=0
BASE_IMAGE_MIRROR="${BASE_IMAGE_MIRROR:-}"
BASE_EGRESS_PROXY="${BASE_EGRESS_PROXY:-}"
BASE_EGRESS_CA=""
SKIP_BUILDER_IMAGE=0
BUILD_PROXY=""
BUILD_CA=""
BUILD_NODE_IMAGE=""

# ── output helpers ──────────────────────────────────────────────────────────
if [ -t 1 ]; then B=$'\e[1m'; D=$'\e[2m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'; else B='' D='' G='' Y='' R='' C='' N=''; fi
step() { printf '\n%s==>%s %s%s%s\n' "$C" "$N" "$B" "$*" "$N"; }
info() { printf '    %s\n' "$*"; }
ok() { printf '    %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '    %s!%s %s\n' "$Y" "$N" "$*" >&2; }
die() { printf '\n%sError:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }
trap 'die "install failed at line $LINENO (exit $?). Re-run the installer after fixing the problem — it is safe to run again."' ERR

usage() {
  cat <<EOF
LevantDeploy installer

Usage: sudo bash install.sh [options]

  --domain <domain>          platform domain; apps get {project}.<domain> (wildcard DNS *.<domain> → this server)
  --dashboard-host <host>    dashboard hostname (default: deploy.<domain>)
  --email <email>            ACME (Let's Encrypt) contact + default owner email
  --owner-email <email>      first account (platform owner)          [default: --email]
  --owner-name <name>        owner display name                      [default: Owner]
  --owner-password <pw>      owner password (or env LEVANT_OWNER_PASSWORD; prompted if missing)
  --no-owner                 don't create the owner account (sign up in the browser instead — the first account becomes owner)
  --source <path|git|url>    LevantDeploy source: a local checkout, a git URL or a .tar.gz/.zip URL
                             [default: the checkout this script lives in]
  --dir <path>               install directory                        [default: /opt/levantdeploy]
  --data-dir <path>          data directory (storage, builds, backups) [default: /var/lib/levantdeploy]
  --tls <acme|internal|off>  acme = public certificates (default), internal = Caddy's local CA, off = plain HTTP
  --http-port <n>            host port for HTTP  [default: 80]
  --https-port <n>           host port for HTTPS [default: 443]
  --ip <address>             public IPv4 of this server (auto-detected)

  LevantBase (backend projects):
  --base-domain <domain>     API/Studio domain for backends: {ref}.<base domain>   [default: base.<domain>]
  --base-db-ports            allow public Postgres ports for backends: opens BASE_DB_PORT_RANGE (54000-54999) in ufw
  --prefetch-base-images     pull the pinned backend images now, so the first backend starts fast (~3 GB)
  --base-image-mirror <host> registry mirror for the backend images, e.g. mirror.gcr.io (Docker Hub rate limits)
  --base-egress-proxy <url>  HTTP(S) proxy for backends' outbound traffic (servers behind a proxy)
  --base-egress-ca <file>    CA bundle (PEM) for that proxy; copied into the data directory

  AI Builder:
  --skip-builder-image       don't build the preview runtime image levant/builder-runtime:next15 (~1.2 GB) now
  --build-proxy <url>        HTTP(S) proxy for building the platform's own images (servers behind a proxy)
  --build-ca <file>          CA bundle (PEM) of that proxy
  --build-node-image <ref>   Node base image for the runtime image, e.g. mirror.gcr.io/library/node:22-slim
  --skip-docker              don't install Docker (must already be installed)
  --no-firewall              don't configure ufw
  --no-backup-cron           don't install the nightly backup cron job
  --no-start                 write the configuration but don't build/start the stack
  --force-os                 continue on an unsupported OS
  -y, --yes                  non-interactive: never prompt
  -h, --help                 this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --dashboard-host) DASHBOARD_HOST="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --owner-email) OWNER_EMAIL="${2:-}"; shift 2 ;;
    --owner-name) OWNER_NAME="${2:-}"; shift 2 ;;
    --owner-password) OWNER_PASSWORD="${2:-}"; shift 2 ;;
    --no-owner) SKIP_OWNER=1; shift ;;
    --source) SOURCE="${2:-}"; shift 2 ;;
    --dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --data-dir) DATA_DIR="${2:-}"; shift 2 ;;
    --tls) TLS_MODE="${2:-}"; shift 2 ;;
    --http-port) HTTP_PORT="${2:-}"; shift 2 ;;
    --https-port) HTTPS_PORT="${2:-}"; shift 2 ;;
    --ip) SERVER_IP="${2:-}"; shift 2 ;;
    --base-domain) BASE_DOMAIN="${2:-}"; shift 2 ;;
    --base-db-ports) BASE_DB_PORTS=1; shift ;;
    --prefetch-base-images) PREFETCH_BASE=1; shift ;;
    --base-image-mirror) BASE_IMAGE_MIRROR="${2:-}"; shift 2 ;;
    --base-egress-proxy) BASE_EGRESS_PROXY="${2:-}"; shift 2 ;;
    --base-egress-ca) BASE_EGRESS_CA="${2:-}"; shift 2 ;;
    --skip-builder-image) SKIP_BUILDER_IMAGE=1; shift ;;
    --build-proxy) BUILD_PROXY="${2:-}"; shift 2 ;;
    --build-ca) BUILD_CA="${2:-}"; shift 2 ;;
    --build-node-image) BUILD_NODE_IMAGE="${2:-}"; shift 2 ;;
    --skip-docker) SKIP_DOCKER=1; shift ;;
    --no-firewall) SKIP_FIREWALL=1; shift ;;
    --no-backup-cron) BACKUP_CRON=0; shift ;;
    --no-start) SKIP_START=1; shift ;;
    --force-os) FORCE_OS=1; shift ;;
    -y | --yes) ASSUME_YES=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

# Prompts read from the terminal even when the script itself arrives on stdin (curl | bash).
TTY=""
if [ "$ASSUME_YES" = 0 ] && { exec 3</dev/tty; } 2>/dev/null; then TTY=1; fi
ask() { # ask <var> <prompt> [default] [secret]
  local __var="$1" __prompt="$2" __def="${3:-}" __secret="${4:-}" __ans=""
  if [ -z "$TTY" ]; then printf -v "$__var" '%s' "$__def"; return; fi
  if [ -n "$__secret" ]; then
    read -r -s -u 3 -p "    $__prompt: " __ans; echo
  else
    read -r -u 3 -p "    $__prompt${__def:+ [$__def]}: " __ans
  fi
  printf -v "$__var" '%s' "${__ans:-$__def}"
}

env_get() { # env_get <file> <key>
  [ -f "$1" ] || return 0
  { grep -E "^$2=" "$1" || true; } | tail -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'
}
env_set() { # env_set <file> <key> <value>  (replace or append; value written verbatim)
  local f="$1" k="$2" v="$3" tmp
  tmp="$(mktemp)"
  if grep -qE "^$k=" "$f" 2>/dev/null; then
    awk -v k="$k" -v v="$v" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' "$f" > "$tmp"
  else
    cat "$f" > "$tmp" 2>/dev/null || true
    printf '%s=%s\n' "$k" "$v" >> "$tmp"
  fi
  cat "$tmp" > "$f"
  rm -f "$tmp"
}
secret() { openssl rand -hex "${1:-32}"; }
valid_host() { [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ ]]; }

# ── 1. preflight ────────────────────────────────────────────────────────────
step "Checking the system"
[ "$(id -u)" -eq 0 ] || die "run as root (sudo bash install.sh …)"
[ -r /etc/os-release ] || die "cannot detect the OS (/etc/os-release missing)"
# shellcheck disable=SC1091
. /etc/os-release
OS_ID="${ID:-unknown}"
OS_VER="${VERSION_ID:-}"
case "$OS_ID:$OS_VER" in
  ubuntu:22.04 | ubuntu:24.04 | debian:12) ok "$PRETTY_NAME" ;;
  *)
    if [ "$FORCE_OS" = 1 ]; then warn "$PRETTY_NAME is not tested — continuing (--force-os)"
    else die "$PRETTY_NAME is not supported (Ubuntu 22.04/24.04 or Debian 12). Use --force-os to try anyway."; fi ;;
esac
ARCH="$(uname -m)"
case "$ARCH" in x86_64 | aarch64 | arm64) ok "architecture $ARCH" ;; *) die "unsupported architecture $ARCH" ;; esac
MEM_MB=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
if [ "$MEM_MB" -ge 1800 ]; then ok "memory ${MEM_MB} MB"; else warn "only ${MEM_MB} MB RAM — 2 GB+ recommended (builds of Next.js apps need ~1.5 GB)"; fi
mkdir -p "$(dirname "$DATA_DIR")"
DISK_GB=$(df -Pk "$(dirname "$DATA_DIR")" | awk 'NR==2{print int($4/1024/1024)}')
if [ "$DISK_GB" -ge 15 ]; then ok "disk ${DISK_GB} GB free"; else warn "only ${DISK_GB} GB free disk — 20 GB+ recommended"; fi

export DEBIAN_FRONTEND=noninteractive
need_pkgs=()
for bin in curl openssl git; do command -v "$bin" >/dev/null 2>&1 || need_pkgs+=("$bin"); done
command -v gpg >/dev/null 2>&1 || need_pkgs+=(gnupg)
command -v tar >/dev/null 2>&1 || need_pkgs+=(tar)
command -v unzip >/dev/null 2>&1 || need_pkgs+=(unzip)
[ -e /etc/ssl/certs/ca-certificates.crt ] || need_pkgs+=(ca-certificates)
if [ "${#need_pkgs[@]}" -gt 0 ]; then
  info "installing ${need_pkgs[*]}"
  apt-get update -qq && apt-get install -y -qq "${need_pkgs[@]}" >/dev/null
fi
ok "base tools"

# ── 2. Docker Engine + compose plugin ───────────────────────────────────────
step "Docker"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "$(docker --version)"
  ok "$(docker compose version)"
elif [ "$SKIP_DOCKER" = 1 ]; then
  die "Docker with the compose plugin is required (--skip-docker given)"
else
  info "installing Docker Engine from download.docker.com"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${OS_ID}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${OS_ID} ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  systemctl enable --now docker >/dev/null 2>&1 || true
  ok "$(docker --version)"
fi
docker info >/dev/null 2>&1 || die "the Docker daemon is not running (systemctl start docker)"
systemctl enable docker >/dev/null 2>&1 || true # containers restart on boot (restart: unless-stopped)

# ── 3. source code ──────────────────────────────────────────────────────────
step "LevantDeploy source → $INSTALL_DIR"
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; fi
if [ -z "$SOURCE" ] && [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/../docker-compose.yml" ] && [ -d "$SCRIPT_DIR/../control" ]; then
  SOURCE="$(cd "$SCRIPT_DIR/.." && pwd)"
fi
if [ -z "$SOURCE" ] && [ -f "$INSTALL_DIR/docker-compose.yml" ]; then SOURCE="$INSTALL_DIR"; fi
[ -n "$SOURCE" ] || die "no source: pass --source <checkout path | git URL | .tar.gz/.zip URL>"

mkdir -p "$INSTALL_DIR"
sync_tree() { # copy a source tree into INSTALL_DIR, keeping .env and local state
  local src="$1"
  tar -C "$src" --exclude=./.env --exclude='./control/node_modules' --exclude='./control/.next*' --exclude='./control/*.tsbuildinfo' --exclude='./control/storage*' \
      --exclude='./control/dist' --exclude='./control/.env' --exclude='./cli/node_modules' --exclude='./builder-template/*/node_modules' --exclude='./builder-template/*/.next' --exclude='./.git' -cf - . | tar -C "$INSTALL_DIR" -xf -
}
if [ -d "$SOURCE" ]; then
  SRC_ABS="$(cd "$SOURCE" && pwd)"
  if [ "$SRC_ABS" != "$(cd "$INSTALL_DIR" && pwd)" ]; then sync_tree "$SRC_ABS"; ok "copied from $SRC_ABS"; else ok "using $INSTALL_DIR"; fi
elif [[ "$SOURCE" =~ \.(tar\.gz|tgz|zip)(\?.*)?$ ]]; then
  tmp="$(mktemp -d)"
  curl -fsSL "$SOURCE" -o "$tmp/src.pkg"
  mkdir -p "$tmp/x"
  if [[ "$SOURCE" =~ \.zip ]]; then unzip -q "$tmp/src.pkg" -d "$tmp/x"; else tar -xzf "$tmp/src.pkg" -C "$tmp/x"; fi
  root="$(dirname "$(find "$tmp/x" -maxdepth 3 -name docker-compose.yml -path '*' | head -n1)")"
  [ -d "$root/control" ] || die "the archive does not contain docker-compose.yml + control/"
  sync_tree "$root"
  rm -rf "$tmp"
  ok "downloaded $SOURCE"
else
  if [ -d "$INSTALL_DIR/.git" ]; then
    git -C "$INSTALL_DIR" pull --ff-only
  else
    tmp="$(mktemp -d)"
    git clone --depth 1 "$SOURCE" "$tmp/src"
    sync_tree "$tmp/src"
    rm -rf "$tmp"
  fi
  ok "cloned $SOURCE"
fi
[ -f "$INSTALL_DIR/docker-compose.yml" ] || die "$INSTALL_DIR/docker-compose.yml missing after copying the source"
chmod +x "$INSTALL_DIR"/install/*.sh 2>/dev/null || true

# ── 4. configuration (.env) ─────────────────────────────────────────────────
step "Configuration"
ENV_FILE="$INSTALL_DIR/.env"
FIRST_INSTALL=0
[ -f "$ENV_FILE" ] || FIRST_INSTALL=1
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

DOMAIN="${DOMAIN:-$(env_get "$ENV_FILE" PLATFORM_DOMAIN)}"
[ -n "$DOMAIN" ] || ask DOMAIN "Platform domain for your apps (e.g. example.com)"
DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]' | sed -e 's#^https\?://##' -e 's#/.*$##')"
valid_host "$DOMAIN" || die "invalid --domain '$DOMAIN'"

DASHBOARD_HOST="${DASHBOARD_HOST:-$(env_get "$ENV_FILE" DASHBOARD_HOST)}"
[ -n "$DASHBOARD_HOST" ] || ask DASHBOARD_HOST "Dashboard host" "deploy.$DOMAIN"
DASHBOARD_HOST="$(printf '%s' "$DASHBOARD_HOST" | tr '[:upper:]' '[:lower:]' | sed -e 's#^https\?://##' -e 's#/.*$##')"
valid_host "${DASHBOARD_HOST%%:*}" || die "invalid --dashboard-host '$DASHBOARD_HOST'"

EMAIL="${EMAIL:-$(env_get "$ENV_FILE" ACME_EMAIL)}"
[ -n "$EMAIL" ] || ask EMAIL "Email for Let's Encrypt notices (and the owner account)"
[ -z "$EMAIL" ] || [[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "invalid --email '$EMAIL'"

TLS_MODE="${TLS_MODE:-$(env_get "$ENV_FILE" TLS_MODE)}"
TLS_MODE="${TLS_MODE:-acme}"
case "$TLS_MODE" in acme | internal | off) ;; *) die "--tls must be acme, internal or off" ;; esac
SCHEME=https; [ "$TLS_MODE" = off ] && SCHEME=http
HTTP_PORT="${HTTP_PORT:-$(env_get "$ENV_FILE" HTTP_PORT)}"; HTTP_PORT="${HTTP_PORT:-80}"
HTTPS_PORT="${HTTPS_PORT:-$(env_get "$ENV_FILE" HTTPS_PORT)}"; HTTPS_PORT="${HTTPS_PORT:-443}"

BASE_DOMAIN="${BASE_DOMAIN:-$(env_get "$ENV_FILE" BASE_DOMAIN)}"
BASE_DOMAIN="$(printf '%s' "${BASE_DOMAIN:-base.$DOMAIN}" | tr '[:upper:]' '[:lower:]' | sed -e 's#^https\?://##' -e 's#/.*$##')"
valid_host "$BASE_DOMAIN" || die "invalid --base-domain '$BASE_DOMAIN'"
BASE_DB_PORTS="${BASE_DB_PORTS:-$(env_get "$ENV_FILE" BASE_DB_PUBLIC_PORTS)}"
BASE_DB_PORT_RANGE="$(env_get "$ENV_FILE" BASE_DB_PORT_RANGE)"; BASE_DB_PORT_RANGE="${BASE_DB_PORT_RANGE:-54000-54999}"
[[ "$BASE_DB_PORT_RANGE" =~ ^[0-9]+-[0-9]+$ ]] || die "BASE_DB_PORT_RANGE must look like 54000-54999"

if [ -z "$SERVER_IP" ]; then
  SERVER_IP="$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || curl -4 -fsS --max-time 5 https://ifconfig.me/ip 2>/dev/null || true)"
  [ -n "$SERVER_IP" ] || SERVER_IP="$(env_get "$ENV_FILE" SERVER_IPS | cut -d, -f1)"
  [ -n "$SERVER_IP" ] || SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi

port_suffix=""
if [ "$SCHEME" = https ] && [ "$HTTPS_PORT" != 443 ]; then port_suffix=":$HTTPS_PORT"; fi
if [ "$SCHEME" = http ] && [ "$HTTP_PORT" != 80 ]; then port_suffix=":$HTTP_PORT"; fi

DOCKER_GID="$(stat -c %g /var/run/docker.sock)"

# secrets: generated once, never rotated by re-runs (ENCRYPTION_KEY protects stored env vars!)
for k in POSTGRES_PASSWORD REDIS_PASSWORD; do [ -n "$(env_get "$ENV_FILE" "$k")" ] || env_set "$ENV_FILE" "$k" "$(secret 24)"; done
for k in ENCRYPTION_KEY SESSION_SECRET; do [ -n "$(env_get "$ENV_FILE" "$k")" ] || env_set "$ENV_FILE" "$k" "$(secret 32)"; done
[ -n "$(env_get "$ENV_FILE" COMPOSE_PROJECT_NAME)" ] || env_set "$ENV_FILE" COMPOSE_PROJECT_NAME levantdeploy
env_set "$ENV_FILE" PLATFORM_DOMAIN "$DOMAIN"
env_set "$ENV_FILE" DASHBOARD_HOST "$DASHBOARD_HOST"
env_set "$ENV_FILE" PLATFORM_SCHEME "$SCHEME"
env_set "$ENV_FILE" APP_URL "$SCHEME://${DASHBOARD_HOST%%:*}$port_suffix"
env_set "$ENV_FILE" ACME_EMAIL "$EMAIL"
env_set "$ENV_FILE" TLS_MODE "$TLS_MODE"
env_set "$ENV_FILE" HTTP_PORT "$HTTP_PORT"
env_set "$ENV_FILE" HTTPS_PORT "$HTTPS_PORT"
env_set "$ENV_FILE" SERVER_IPS "$SERVER_IP"
env_set "$ENV_FILE" LEVANT_DATA_DIR "$DATA_DIR"
env_set "$ENV_FILE" LEVANT_INSTALL_DIR "$INSTALL_DIR"
env_set "$ENV_FILE" DOCKER_GID "$DOCKER_GID"
[ -n "$(env_get "$ENV_FILE" REGISTRATION)" ] || env_set "$ENV_FILE" REGISTRATION invite
# LevantBase
env_set "$ENV_FILE" BASE_DOMAIN "$BASE_DOMAIN"
env_set "$ENV_FILE" BASE_DB_PORT_RANGE "$BASE_DB_PORT_RANGE"
env_set "$ENV_FILE" BASE_DB_PUBLIC_PORTS "${BASE_DB_PORTS:-0}"
[ -z "$BASE_IMAGE_MIRROR" ] && [ -n "$(env_get "$ENV_FILE" BASE_IMAGE_MIRROR)" ] || env_set "$ENV_FILE" BASE_IMAGE_MIRROR "$BASE_IMAGE_MIRROR"
[ -z "$BASE_EGRESS_PROXY" ] && [ -n "$(env_get "$ENV_FILE" BASE_EGRESS_PROXY)" ] || env_set "$ENV_FILE" BASE_EGRESS_PROXY "$BASE_EGRESS_PROXY"
[ -n "$(env_get "$ENV_FILE" BASE_EGRESS_CA_FILE)" ] || env_set "$ENV_FILE" BASE_EGRESS_CA_FILE ""
# build proxy for the platform's own images (kept for update.sh)
[ -z "$BUILD_PROXY" ] || env_set "$ENV_FILE" LEVANT_BUILD_PROXY "$BUILD_PROXY"
[ -z "$BUILD_NODE_IMAGE" ] || env_set "$ENV_FILE" LEVANT_BUILD_NODE_IMAGE "$BUILD_NODE_IMAGE"
if [ -n "$BUILD_CA" ]; then
  [ -s "$BUILD_CA" ] || die "--build-ca: $BUILD_CA not found"
  install -m 644 "$BUILD_CA" "$INSTALL_DIR/.build-ca.pem"
  env_set "$ENV_FILE" LEVANT_BUILD_CA_FILE "$INSTALL_DIR/.build-ca.pem"
fi
[ -n "$(env_get "$ENV_FILE" DOCKER_NETWORK)" ] || env_set "$ENV_FILE" DOCKER_NETWORK levant_net
ok "$ENV_FILE ($([ $FIRST_INSTALL = 1 ] && echo created || echo updated), mode 600)"
info "dashboard  $SCHEME://${DASHBOARD_HOST%%:*}$port_suffix"
info "apps       $SCHEME://<project>.$DOMAIN$port_suffix"
info "backends   $SCHEME://<ref>.$BASE_DOMAIN$port_suffix"
info "server IP  ${SERVER_IP:-unknown}"

# data directory (mounted at the same path in control + worker; owned by the image's uid 1000)
mkdir -p "$DATA_DIR/storage" "$DATA_DIR/work" "$DATA_DIR/backups"
chown 1000:1000 "$DATA_DIR" "$DATA_DIR/storage" "$DATA_DIR/work"
chmod 750 "$DATA_DIR"
ok "data directory $DATA_DIR"
if [ -n "$BASE_EGRESS_CA" ]; then
  [ -s "$BASE_EGRESS_CA" ] || die "--base-egress-ca: $BASE_EGRESS_CA not found"
  # inside the data dir = same path in the worker and for the host daemon (bind-mounted into backend stacks)
  install -m 644 "$BASE_EGRESS_CA" "$DATA_DIR/base-egress-ca.pem"
  env_set "$ENV_FILE" BASE_EGRESS_CA_FILE "$DATA_DIR/base-egress-ca.pem"
  ok "backend egress CA → $DATA_DIR/base-egress-ca.pem"
fi

# ── 5. firewall ─────────────────────────────────────────────────────────────
step "Firewall"
if [ "$SKIP_FIREWALL" = 1 ]; then
  info "skipped (--no-firewall)"
else
  command -v ufw >/dev/null 2>&1 || apt-get install -y -qq ufw >/dev/null
  SSH_PORT="$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}')"
  SSH_PORT="${SSH_PORT:-22}"
  ufw allow "$SSH_PORT/tcp" >/dev/null
  [ "$SSH_PORT" = 22 ] || ufw allow 22/tcp >/dev/null
  ufw allow "$HTTP_PORT/tcp" >/dev/null
  ufw allow "$HTTPS_PORT/tcp" >/dev/null
  ufw allow "$HTTPS_PORT/udp" >/dev/null
  ufw --force enable >/dev/null
  ok "ufw: allow ${SSH_PORT}/tcp (ssh), ${HTTP_PORT}/tcp, ${HTTPS_PORT}/tcp+udp"
  if [ "$BASE_DB_PORTS" = 1 ]; then
    ufw allow "${BASE_DB_PORT_RANGE/-/:}/tcp" >/dev/null
    ok "ufw: allow ${BASE_DB_PORT_RANGE}/tcp (public Postgres ports for backends)"
  fi
fi

# ── 6. nightly backup ───────────────────────────────────────────────────────
if [ "$BACKUP_CRON" = 1 ]; then
  cat > /etc/cron.d/levantdeploy-backup <<EOF
# LevantDeploy: nightly database + storage backup (install/backup.sh), keeps 7
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
41 2 * * * root $INSTALL_DIR/install/backup.sh --quiet >> /var/log/levantdeploy-backup.log 2>&1
EOF
  chmod 644 /etc/cron.d/levantdeploy-backup
fi

if [ "$SKIP_START" = 1 ]; then
  step "Done (not started: --no-start)"
  info "start with: cd $INSTALL_DIR && docker compose up -d --build"
  exit 0
fi

# ── 7. build + start ────────────────────────────────────────────────────────
step "Building and starting the stack (first build takes a few minutes)"
cd "$INSTALL_DIR"
COMPOSE=(docker compose --project-directory "$INSTALL_DIR" --env-file "$ENV_FILE")
if [ -n "$(env_get "$ENV_FILE" LEVANT_PULL)" ]; then "${COMPOSE[@]}" pull; else "${COMPOSE[@]}" build; fi
if [ "$SKIP_BUILDER_IMAGE" = 1 ]; then
  info "AI Builder runtime image: skipped (--skip-builder-image) — build it later with install/builder-image.sh"
else
  info "AI Builder preview runtime image"
  bash "$INSTALL_DIR/install/builder-image.sh" ensure || warn "could not build the Builder runtime image — previews stay unavailable until 'install/builder-image.sh build' succeeds"
fi
if [ "$PREFETCH_BASE" = 1 ]; then
  info "pulling the LevantBase images (backend projects)"
  BASE_IMAGE_MIRROR="$(env_get "$ENV_FILE" BASE_IMAGE_MIRROR)" bash "$INSTALL_DIR/install/base-images.sh" pull || warn "some backend images could not be pulled now; they are pulled when the first backend starts"
  bash "$INSTALL_DIR/install/base-images.sh" fingerprint > "$INSTALL_DIR/.base-images" 2>/dev/null || true
fi
"${COMPOSE[@]}" up -d --remove-orphans
ok "containers started"

step "Waiting for the dashboard to become healthy"
for i in $(seq 1 90); do
  state="$("${COMPOSE[@]}" ps --format '{{.Service}} {{.Health}}' 2>/dev/null | awk '$1=="control"{print $2}')"
  [ "$state" = healthy ] && break
  [ "$i" = 90 ] && { "${COMPOSE[@]}" logs --tail 60 control >&2 || true; die "the control container did not become healthy (see logs above)"; }
  sleep 2
done
ok "control is healthy"

# ── 8. owner account ────────────────────────────────────────────────────────
# shellcheck disable=SC2016 # expanded by the shell inside the postgres container
USERS="$("${COMPOSE[@]}" exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select count(*) from \"User\""' 2>/dev/null | tr -d '[:space:]' || echo "?")"
OWNER_CREATED=0
if [ "$SKIP_OWNER" = 1 ]; then
  info "owner account: skipped (--no-owner) — the first account you register becomes the platform owner"
elif [ "$USERS" != 0 ]; then
  ok "owner account already exists ($USERS user(s))"
else
  step "Creating the platform owner account"
  OWNER_EMAIL="${OWNER_EMAIL:-$EMAIL}"
  [ -n "$OWNER_EMAIL" ] || ask OWNER_EMAIL "Owner email"
  OWNER_NAME="${OWNER_NAME:-Owner}"
  if [ -z "$OWNER_PASSWORD" ]; then
    if [ -n "$TTY" ]; then
      while :; do
        ask OWNER_PASSWORD "Owner password (8+ chars, letters and numbers)" "" secret
        ask p2 "Repeat password" "" secret
        [ "$OWNER_PASSWORD" = "${p2:-}" ] && [ "${#OWNER_PASSWORD}" -ge 8 ] && break
        warn "passwords differ or are shorter than 8 characters"
      done
    else
      OWNER_PASSWORD="$(secret 9)A1"
      GENERATED_PASSWORD=1
    fi
  fi
  if [ -z "$OWNER_EMAIL" ]; then
    warn "no owner email — open the dashboard and register: the first account becomes the platform owner"
  else
    # Registers through the real API (first account → platform owner + personal team). Credentials go via env, not argv.
    out="$("${COMPOSE[@]}" exec -T -e OWNER_EMAIL="$OWNER_EMAIL" -e OWNER_NAME="$OWNER_NAME" -e OWNER_PASSWORD="$OWNER_PASSWORD" control node -e '
      fetch("http://127.0.0.1:" + (process.env.PORT || 3000) + "/api/v1/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "127.0.0.1" },
        body: JSON.stringify({ name: process.env.OWNER_NAME, email: process.env.OWNER_EMAIL, password: process.env.OWNER_PASSWORD }),
      }).then(async (r) => { const t = await r.text(); console.log(r.status + " " + t.slice(0, 300)); process.exit(r.status === 201 ? 0 : 1); })
        .catch((e) => { console.log("ERR " + e.message); process.exit(1); });
    ' 2>&1)" || die "could not create the owner account: $out"
    OWNER_CREATED=1
    ok "owner $OWNER_EMAIL created"
  fi
fi

# ── 9. summary ──────────────────────────────────────────────────────────────
DASH="${DASHBOARD_HOST%%:*}"
step "LevantDeploy is running"
cat <<EOF

  ${B}1. Add these DNS records${N} at your DNS provider (TTL 300 is fine):

     Type  Name                        Value
     A     ${DASH}$(printf '%*s' $((26 - ${#DASH})) '')  ${SERVER_IP:-<server IP>}
     A     *.${DOMAIN}$(printf '%*s' $((24 - ${#DOMAIN})) '')  ${SERVER_IP:-<server IP>}
     A     *.${BASE_DOMAIN}$(printf '%*s' $((24 - ${#BASE_DOMAIN})) '')  ${SERVER_IP:-<server IP>}     (backends: API + Studio)

     ${D}Cloudflare: use "DNS only" (grey cloud), or keep the proxy on with SSL mode "Full".${N}
     ${D}*.${BASE_DOMAIN} may also be a CNAME to ${DASH}. A wildcard covers one level only, so *.${DOMAIN} does NOT cover it.${N}
     ${D}Check: dig +short ${DASH}   dig +short test.${DOMAIN}   dig +short test.${BASE_DOMAIN}${N}

  ${B}2. Open the dashboard${N}

     ${SCHEME}://${DASH}${port_suffix}
EOF
if [ "$OWNER_CREATED" = 1 ]; then
  echo "     log in as ${OWNER_EMAIL}"
  if [ "${GENERATED_PASSWORD:-0}" = 1 ]; then
    echo "     generated password: ${B}${OWNER_PASSWORD}${N}   ${Y}(shown once — change it under Account settings)${N}"
  fi
elif [ "$USERS" = 0 ]; then
  echo "     register the first account — it becomes the platform owner"
fi
cat <<EOF

  ${B}3. Add your AI provider keys${N} in Settings → AI providers (AI Builder + agent)

  ${B}4. Deploy something${N}

     npm i -g ${SCHEME}://${DASH}${port_suffix}/api/cli/levant.tgz
     levant login --server ${SCHEME}://${DASH}${port_suffix}
     levant deploy

  ${D}Manage:   cd ${INSTALL_DIR} && docker compose ps | logs -f control worker
  Update:   sudo ${INSTALL_DIR}/install/update.sh
  Backup:   sudo ${INSTALL_DIR}/install/backup.sh   (nightly at 02:41 via /etc/cron.d/levantdeploy-backup)
  Docs:     ${INSTALL_DIR}/docs/INSTALL.md, DOMAINS.md, USAGE.md${N}

EOF
