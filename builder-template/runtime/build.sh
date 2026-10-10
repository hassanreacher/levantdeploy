#!/bin/sh
# Build levant/builder-runtime:next15. Optional: HTTPS_PROXY/HTTP_PROXY/NO_PROXY in the env and LEVANT_CA=<pem file>
# (corporate / sandbox proxies), NODE_IMAGE=<mirror>/library/node:22-slim (Docker Hub rate limits).
set -e
DIR=$(cd "$(dirname "$0")/.." && pwd)
TAG="${TAG:-levant/builder-runtime:next15}"
set -- --network host -f "$DIR/runtime/Dockerfile" -t "$TAG"
[ -n "$NODE_IMAGE" ] && set -- "$@" --build-arg "NODE_IMAGE=$NODE_IMAGE"
for v in HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy; do eval "val=\${$v:-}"; [ -n "$val" ] && set -- "$@" --build-arg "$v=$val"; done
[ -n "$LEVANT_CA" ] && set -- "$@" --secret "id=levant_ca,src=$LEVANT_CA"
DOCKER_BUILDKIT=1 docker build "$@" "$DIR"
