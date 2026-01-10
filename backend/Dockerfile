# Multi-stage build for backend

FROM node:25.2.1-bullseye AS deps
WORKDIR /usr/src/app
COPY backend/package*.json ./
RUN npm ci --no-audit --no-fund

FROM node:25.2.1-bullseye AS runner
ENV NODE_ENV=production
WORKDIR /usr/src/app
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY backend/ .
COPY shared/ /usr/src/shared/

# Optional curl for healthcheck or debugging
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*

# Drop privileges: run as non-root ---------------------------
RUN useradd -m -u 10001 appuser && chown -R appuser:appuser /usr/src/app /usr/src/shared
USER appuser

EXPOSE 2208
CMD ["./node_modules/.bin/tsx", "app.ts"]


