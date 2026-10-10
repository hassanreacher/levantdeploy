#!/bin/sh
# lv-add <pkg>[@version] [...] [--dev] — add dependencies to the project (/app) using the image's base install, then
# copy package.json + pnpm-lock.yaml back to the repo. Proxy/CA come from the container env (HTTPS_PROXY, NODE_EXTRA_CA_CERTS).
set -e
BASE="${LEVANT_BASE:-/opt/levant/base}"
cp /app/package.json "$BASE/package.json"
if [ -f /app/pnpm-lock.yaml ]; then cp /app/pnpm-lock.yaml "$BASE/pnpm-lock.yaml"; fi
cd "$BASE"
DEV=""
for a in "$@"; do [ "$a" = "--dev" ] && DEV="-D"; done
PKGS=$(for a in "$@"; do [ "$a" != "--dev" ] && printf '%s ' "$a"; done)
# shellcheck disable=SC2086
pnpm add $DEV $PKGS --store-dir /opt/levant/store
cp "$BASE/package.json" /app/package.json
cp "$BASE/pnpm-lock.yaml" /app/pnpm-lock.yaml
echo "▲ levant: added $PKGS"
