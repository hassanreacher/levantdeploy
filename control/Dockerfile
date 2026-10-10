# ─────────────────────────────────────────────────────────────────────────────
# LevantDeploy control image (ops area) — ONE image runs both processes:
#   docker run … levantdeploy/control web      → dashboard + REST API (Next.js standalone, port 3000)
#   docker run … levantdeploy/control worker   → BullMQ worker (builds/deploys via the mounted Docker socket)
#   docker run … levantdeploy/control migrate  → apply database migrations and exit
#
# Build:  docker build -t levantdeploy/control ./control
# Behind an HTTPS proxy with a private CA (optional, corporate networks / sandboxes):
#   docker build --network host --build-arg HTTPS_PROXY=… --build-arg https_proxy=… \
#                --secret id=ca,src=/path/ca-bundle.pem ./control
# The CA secret is only used while installing packages; it never ends up in the image.
#
# Base: Ubuntu 24.04 LTS (glibc: Prisma engines, native modules) + Node 22 copied from the official image +
# Docker CLI/buildx/compose copied from the official docker:cli image.
# ─────────────────────────────────────────────────────────────────────────────
ARG NODE_IMAGE=node:22-bookworm-slim
ARG DOCKER_CLI_IMAGE=docker:28-cli
ARG UBUNTU_IMAGE=ubuntu:24.04

FROM ${NODE_IMAGE} AS node
FROM ${DOCKER_CLI_IMAGE} AS dockercli
# Named build contexts (compose passes them; plain `docker build ./control` falls back to these empty stages):
#   --build-context examples=./examples   → project templates (Templates tab, TEMPLATES_DIR)
#   --build-context cli=./cli             → the levant CLI, packed and served at /api/cli/levant.tgz
#   --build-context basestack=./base-stack → LevantBase stack template (BASE_TEMPLATE_DIR) + vendored upstream notices
FROM scratch AS examples
FROM scratch AS cli
#   --build-context buildertemplate=./builder-template → AI Builder template, component library, preview runtime
FROM scratch AS basestack
FROM scratch AS buildertemplate

# ── base: Ubuntu + Node + runtime libs ───────────────────────────────────────
FROM ${UBUNTU_IMAGE} AS base
ENV DEBIAN_FRONTEND=noninteractive NEXT_TELEMETRY_DISABLED=1
# apt helper: with a CA secret (proxied build) switch the mirrors to HTTPS and trust that CA
RUN printf '%s\n' '#!/bin/sh' 'set -e' \
      'opts=""' \
      'if [ -s /run/secrets/ca ]; then' \
      '  sed -i "s|http://|https://|g" /etc/apt/sources.list.d/*.sources 2>/dev/null || true' \
      '  opts="-o Acquire::https::CAInfo=/run/secrets/ca -o APT::Sandbox::User=root"' \
      'fi' \
      'apt-get $opts update' \
      'apt-get $opts install -y --no-install-recommends "$@"' \
      'rm -rf /var/lib/apt/lists/*' > /usr/local/bin/apt-install && chmod +x /usr/local/bin/apt-install
RUN --mount=type=secret,id=ca,required=false apt-install ca-certificates openssl tini
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx && \
    node --version && npm --version
WORKDIR /app

