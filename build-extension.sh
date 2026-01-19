#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${RETRACTCHECK_WORKER_URL:-}" ]]; then
  echo "Error: RETRACTCHECK_WORKER_URL is required" >&2
  echo "Usage: export RETRACTCHECK_WORKER_URL=https://your-worker.workers.dev" >&2
  exit 1
fi

echo "Building with RETRACTCHECK_WORKER_URL=${RETRACTCHECK_WORKER_URL}"

bun run lint
bun run test
bun run package:firefox

echo "Done: apps/extension/RetractCheck-firefox.xpi"
