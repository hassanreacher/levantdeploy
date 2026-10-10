# LevantDeploy edge proxy (ops area): official Caddy 2 + a base config rendered from env at start.
# Routes, TLS policies and the admin listener are then managed at runtime by the control plane, which POSTs the
# full config to the admin API (/load) — see control/src/lib/proxy. On-demand TLS (per hostname, gated by
# /api/internal/tls-ask) needs no DNS-provider plugin.
ARG CADDY_IMAGE=caddy:2.10-alpine
FROM ${CADDY_IMAGE}
COPY base.json.tmpl /etc/caddy/base.json.tmpl
COPY fallback.html /srv/levant/index.html
COPY --chmod=755 entrypoint.sh /usr/local/bin/levant-caddy
ENTRYPOINT ["/usr/local/bin/levant-caddy"]
