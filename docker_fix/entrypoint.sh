#!/usr/bin/env bash
# openpi container entrypoint.
# 行为:
#   1. 如果 /openpi_assets 是空的 (常见: 容器首次启动, 用户没挂宿主目录),
#      就把镜像里 /opt/openpi_assets_seed 同步过去, 容器立即就能跑推理.
#   2. 如果 /openpi_assets 已有内容 (用户挂了宿主目录或之前同步过),
#      只补缺失文件, 不覆盖宿主机版本. 用 rsync --ignore-existing 实现.
#   3. INCLUDE_ASSETS=lean 构建出来的镜像里 seed 是空目录, 整步是空操作.
# 这样同一份镜像两种用法都能跑, 不需要构建两次.
set -euo pipefail

SEED_DIR="/opt/openpi_assets_seed"
TARGET_DIR="${OPENPI_DATA_HOME:-/openpi_assets}"

if [ -d "${SEED_DIR}" ] && [ -n "$(ls -A "${SEED_DIR}" 2>/dev/null || true)" ]; then
    mkdir -p "${TARGET_DIR}"
    rsync -a --ignore-existing "${SEED_DIR}/" "${TARGET_DIR}/"
fi

exec "$@"
