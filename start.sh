#!/usr/bin/env bash
set -euo pipefail

# Usage: ./start.sh [--mode wasm|server] [--ngrok]

MODE_ENV=${MODE:-wasm}
for arg in "$@"; do
  case "$arg" in
    --mode) MODE_ENV="$2"; shift;;
    --mode=*) MODE_ENV="${arg#*=}" ;;
    --ngrok|--localtunnel) export LOCALTUNNEL=1 ;;
  esac
done

export MODE="$MODE_ENV"

echo "Building and starting containers (MODE=$MODE)" 
docker-compose up --build


