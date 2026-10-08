# Knowvia API + built UI. Plain Dockerfile, env-only configuration: runs unchanged on Cloud Run
# (gcloud run deploy --source / Cloud Build) or any other container host. Contains no secrets.
# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:22-slim

# ---- builder: installs devDependencies (vite) and emits dist/ ----
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY src ./src
# Vite inlines VITE_* values at build time. Public analytics values (never secrets) are optionally supplied by
# scripts/deploy/gcp-staging.sh through scripts/deploy/vite-public.env. A COPY whose only source is a glob with no
# match fails, so package.json (always present, already copied) anchors it and the optional file rides along.
COPY package.json scripts/deploy/vite-public.en[v] ./
RUN if [ -f vite-public.env ]; then set -a; . ./vite-public.env; set +a; fi; npm run build

# ---- runtime: production dependencies only, non-root ----
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node --from=builder /app/dist ./dist
USER node
# Cloud Run injects PORT (8080) and routes to it. HOST/ALLOWED_HOSTS/DATABASE_URL etc. are runtime env.
EXPOSE 8080
CMD ["node", "src/server/server.js"]
