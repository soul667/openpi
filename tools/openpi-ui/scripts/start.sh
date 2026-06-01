#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d node_modules ]; then
  echo "[openpi-ui] Installing deps..."
  npm install --no-audit --no-fund --registry=https://registry.npmjs.org/
fi

exec npm run dev
