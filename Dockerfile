# Multi-stage Dockerfile for Syncio
FROM oven/bun:1-alpine AS base

RUN apk add --no-cache libc6-compat openssl3 curl npm
WORKDIR /app

# Deps stage - install dependencies
FROM base AS deps
WORKDIR /app
COPY package*.json ./
COPY client/package*.json ./client/
COPY prisma ./prisma/
RUN npm install --legacy-peer-deps
RUN cd client && npm ci --legacy-peer-deps

# Build stage
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/client/node_modules ./client/node_modules
COPY . .

ARG INSTANCE

ENV PRISMA_CLI_BINARY_TARGETS="linux-musl-openssl-3.0.x,linux-musl-arm64-openssl-3.0.x"
RUN rm -rf node_modules/.prisma node_modules/@prisma/client/runtime/libquery_engine-*.so.node 2>/dev/null || true
RUN if [ "$INSTANCE" = "public" ]; then \
    cp prisma/schema.postgres.prisma prisma/schema.prisma; \
    else \
    cp prisma/schema.sqlite.prisma prisma/schema.prisma; \
    fi
RUN npx prisma generate --schema=prisma/schema.prisma

ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL:-}
ENV INSTANCE=$INSTANCE

RUN cd client && \
    NEXT_PUBLIC_AUTH_ENABLED=$( [ "$INSTANCE" = "public" ] && echo true || echo false ) \
    NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL:-} \
    npm run build

# Frontend production stage
FROM base AS frontend
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 appuser

RUN apk add --no-cache curl openssl3

ARG INSTANCE=private
ENV INSTANCE=$INSTANCE
ENV NEXT_PUBLIC_DEBUG=false
ENV NODE_OPTIONS="--dns-result-order=ipv4first"

COPY --from=builder --chown=appuser:nodejs /app/client/.next ./client/.next
COPY --from=builder --chown=appuser:nodejs /app/client/package*.json ./client/
COPY --from=builder --chown=appuser:nodejs /app/client/node_modules ./client/node_modules
COPY --from=builder --chown=appuser:nodejs /app/client/public ./client/public
COPY --from=builder --chown=appuser:nodejs /app/client/next.config.ts ./client/

RUN mkdir -p /app/client/.next/standalone/public/_next/static && \
    cp -r /app/client/public/* /app/client/.next/standalone/public/ 2>/dev/null || true && \
    cp -r /app/client/.next/static/* /app/client/.next/standalone/public/_next/static/ 2>/dev/null || true

COPY --from=builder --chown=appuser:nodejs /app/scripts/start-frontend.sh /app/start.sh
RUN chmod +x /app/start.sh

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:3000/ || exit 1

CMD ["/app/start.sh"]

# Backend production stage
FROM base AS backend
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 appuser

RUN mkdir -p /app/data /app/logs && chown -R appuser:nodejs /app/data /app/logs

RUN apk add --no-cache curl openssl3

ENV PRISMA_CLI_BINARY_TARGETS="linux-musl-openssl-3.0.x,linux-musl-arm64-openssl-3.0.x"
ENV NODE_OPTIONS="--dns-result-order=ipv4first"

ARG INSTANCE=private
ENV INSTANCE=$INSTANCE

COPY --from=builder --chown=appuser:nodejs /app/package*.json ./
COPY --from=builder --chown=appuser:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=appuser:nodejs /app/server ./server
COPY --from=builder --chown=appuser:nodejs /app/prisma ./prisma

RUN if [ "$INSTANCE" = "public" ]; then \
    cp prisma/schema.postgres.prisma prisma/schema.prisma; \
    else \
    cp prisma/schema.sqlite.prisma prisma/schema.prisma; \
    fi

COPY --from=builder --chown=appuser:nodejs /app/scripts/start-backend.sh /app/start.sh
RUN chmod +x /app/start.sh

USER appuser

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:4000/health || exit 1

CMD ["/app/start.sh"]
