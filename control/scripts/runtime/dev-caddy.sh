#!/usr/bin/env bash
# Dev/test edge proxy for the runtime area: Caddy 2 in Docker on network levant_net,
# HTTP :80 / HTTPS :443 on the host, admin API only on 127.0.0.1:2019, access log bind-mounted for the metrics tailer.
# Usage: scripts/runtime/dev-caddy.sh [up|down]   (env: STORAGE_DIR, CADDY_IMAGE)
set -euo pipefail
cd "$(dirname "$0")/../.."
ACTION="${1:-up}"
NAME=levant-caddy
STORAGE="$(realpath -m "${STORAGE_DIR:-./storage}")"
IMAGE="${CADDY_IMAGE:-caddy:2-alpine}"
if [ "$ACTION" = "down" ]; then docker rm -f "$NAME" >/dev/null 2>&1 || true; echo "stopped $NAME"; exit 0; fi
docker network inspect levant_net >/dev/null 2>&1 || docker network create levant_net --label levant.managed=true >/dev/null
mkdir -p "$STORAGE/caddy"
# bootstrap config: admin reachable through the published port; syncRoutes() replaces everything else
cat > "$STORAGE/caddy/bootstrap.json" <<JSON
{"admin":{"listen":"0.0.0.0:2019","origins":["localhost:2019","127.0.0.1:2019","caddy:2019","levant-caddy:2019"]},"apps":{}}
JSON
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped \
  --network levant_net \
  --add-host host.docker.internal:host-gateway \
  -p 80:80 -p 443:443 -p 127.0.0.1:2019:2019 \
  -v "$STORAGE/caddy:/var/log/caddy" \
  -v levant_caddy_data:/data \
  --label levant.managed=true \
  "$IMAGE" caddy run --config /var/log/caddy/bootstrap.json >/dev/null
for i in $(seq 1 30); do curl -sf http://127.0.0.1:2019/config/ >/dev/null && break; sleep 0.5; done
echo "$NAME up (admin http://127.0.0.1:2019)"