# ── prisma-cli: standalone Prisma CLI for `migrate deploy` at container start ─
FROM base AS prisma-cli
COPY package.json ./
RUN --mount=type=secret,id=ca,required=false --mount=type=tmpfs,target=/root/.npm \
    if [ -s /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    PRISMA_VERSION="$(node -p "require('./package.json').devDependencies.prisma")" && \
    mkdir -p /opt/prisma && cd /opt/prisma && echo '{"private":true}' > package.json && \
    npm install --no-audit --no-fund "prisma@${PRISMA_VERSION}" && \
    node node_modules/prisma/build/index.js --version

# ── cli-pack: build + `npm pack` the CLI (skipped when no cli context is given) ─
FROM base AS cli-pack
COPY --from=cli / /cli/
RUN --mount=type=secret,id=ca,required=false --mount=type=tmpfs,target=/root/.npm \
    set -e; mkdir -p /out; \
    if [ -f /cli/package.json ]; then \
      if [ -s /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
      cd /cli && npm ci --no-audit --no-fund && npm run build && npm pack --pack-destination /out && \
      mv /out/*.tgz /out/levant.tgz && rm -rf /cli/node_modules; \
    fi

# ── builder: npm ci + prisma generate + next build (standalone) + worker bundle + prune ─
# Works in a scratch dir and keeps only the artifacts in /out, so the layer stays small.
# BUILD_TMPFS=1 does the scratch work in RAM (needs ~3 GB free memory) — for hosts short on disk.
FROM base AS builder
ARG BUILD_TMPFS=0
COPY . /src
RUN --mount=type=secret,id=ca,required=false --mount=type=tmpfs,target=/build \
    set -e; \
    if [ -s /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    if [ "$BUILD_TMPFS" = 1 ]; then W=/build; export npm_config_cache=/build/.npm-cache; else W=/work; fi; \
    mkdir -p "$W/app" && cp -a /src/. "$W/app/" && cd "$W/app"; \
    npm ci --no-audit --no-fund; \
    npx prisma generate; \
    NODE_ENV=production npx next build; \
    node scripts/build-worker.mjs; \
    npm prune --omit=dev --no-audit --no-fund; \
    test -d node_modules/.prisma/client; \
    rm -rf node_modules/@next/swc-*; \
    mkdir -p /out/.next; \
    cp -a node_modules dist prisma public package.json /out/; \
    cp -a .next/standalone /out/standalone; \
    cp -a .next/static /out/.next/static; \
    mkdir -p /out/prompts; if [ -d src/lib/builder/agents/prompts ]; then cp -a src/lib/builder/agents/prompts/. /out/prompts/; fi; \
    cd /; rm -rf /work /root/.npm /tmp/*

# ── runner: final image (non-root) ───────────────────────────────────────────
FROM base AS runner
ARG LEVANT_VERSION=""
# worker tooling: git + openssh-client (clone over HTTPS / SSH deploy keys), pg_dump 16 (control-DB backups)
RUN --mount=type=secret,id=ca,required=false apt-install git openssh-client postgresql-client-16 tar gzip
# Docker CLI + buildx + compose plugins (builds/deploys go through the host daemon via the mounted socket)
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins
# uid 1000 "levant" (Ubuntu ships uid 1000 as "ubuntu" — rename it)
RUN usermod -l levant -d /home/levant -m -G "" ubuntu && groupmod -n levant ubuntu && \
    mkdir -p /var/lib/levantdeploy/storage /var/lib/levantdeploy/work /home/levant/.docker /home/levant/.ssh && \
    chmod 700 /home/levant/.ssh
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    LEVANT_VERSION=${LEVANT_VERSION} \
    STORAGE_DIR=/var/lib/levantdeploy/storage \
    WORK_DIR=/var/lib/levantdeploy/work \
    HOME=/home/levant \
    DOCKER_CONFIG=/home/levant/.docker \
    TEMPLATES_DIR=/app/examples \
    BASE_TEMPLATE_DIR=/app/base-stack/template \
    BUILDER_TEMPLATE_DIR=/app/builder-template \
    CLI_TARBALL=/app/cli/levant.tgz

COPY --from=prisma-cli /opt/prisma /opt/prisma
# full production node_modules (the worker needs bullmq/dockerode/…; Next standalone only traces what the server uses)
COPY --from=builder /out/node_modules ./node_modules
COPY --from=builder /out/standalone/ ./
COPY --from=builder /out/.next/static ./.next/static
COPY --from=builder /out/public ./public
COPY --from=builder /out/dist ./dist
COPY --from=builder /out/prisma ./prisma
COPY --from=builder /out/package.json ./package.json
COPY --from=examples / ./examples/
COPY --from=basestack / ./base-stack/
COPY --from=buildertemplate / ./builder-template/
# Builder agent prompts are read from disk at <cwd>/src/lib/builder/agents/prompts (worker + dashboard, cwd=/app)
COPY --from=builder /out/prompts ./src/lib/builder/agents/prompts
COPY --from=cli-pack /out/ ./cli/
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chown -R levant:levant /var/lib/levantdeploy /home/levant /app/.next

USER levant
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "docker-entrypoint.sh"]
CMD ["web"]
