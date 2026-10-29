#!/bin/bash
# Starts clamd and the API. If either stops, the container stops so Fly restarts both.
set -eu

# A Fly volume mounts as root; the API runs as the unprivileged node user.
mkdir -p "${DOCUMENT_STORAGE_PATH:-/data/documents}"
chown -R node:node /data

clamd_pid=""
if [ "${DOCUMENT_SCAN_MODE:-disabled}" = "clamd" ]; then
  clamd --config-file=/app/docker/clamd.conf &
  clamd_pid=$!
fi
runuser -u node -- node /app/src/server/server.js &
node_pid=$!

trap 'kill $clamd_pid "$node_pid" 2>/dev/null || true' TERM INT
status=0
wait -n || status=$?
kill $clamd_pid "$node_pid" 2>/dev/null || true
wait || true
exit "$status"
