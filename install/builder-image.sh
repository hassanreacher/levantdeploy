#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# AI Builder preview runtime image (levant/builder-runtime:next15), built from builder-template/runtime/Dockerfile.
#
#   install/builder-image.sh ensure        build when missing or when the template changed (fingerprint), else no-op
#   install/builder-image.sh build         build now
#   install/builder-image.sh fingerprint   sha256 of the inputs (runtime/ + next15 package.json, lockfile, .npmrc)
#
# Proxy/CA for the build (servers behind a proxy), from the environment or <install dir>/.env:
#   LEVANT_BUILD_PROXY=http://proxy:3128   LEVANT_BUILD_CA_FILE=/path/ca.pem   LEVANT_BUILD_NODE_IMAGE=mirror.gcr.io/library/node:22-slim
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail
INSTALL_DIR="${LEVANT_INSTALL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
TPL="$INSTALL_DIR/builder-template"
STAMP="$INSTALL_DIR/.builder-image"
[ -f "$TPL/runtime/build.sh" ] || { echo "builder-image: $TPL/runtime/build.sh not found" >&2; exit 1; }
env_get() { [ -f "$INSTALL_DIR/.env" ] || return 0; { grep -E "^$1=" "$INSTALL_DIR/.env" || true; } | tail -n1 | cut -d= -f2-; }
TAG="${BUILDER_RUNTIME_IMAGE:-$(env_get BUILDER_RUNTIME_IMAGE)}"; TAG="${TAG:-levant/builder-runtime:next15}"
PROXY="${LEVANT_BUILD_PROXY:-$(env_get LEVANT_BUILD_PROXY)}"
CA="${LEVANT_BUILD_CA_FILE:-$(env_get LEVANT_BUILD_CA_FILE)}"
NODE_IMG="${LEVANT_BUILD_NODE_IMAGE:-$(env_get LEVANT_BUILD_NODE_IMAGE)}"

fingerprint() {
  (cd "$TPL" && find runtime next15/package.json next15/pnpm-lock.yaml next15/.npmrc -type f 2>/dev/null | LC_ALL=C sort | xargs sha256sum) | sha256sum | cut -d' ' -f1
}
build() {
  echo "  building $TAG (first build ~2-4 min, ~1.2 GB)"
  local -a envs=("TAG=$TAG")
  [ -n "$NODE_IMG" ] && envs+=("NODE_IMAGE=$NODE_IMG")
  if [ -n "$PROXY" ]; then envs+=("HTTPS_PROXY=$PROXY" "HTTP_PROXY=$PROXY" "https_proxy=$PROXY" "http_proxy=$PROXY" "NO_PROXY=localhost,127.0.0.1"); fi
  if [ -n "$CA" ]; then [ -s "$CA" ] || { echo "builder-image: CA file $CA not found" >&2; exit 1; }; envs+=("LEVANT_CA=$CA"); fi
  env "${envs[@]}" sh "$TPL/runtime/build.sh"
  fingerprint > "$STAMP"
}

case "${1:-ensure}" in
  fingerprint) fingerprint ;;
  build) build ;;
  ensure)
    if docker image inspect "$TAG" >/dev/null 2>&1 && [ "$(cat "$STAMP" 2>/dev/null || true)" = "$(fingerprint)" ]; then
      echo "  ✓ $TAG is up to date"
    else
      build
    fi
    ;;
  *) echo "usage: builder-image.sh ensure|build|fingerprint" >&2; exit 1 ;;
esac
