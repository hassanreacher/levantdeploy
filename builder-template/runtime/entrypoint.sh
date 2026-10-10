#!/bin/sh
# LevantDeploy builder preview entrypoint: link the pre-installed dependencies into the bind-mounted repo, then run.
set -e
BASE="${LEVANT_BASE:-/opt/levant/base}"
cd /app
# dependency fingerprint = dependencies + devDependencies + pnpm settings of package.json (+ the lockfile)
depsig() { node -e 'const p=require(process.argv[1]);process.stdout.write(JSON.stringify([p.dependencies||{},p.devDependencies||{},p.optionalDependencies||{},p.pnpm||{}]))' "$1" 2>/dev/null || echo "?"; }
if [ -f /app/package.json ]; then
  changed=0
  [ "$(depsig /app/package.json)" = "$(depsig "$BASE/package.json")" ] || changed=1
  if [ -f /app/pnpm-lock.yaml ] && ! cmp -s /app/pnpm-lock.yaml "$BASE/pnpm-lock.yaml"; then changed=1; fi
  if [ "$changed" = 1 ]; then
    echo "▲ levant: dependencies changed — installing"
    cp /app/package.json "$BASE/package.json"
    if [ -f /app/pnpm-lock.yaml ]; then
      cp /app/pnpm-lock.yaml "$BASE/pnpm-lock.yaml"
      (cd "$BASE" && pnpm install --frozen-lockfile --prefer-offline --store-dir /opt/levant/store) ||
        (cd "$BASE" && pnpm install --no-frozen-lockfile --prefer-offline --store-dir /opt/levant/store) ||
        echo "▲ levant: dependency install failed (continuing with the existing modules)"
    else
      (cd "$BASE" && pnpm install --no-frozen-lockfile --prefer-offline --store-dir /opt/levant/store) || echo "▲ levant: dependency install failed (continuing with the existing modules)"
    fi
  fi
fi
# /app/node_modules → image modules (a real directory committed by mistake is left alone)
if [ -L /app/node_modules ] || [ ! -e /app/node_modules ]; then ln -sfn "$BASE/node_modules" /app/node_modules; fi
export PATH="/app/node_modules/.bin:$PATH"
exec "$@"
