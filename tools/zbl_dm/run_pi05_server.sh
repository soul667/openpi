#!/usr/bin/env bash
set -eo pipefail

PYTHON_BIN="${PYTHON_BIN:-python}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GPU_IDS="${GPU_IDS:-0}"
if [[ "$GPU_IDS" != "all" ]]; then
  export CUDA_VISIBLE_DEVICES="$GPU_IDS"
fi

# Keep JAX on CUDA/CPU and avoid preallocating almost all visible GPU memory.
export JAX_PLATFORMS="${JAX_PLATFORMS:-cuda,cpu}"
export XLA_PYTHON_CLIENT_PREALLOCATE="${XLA_PYTHON_CLIENT_PREALLOCATE:-false}"
export XLA_PYTHON_CLIENT_MEM_FRACTION="${XLA_PYTHON_CLIENT_MEM_FRACTION:-0.85}"

echo "[run_pi05_server] CUDA_VISIBLE_DEVICES=${CUDA_VISIBLE_DEVICES:-all}"
echo "[run_pi05_server] JAX_PLATFORMS=$JAX_PLATFORMS"

exec "$PYTHON_BIN" "$SCRIPT_DIR/pi05_zmq_server.py" "$@"
