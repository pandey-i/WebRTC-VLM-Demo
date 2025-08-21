#!/usr/bin/env bash
set -euo pipefail

DURATION=30
MODE=server

while [[ $# -gt 0 ]]; do
  case "$1" in
    --duration) DURATION="$2"; shift 2;;
    --mode) MODE="$2"; shift 2;;
    *) shift;;
  esac
done

echo "Running bench for ${DURATION}s in mode=${MODE}"
curl -sS "http://localhost:3000/bench/start?duration=${DURATION}&mode=${MODE}" | jq . || true
echo "metrics.json should be created at project root."


