#
# OpenWhale — one image, two processes.
#
# The gateway (engine + API) and the dashboard (UI) are built from the same
# workspace and differ only in the command, so they share an image instead of
# repeating a build that takes minutes. docker-compose.yml runs both.
#
# Node 22 on Debian, the FULL image, and no apt anywhere. The full image
# already carries what this needs — git for installing plugins from a
# repository, and a toolchain for the day better-sqlite3 finds no prebuild —
# and adding them with apt costs a package-index fetch from a network that is
# not always yours: behind a proxy that intercepts port 80, `apt-get update`
# fails and takes the whole build with it. A bigger base that always builds
# beats a smaller one that builds only where you happen to be sitting.

FROM node:22 AS build
WORKDIR /app
ENV CI=true NEXT_TELEMETRY_DISABLED=1
RUN npm install -g pnpm@10
# Manifests first, so a source edit does not re-download every dependency
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY packages ./packages
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
# The dashboard's /api/* rewrite is evaluated at BUILD time (Next writes it
# into the routes manifest; `next start` does not re-read next.config), so the
# gateway address is baked in here. The default is the compose service name;
# override with --build-arg for any other topology.
ARG OPENWHALE_GATEWAY_URL=http://gateway:3001
ENV OPENWHALE_GATEWAY_URL=${OPENWHALE_GATEWAY_URL}
RUN pnpm -r --filter '!@openwhaleorg/dashboard' build \
 && pnpm --filter @openwhaleorg/dashboard build

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:22 AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1

# The whole tree, node_modules included: pnpm's store is a web of symlinks
# into node_modules/.pnpm, so a subset does not resolve, and pruning to
# production would strip what `next start` needs. Larger, and it starts.
#
# --chown in the COPY, not a RUN afterwards (that would duplicate the tree in
# a second layer). node's, not root's: `next start` writes .next/cache.
COPY --from=build --chown=node:node /app /app

# HOME is the data directory, and that is load-bearing. OPENWHALE_DB_PATH
# moves the database and the plugin tree, but monitor history resolves
# through the home directory on its own — override only the former and a
# volume at the database leaves weeks of monitor JSONL inside the container.
# Moving HOME moves all of it: one volume holds everything the engine owns.
ENV HOME=/data
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 3001 3002
# docker-compose.yml overrides this for the dashboard
CMD ["node", "packages/apps/gateway/dist/index.js"]
