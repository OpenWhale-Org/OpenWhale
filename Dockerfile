# OpenWhale — one image, two processes.
#
# The gateway and the dashboard are built from the same workspace and differ
# only in the command, so they share an image rather than repeating a build
# that takes minutes. docker-compose.yml runs both.
#
# Node 22 to match what this is tested on. Debian rather than alpine: the engine
# links better-sqlite3 and shells out to npm to install plugins, and musl has
# been the wrong surprise in both of those places often enough not to invite it
# into a process that holds exchange keys.
#
# The full image rather than -slim, and no apt anywhere. It already carries the
# two things this needs — a toolchain for when better-sqlite3 finds no matching
# prebuild, and git for installing plugins from a repository. Adding them with
# apt costs a package-index fetch on every build, from a network that is not
# always yours to rely on: behind a corporate proxy or a VPN that intercepts
# port 80, `apt-get update` fails and takes the whole build with it, for a
# dependency nobody would guess was there. A bigger base that always builds
# beats a smaller one that builds where you happen to be sitting.

# ── build ─────────────────────────────────────────────────────────────────────
FROM node:22 AS build
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9 --activate

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm -r --filter '!@openwhaleorg/dashboard' build
RUN cd packages/apps/dashboard && npx next build

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:22 AS runtime
WORKDIR /app

# git comes with the base image, and it is not optional: installing a plugin
# from a repository shells out to it through npm, and its absence reads as a
# network failure rather than a missing binary.
#
# pnpm is not needed here: plugin installs shell out to `npm`, which ships with
# node, and `next start` is invoked through the package's own .bin.

# The whole tree, node_modules included. pnpm's store is a web of symlinks into
# node_modules/.pnpm; copying a subset breaks it, and pruning to production
# would take the dashboard's runtime dependencies with it. The image is larger
# and it actually starts.
#
# --chown in the COPY rather than a RUN chown afterwards: a second layer that
# rewrites ownership of every file duplicates the entire tree in the image.
# It also has to be node's, not root's — `next start` writes to .next/cache,
# and a read-only cache directory fails at request time rather than at boot.
COPY --from=build --chown=node:node /app /app

# HOME is the data directory, and that is load-bearing rather than tidy.
#
# OPENWHALE_DB_PATH moves the database and the plugin tree, but monitor history
# resolves through the home directory independently — so overriding one splits
# the state in two, and a volume mounted at the database would silently leave
# weeks of monitor JSONL inside the container, to be lost on the next `docker
# rm`. Moving HOME moves all of it together: one volume holds everything the
# engine owns.
ENV HOME=/data
ENV NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 3001 3002

# docker-compose.yml overrides this for the dashboard.
CMD ["node", "packages/apps/gateway/dist/index.js"]
