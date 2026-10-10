# A hand-written Dockerfile: LevantDeploy uses it as-is (proxy build args are passed through when configured).
FROM node:22-alpine
WORKDIR /srv
COPY server.mjs .
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server.mjs"]
