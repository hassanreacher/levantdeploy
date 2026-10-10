#!/usr/bin/env bash
# LevantBase compat suite — dev-sandbox wrapper.
#   LB_API=http://localhost:3111 LB_TOKEN=ld_… [LB_REF=<ref>] [CADDY_CONTAINER=compat-caddy] ./run.sh
# Trusts Caddy's local CA (NODE_EXTRA_CA_CERTS), connects every *.base host to the Caddy container (LB_EDGE, like
# curl --resolve — /etc/hosts is not touched) and runs a throwaway SMTP sink container for the email checks.
set -euo pipefail
cd "$(dirname "$0")"
CADDY="${CADDY_CONTAINER:-compat-caddy}"
SINK="${LB_SMTP_CONTAINER:-compat-smtp}"
TMP="$(mktemp -d)"
cleanup() { docker rm -f "$SINK" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
[ -d node_modules ] || npm install --no-audit --no-fund
docker cp "$CADDY:/data/caddy/pki/authorities/local/root.crt" "$TMP/caddy-root.crt"
export NODE_EXTRA_CA_CERTS="$TMP/caddy-root.crt"
export LB_EDGE="${LB_EDGE:-$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$CADDY" | awk '{print $1}')}"
docker rm -f "$SINK" >/dev/null 2>&1 || true
docker run -d --name "$SINK" --label levant.area=compat -v "$PWD/smtp-sink.mjs:/sink.mjs:ro" node:22-alpine node /sink.mjs >/dev/null
export LB_SMTP_CONTAINER="$SINK"
TSX="${TSX:-../../../node_modules/.bin/tsx}"
"$TSX" run.ts
