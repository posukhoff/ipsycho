FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
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
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
# The image runs as `node`, and the checkout on the server may have any umask: make everything the
# runtime reads readable, and directories traversable. `a+rX` adds execute only where it belongs.
RUN chmod -R a+rX ./migrations ./dist ./package.json
# Runtime has no reason to run as root; migration/app only need network and read access.
USER node
CMD ["sh", "-c", "node dist/database/migrate.js && node dist/main.js"]
