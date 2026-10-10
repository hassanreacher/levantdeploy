FROM node:22-alpine
WORKDIR /app
ARG APP_VERSION=v1
ENV APP_VERSION=$APP_VERSION
RUN --mount=type=secret,id=ca,target=/ca.pem NODE_EXTRA_CA_CERTS=/ca.pem npm install --no-audit --no-fund pg@8.13.1 >/dev/null 2>&1 || echo "pg not installed"
COPY server.js .
CMD ["node", "server.js"]
