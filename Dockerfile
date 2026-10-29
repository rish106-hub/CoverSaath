# CoverSaath API on Fly.io (ADR 0011 D7): the Node server and a clamd sidecar in one container,
# because uploads are scanned before storage and the scanner must be on loopback.
FROM node:26-bookworm-slim

ENV NODE_ENV=production
RUN apt-get update \
 && apt-get install -y --no-install-recommends clamav clamav-daemon ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 # Bake the virus signatures in. The build fails if they cannot be fetched, so an image never ships
 # a scanner with an empty database.
 && (systemctl disable clamav-freshclam >/dev/null 2>&1 || true) \
 && freshclam --quiet

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY docker ./docker

RUN chmod +x docker/entrypoint.sh \
 && mkdir -p /data /run/clamav \
 && chown clamav:clamav /run/clamav

ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
ENTRYPOINT ["/app/docker/entrypoint.sh"]
