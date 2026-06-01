#!/usr/bin/env bash
# 把 OPENPI_DATA_HOME (默认 ~/.cache/openpi) 复制到 docker_fix/_assets_stage/
# 给 INCLUDE_ASSETS=full 的镜像构建用. BuildKit 不能跨 build context 引用任意路径,
# 所以必须先把资产搬进项目目录.
#
# 跨文件系统时只能 cp/rsync (会真占盘); 同文件系统时用硬链接, 不额外占空间.
# 默认 dry-run 列出动作, 加 --apply 才真做.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${OPENPI_DATA_HOME:-${HOME}/.cache/openpi}"
DST="${SCRIPT_DIR}/_assets_stage"

APPLY=0
for arg in "$@"; do
    case "${arg}" in
        --apply) APPLY=1 ;;
        -h|--help)
            cat <<'USAGE'
用法: prepare_assets.sh [--apply]

不带参数: 列出会做什么 (dry-run).
--apply : 真执行.

环境变量:
  OPENPI_DATA_HOME  源目录 (默认 ~/.cache/openpi)
USAGE
            exit 0
            ;;
        *) echo "未知参数: ${arg}" >&2; exit 1 ;;
    esac
done

if [ ! -d "${SRC}" ]; then
    echo "ERROR: 源目录不存在: ${SRC}" >&2
    exit 1
fi

src_dev=$(stat -c '%d' "${SRC}")
mkdir -p "${DST}"
dst_dev=$(stat -c '%d' "${DST}")

if [ "${src_dev}" = "${dst_dev}" ]; then
    MODE="hardlink (同文件系统, 不额外占空间)"
    CMD="cp -al"
else
    MODE="copy (跨文件系统, 会真占盘)"
    CMD="rsync -a"
fi

SIZE=$(du -sh "${SRC}" 2>/dev/null | cut -f1)

echo "源:    ${SRC}  (大小 ${SIZE})"
echo "目标:  ${DST}"
echo "模式:  ${MODE}"
echo

if [ "${APPLY}" -ne 1 ]; then
    echo "dry-run. 加 --apply 真执行."
    exit 0
fi

echo "开始同步..."
if [ "${CMD}" = "cp -al" ]; then
    rm -rf "${DST}"
    cp -al "${SRC}" "${DST}"
else
    rsync -a --info=progress2 "${SRC}/" "${DST}/"
fi

echo
echo "完成. 现在可以构建带预训练权重的镜像:"
echo "  在 docker_fix/.env 里设 INCLUDE_ASSETS=full"
echo "  docker compose -f docker_fix/compose.yml --env-file docker_fix/.env build"
