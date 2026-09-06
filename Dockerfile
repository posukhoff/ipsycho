# The Mini App bundle. Vite writes `web/dist` with base `/app/`; Nest serves it under the same
# prefix, so nothing here rewrites paths.
FROM node:24-alpine AS web
WORKDIR /app
COPY package*.json ./
COPY web ./web
# `web/tsconfig.json` includes `../src/api/contracts` and the client re-exports it, so the bundle is
# built from the server's own zod schemas rather than a copy that could drift.
COPY tsconfig*.json ./
COPY src/api ./src/api
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
RUN npm run build:web

FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
# `web` is an npm workspace, so its manifest has to exist before `npm ci` will resolve the tree.
COPY web/package.json ./web/package.json
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
# Set by docker compose from APP_COMMIT; /status and /health report it so a deploy can be verified from Telegram.
ARG APP_COMMIT=unknown
ENV NODE_ENV=production
ENV APP_COMMIT=$APP_COMMIT
COPY package*.json ./
COPY web/package.json ./web/package.json
# Every `web` dependency is a devDependency, so `--omit=dev` leaves the workspace with nothing to
# install and the runtime image keeps only the server's production tree. That is also what makes
# `npm audit --omit=dev` in CI mean what it says. (`--workspaces=false` is the alternative if a
# runtime dependency ever has to live in `web`.)
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi
COPY --from=build /app/dist ./dist
COPY --from=web /app/web/dist ./web/dist
COPY migrations ./migrations
# The image runs as `node`, and the checkout on the server may have any umask: make everything the
# runtime reads readable, and directories traversable. `a+rX` adds execute only where it belongs.
RUN chmod -R a+rX ./migrations ./dist ./web/dist ./package.json
# The problem log's home. Docker gives a fresh named volume the ownership of the directory it
# covers, so creating it here as `node` is what makes the volume writable without a host chown.
RUN mkdir -p /var/log/ipsycho && chown node:node /var/log/ipsycho
# Runtime has no reason to run as root; migration/app only need network and read access.
USER node
CMD ["sh", "-c", "node dist/database/migrate.js && node dist/main.js"]
