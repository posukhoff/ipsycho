FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
# Runtime has no reason to run as root; migration/app only need network and read access.
USER node
CMD ["sh", "-c", "node dist/database/migrate.js && node dist/main.js"]
