# syntax=docker/dockerfile:1.7
# VAP v0.1 release image. Built only from an allowlisted source archive (see .dockerignore and
# release-allowlist.txt) in Cloud Build; never from a developer home directory or workspace.
# Base images are pinned by digest; versions are recorded in toolchain.json.

ARG NODE_SLIM=node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ARG NODE_FULL=node:24.21.0-bookworm@sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0

FROM ${NODE_SLIM} AS build
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
COPY package.json package-lock.json tsconfig.base.json tsconfig.build.json ./
COPY packages ./packages
COPY apps ./apps
COPY fixtures ./fixtures
# Frozen lockfile, no install scripts (Playwright browsers are installed explicitly in the browser target).
RUN npm ci --ignore-scripts
RUN npm run build
# Playwright is a development dependency and an optional peer of
# @verified-action-protocol/adapters. npm marks it devOptional, which `prune --omit=dev` keeps, so
# it is removed explicitly: the supported runtime image carries no browser automation code. The experimental worker-browser target adds back these
# two lockfile-verified packages.
RUN mkdir -p /opt/browser-modules && cp -a node_modules/playwright node_modules/playwright-core /opt/browser-modules/
RUN npm prune --omit=dev --ignore-scripts \
 && rm -rf node_modules/playwright node_modules/playwright-core node_modules/.bin/playwright node_modules/.bin/playwright-core \
 && find packages apps fixtures -name "*.tsbuildinfo" -delete \
 && find packages apps fixtures -type d -name src -prune -exec rm -rf {} +

# Runtime image for the API, worker jobs, sweeper, migration job and fixture.
FROM ${NODE_SLIM} AS runtime
ARG VAP_BUILD_VERSION=0.1.0-rc.1
ARG VAP_BUILD_COMMIT=unknown
# Debian security updates are applied on top of the pinned base. tini reaps orphaned children so
# process-group checks see real survivors, not zombies. The npm CLI (and its bundled packages) is
# removed: the runtime never installs anything. Setuid and setgid bits are cleared (mount, umount,
# su, passwd and others): the runtime runs as `node` and never needs them, and without them those
# binaries cannot raise privileges inside the container (docs/security/runtime-decision-record.md).
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
 && find / -xdev -type f -perm /6000 -exec chmod a-s {} + \
 && test -z "$(find / -xdev -type f -perm /6000 -print -quit)"
WORKDIR /app
ENV NODE_ENV=production \
    VAP_ENV=production \
    VAP_BUILD_VERSION=${VAP_BUILD_VERSION} \
    VAP_BUILD_COMMIT=${VAP_BUILD_COMMIT} \
    VAP_ADAPTERS_CONFIG=/app/examples/config/adapters.fixture.json \
    VAP_WORKSPACE_ROOT=/tmp/vap-workspaces
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/apps ./apps
COPY --from=build --chown=node:node /app/fixtures ./fixtures
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --chown=node:node examples/config ./examples/config
COPY --chown=node:node LICENSE NOTICE ./
LABEL vap.support="supported"
USER node
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "node"]
CMD ["apps/api/dist/main.js"]

# Worker image with pinned Playwright Chromium for the bounded browser adapter. Built on the same
# slim base as the runtime image; Playwright installs only Chromium's own system dependencies
# (the full node image shipped hundreds of unused packages with open HIGH/CRITICAL findings).
FROM ${NODE_SLIM} AS worker-browser
ARG VAP_BUILD_VERSION=0.1.0-rc.1
ARG VAP_BUILD_COMMIT=unknown
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    VAP_ENV=production \
    VAP_BUILD_VERSION=${VAP_BUILD_VERSION} \
    VAP_BUILD_COMMIT=${VAP_BUILD_COMMIT} \
    VAP_ENABLE_BROWSER=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    VAP_ADAPTERS_CONFIG=/app/examples/config/adapters.fixture.json \
    VAP_WORKSPACE_ROOT=/tmp/vap-workspaces
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /opt/browser-modules/ ./node_modules/
# Browser binaries are pinned by the Playwright version in the lockfile.
RUN node node_modules/playwright/cli.js install --with-deps chromium && chmod -R a+rX /ms-playwright \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/apps ./apps
COPY --from=build --chown=node:node /app/fixtures ./fixtures
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --chown=node:node examples/config ./examples/config
COPY --chown=node:node LICENSE NOTICE ./
# Experimental: outside the supported v0.1 scope (docs/security/browser-image-assessment.md).
LABEL vap.support="experimental"
USER node
ENTRYPOINT ["/usr/bin/tini", "--", "node"]
CMD ["apps/worker/dist/main.js", "serve"]
