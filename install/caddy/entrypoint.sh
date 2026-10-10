#!/bin/sh
# LevantDeploy Caddy entrypoint (ops area).
# Renders /etc/caddy/base.json.tmpl from env into /config/levant/base.json and runs Caddy with --resume:
#   • the autosaved config (routes pushed by the control plane via the admin API) survives restarts;
#   • when the rendered base changes (new DASHBOARD_HOST, TLS mode, …) the autosave is discarded and the
#     base config is loaded fresh — the worker re-syncs all routes (syncRoutes) at start / periodically.
#
# Env: DASHBOARD_HOST (required), PLATFORM_DOMAIN, ACME_EMAIL, TLS_MODE=acme|internal|off,
#      CONTROL_UPSTREAM=control:3000, CADDY_ADMIN_LISTEN=caddy-admin:2019
set -eu

: "${DASHBOARD_HOST:?DASHBOARD_HOST is required}"
TLS_MODE="${TLS_MODE:-acme}"
CONTROL_UPSTREAM="${CONTROL_UPSTREAM:-control:3000}"
ADMIN_LISTEN="${CADDY_ADMIN_LISTEN:-caddy-admin:2019}"
TLS_ASK="${TLS_ASK_URL:-http://${CONTROL_UPSTREAM}/api/internal/tls-ask}"
DASH_HOST_ONLY="${DASHBOARD_HOST%%:*}"

json_str() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }

admin_port="${ADMIN_LISTEN##*:}"
ADMIN_ORIGINS="[$(json_str "$ADMIN_LISTEN"), \"localhost:${admin_port}\", \"127.0.0.1:${admin_port}\"]"

case "$TLS_MODE" in
  internal) ISSUERS='[{ "module": "internal" }]' ;;
  acme)
    if [ -n "${ACME_EMAIL:-}" ]; then
      ISSUERS="[{ \"module\": \"acme\", \"email\": $(json_str "$ACME_EMAIL") }, { \"module\": \"zerossl\", \"email\": $(json_str "$ACME_EMAIL") }]"
    else
      ISSUERS='[{ "module": "acme" }]'
    fi
    ;;
  off) ISSUERS='[{ "module": "internal" }]' ;;
  *) echo "TLS_MODE must be acme, internal or off" >&2; exit 1 ;;
esac

TLS_CERTS=""
AUTO_HTTPS='{}'
POLICIES="[{ \"subjects\": [$(json_str "$DASH_HOST_ONLY")], \"issuers\": $ISSUERS }"
# everything else (deployment URLs, custom domains) → on-demand TLS, gated by the control plane's tls-ask endpoint
POLICIES="$POLICIES, { \"issuers\": $ISSUERS, \"on_demand\": true }]"

if [ "$TLS_MODE" = "off" ]; then
  LISTEN='[":80"]'
  AUTO_HTTPS='{ "disable": true }'
else
  LISTEN='[":443"]'
fi

mkdir -p /config/levant
out=/config/levant/base.json
tmp="$out.new"
# escape sed replacement metacharacters (& | \)
e() { printf '%s' "$1" | sed 's/[&|\\]/\\&/g'; }
sed \
  -e "s|__ADMIN_LISTEN__|$(e "$ADMIN_LISTEN")|" \
  -e "s|__ADMIN_ORIGINS__|$(e "$ADMIN_ORIGINS")|" \
  -e "s|__LISTEN__|$(e "$LISTEN")|" \
  -e "s|__AUTO_HTTPS__|$(e "$AUTO_HTTPS")|" \
  -e "s|__DASHBOARD_HOST__|$(e "$DASH_HOST_ONLY")|" \
  -e "s|__CONTROL_UPSTREAM__|$(e "$CONTROL_UPSTREAM")|" \
  -e "s|__TLS_ASK__|$(e "$TLS_ASK")|" \
  -e "s|__TLS_CERTS__|$(e "$TLS_CERTS")|" \
  -e "s|__TLS_POLICIES__|$(e "$POLICIES")|" \
  /etc/caddy/base.json.tmpl > "$tmp"

new_sum="$(sha256sum "$tmp" | cut -d' ' -f1)"
old_sum="$(cat /config/levant/base.sha256 2>/dev/null || true)"
mv "$tmp" "$out"
if [ "$new_sum" != "$old_sum" ] || [ "${LEVANT_CADDY_RESET:-0}" = "1" ]; then
  echo "[levant-caddy] base config changed → starting from a fresh base (routes are re-synced by the worker)"
  rm -f /config/caddy/autosave.json
  echo "$new_sum" > /config/levant/base.sha256
fi

caddy validate --config "$out" >/dev/null
exec caddy run --config "$out" --resume
