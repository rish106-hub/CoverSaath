#!/bin/bash
# Starts clamd (with a signature updater), the API and the job worker. If the API, the worker or clamd stops, the container stops so Fly restarts all.
# The worker (src/server/worker.js) claims jobs from the Postgres queue with FOR UPDATE SKIP LOCKED, so two machines never run one job twice.
# WORKER_IN_CONTAINER=false (a Fly env or secret) is the kill switch: the API then runs alone, as before.
set -eu

# A Fly volume mounts as root; the API runs as the unprivileged node user.
mkdir -p "${DOCUMENT_STORAGE_PATH:-/data/documents}"
chown -R node:node /data

log() { printf '{"event":"%s"}\n' "$1" >&2; }

# True when clamd answers PING on loopback. Pure bash (/dev/tcp), so the image needs no netcat.
clamd_ping() {
  local reply=""
  exec 3<>"/dev/tcp/127.0.0.1/${CLAMD_PORT:-3310}" 2>/dev/null || return 1
  printf 'zPING\0' >&3
  IFS= read -r -d '' -t 3 reply <&3 || true
  exec 3>&-
  [ "$reply" = "PONG" ]
}

clamd_pid=""
freshclam_pid=""
if [ "${DOCUMENT_SCAN_MODE:-disabled}" = "clamd" ]; then
  clamd --config-file=/app/docker/clamd.conf &
  clamd_pid=$!
  # Keep signatures fresh. Never fatal: if freshclam cannot reach its mirror, clamd keeps the signatures baked in at build
  # (the runbook says to redeploy at least weekly). Not waited on below, so it cannot stop the container.
  (
    while true; do
      runuser -u clamav -- freshclam --config-file=/app/docker/freshclam.conf --daemon || true
      log freshclam_stopped
      sleep 300
    done
  ) &
  freshclam_pid=$!
  # clamd needs a while to load its database. The API starts immediately: uploads are stored encrypted and scanned when
  # clamd answers (deferred with backoff until then), and /api/v1/ready reports the scanner state.
  (
    for _ in $(seq 1 90); do
      if clamd_ping; then log clamd_ready; exit 0; fi
      sleep 2
    done
    log clamd_not_ready_after_180s
  ) &
fi
runuser -u node -- node /app/src/server/server.js &
node_pid=$!
worker_pid=""
if [ "${WORKER_IN_CONTAINER:-true}" != "false" ]; then
  runuser -u node -- node /app/src/server/worker.js &
  worker_pid=$!
fi

trap 'kill ${clamd_pid:-} ${freshclam_pid:-} ${worker_pid:-} "$node_pid" 2>/dev/null || true' TERM INT
status=0
# Only the API, the worker and clamd decide the container's life.
wait -n "$node_pid" ${worker_pid:+"$worker_pid"} ${clamd_pid:+"$clamd_pid"} || status=$?
kill ${clamd_pid:-} ${freshclam_pid:-} ${worker_pid:-} "$node_pid" 2>/dev/null || true
# Let the API and the worker finish in-flight work after SIGTERM; the watcher and updater subshells must not hold the exit.
wait "$node_pid" 2>/dev/null || true
[ -z "$worker_pid" ] || wait "$worker_pid" 2>/dev/null || true
exit "$status"
