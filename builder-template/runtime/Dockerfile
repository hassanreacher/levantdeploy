# syntax=docker/dockerfile:1.7
# levant/builder-runtime:next15 — LevantDeploy Builder live-preview runtime.
# Build context: builder-template/ (see builder-template/runtime/build.sh)
#   docker build -f runtime/Dockerfile -t levant/builder-runtime:next15 builder-template
# The template's dependencies are pre-installed in /opt/levant/base/node_modules; a preview container bind-mounts the
# project's repo at /app and the entrypoint links /app/node_modules → /opt/levant/base/node_modules (re-installing
# into the base dir first when the project's package.json / lockfile differ from the template's).
ARG NODE_IMAGE=node:22-slim
FROM ${NODE_IMAGE}

ENV NEXT_TELEMETRY_DISABLED=1 \
    CI=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    npm_config_update_notifier=false \
    PNPM_HOME=/opt/levant/pnpm \
    PATH=/opt/levant/bin:/opt/levant/pnpm:$PATH \
    LEVANT_BASE=/opt/levant/base \
    npm_config_store_dir=/opt/levant/store

# pnpm (pinned) — the build proxy CA (optional BuildKit secret) is trusted for this step only
RUN --mount=type=secret,id=levant_ca,required=false \
    set -e; if [ -s /run/secrets/levant_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/levant_ca npm_config_cafile=/run/secrets/levant_ca; fi; \
    npm install -g pnpm@9.15.9 --no-fund --no-audit && npm cache clean --force && rm -rf /root/.npm /tmp/* \
 && mkdir -p /opt/levant/base /opt/levant/store /opt/levant/bin /app && chown -R node:node /opt/levant/base /opt/levant/store /app

COPY --chown=node:node next15/package.json next15/pnpm-lock.yaml next15/.npmrc /opt/levant/base/

USER node
WORKDIR /opt/levant/base
# one layer: install with the pnpm store kept at /opt/levant/store (hard-linked into node_modules, so it costs almost
# nothing) — `lv-add` / dependency changes then only download the NEW packages
RUN --mount=type=secret,id=levant_ca,required=false,uid=1000 \
    set -e; if [ -s /run/secrets/levant_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/levant_ca npm_config_cafile=/run/secrets/levant_ca; fi; \
    pnpm install --frozen-lockfile --store-dir /opt/levant/store --config.package-import-method=hardlink \
 && rm -rf /home/node/.cache /home/node/.local/share/pnpm

# scripts last: changing them doesn't invalidate the dependency layer
COPY --chmod=755 runtime/entrypoint.sh /opt/levant/bin/levant-entrypoint
COPY --chmod=755 runtime/lv-add.sh /opt/levant/bin/lv-add
WORKDIR /app
EXPOSE 3000
ENTRYPOINT ["/opt/levant/bin/levant-entrypoint"]
CMD ["next", "dev", "-H", "0.0.0.0", "-p", "3000"]
