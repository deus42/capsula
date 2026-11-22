# Capsula for production: accounts mode with the OpenAI engine, or Codex on the owner's own ChatGPT subscription
# when no API key is set, run as a non-root user on a read-only root filesystem; everything written lives in /data.
# Pin the base image by digest at deploy time.

FROM node:24-slim AS build
WORKDIR /srv/capsula/app
COPY app/package.json app/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY app/ ./
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-slim
# Codex CLI, the version the local site runs; its sign-in and generated images live in /data/codex. Unlike Node,
# Codex reads the system CA store, which the slim image does not ship.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
 && npm install -g @openai/codex@0.169.1 --no-audit --no-fund && npm cache clean --force
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4317 \
    CAPSULA_DATA_DIR=/data \
    CODEX_HOME=/data/codex
WORKDIR /srv/capsula/app
COPY --from=build /srv/capsula/app/package.json ./
COPY --from=build /srv/capsula/app/node_modules ./node_modules
COPY --from=build /srv/capsula/app/dist ./dist
COPY --from=build /srv/capsula/app/server ./server
COPY --from=build /srv/capsula/app/src ./src
# The one-time owner import and the owner's test accounts run inside the container (deploy/README.md).
COPY scripts/import-user.ts scripts/test-account.ts /srv/capsula/scripts/
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4317/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "server/index.ts"]
