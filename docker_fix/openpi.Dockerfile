# Portable Dockerfile for openpi.
#
# 设计目标：把镜像拷到任何一台装了 NVIDIA driver + nvidia-container-toolkit
# 的机器上都能直接跑，不依赖宿主机的源码挂载、apt 镜像源、代理。
#
# Build (从仓库根目录跑):
#   # 轻量版 (不含 34GB 预训练权重)
#   docker compose -f docker_fix/compose.yml build
#
#   # 带预训练权重的完整版 (镜像 ~50GB)
#   docker_fix/prepare_assets.sh                # 把 ~/.cache/openpi 暂存到 docker_fix/_assets_stage
#   docker compose -f docker_fix/compose.yml build  # .env 里 INCLUDE_ASSETS=full
#
# Run:
#   docker compose -f docker_fix/compose.yml up -d
#   docker compose -f docker_fix/compose.yml exec openpi bash

# ---- base image ----
# CUDA 12.2 + cuDNN8 runtime, 与 jax[cuda12]==0.5.3 / torch==2.7.1 兼容.
# 可通过 --build-arg BASE_IMAGE=... 覆盖, 用于墙内/离线场景换 registry mirror.
ARG BASE_IMAGE=nvidia/cuda:12.2.2-cudnn8-runtime-ubuntu22.04@sha256:2d913b09e6be8387e1a10976933642c73c840c0b735f0bf3c28d97fc9bc422e0
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.5.1

# INCLUDE_ASSETS = lean | full
#   lean (默认): 不烘焙预训练权重, 容器靠宿主机挂载或运行时下载
#   full      : 把 docker_fix/_assets_stage/ (由 prepare_assets.sh 准备) 烘到 /opt/openpi_assets_seed
ARG INCLUDE_ASSETS=lean

FROM ${UV_IMAGE} AS uv_stage

# ---- assets stages ----
# 用 ARG 选择 FROM 来实现 INCLUDE_ASSETS 的二选一: lean 时 assets_resolved 是 scratch (空),
# full 时它带着 _assets_stage 的内容. 这样最终 stage 的 COPY --from=assets_resolved
# 在两种模式下都合法, 不需要条件 COPY.
FROM scratch AS assets_lean

FROM scratch AS assets_full
COPY docker_fix/_assets_stage/ /

FROM assets_${INCLUDE_ASSETS} AS assets_resolved

# ---- main stage ----
FROM ${BASE_IMAGE}

ARG APT_MIRROR=""
ARG HTTP_PROXY=""
ARG HTTPS_PROXY=""
ARG NO_PROXY="localhost,127.0.0.1"
ARG http_proxy=""
ARG https_proxy=""
ARG no_proxy="localhost,127.0.0.1"

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Shanghai \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# ---- system deps (一次性装齐, 离线机器也能用) ----
RUN if [ -n "$APT_MIRROR" ]; then \
        sed -i "s|http://archive.ubuntu.com/ubuntu|$APT_MIRROR|g; s|http://security.ubuntu.com/ubuntu|$APT_MIRROR|g" /etc/apt/sources.list; \
    fi \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        wget \
        git \
        git-lfs \
        rsync \
        build-essential \
        clang \
        linux-headers-generic \
        libgl1 \
        libglib2.0-0 \
        libsm6 \
        libxext6 \
        libxrender1 \
        libgtk-3-0 \
        ffmpeg \
        tzdata \
        tini \
    && git lfs install --system \
    && rm -rf /var/lib/apt/lists/*

COPY --from=uv_stage /uv /uvx /bin/

WORKDIR /app

# venv 放在 /app 之外, 避免被宿主机挂载覆盖
ENV UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH=/opt/venv/bin:$PATH

# 只 COPY 解析依赖必需的清单, 改源码不会让这一层失效
COPY pyproject.toml uv.lock /app/
COPY packages/openpi-client/pyproject.toml /app/packages/openpi-client/pyproject.toml
COPY packages/openpi-client/src /app/packages/openpi-client/src

RUN --mount=type=cache,target=/root/.cache/uv \
    uv venv --python 3.11.9 "$UV_PROJECT_ENVIRONMENT" \
 && GIT_LFS_SKIP_SMUDGE=1 uv sync --frozen --no-install-project --no-dev

COPY src /app/src
COPY scripts /app/scripts
COPY README.md LICENSE LICENSE_GEMMA.txt /app/

# transformers monkey-patch: 仓库里的替换文件覆盖到已安装的 transformers
COPY src/openpi/models_pytorch/transformers_replace/ /tmp/transformers_replace/
RUN TR_DIR="$(/opt/venv/bin/python -c 'import transformers, os; print(os.path.dirname(transformers.__file__))')" \
 && cp -r /tmp/transformers_replace/. "$TR_DIR"/ \
 && rm -rf /tmp/transformers_replace

# editable install. --no-deps 避免重复解析锁文件
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python "$UV_PROJECT_ENVIRONMENT/bin/python" --no-deps -e . \
 && uv pip install --python "$UV_PROJECT_ENVIRONMENT/bin/python" --no-deps -e packages/openpi-client

# ---- 烘焙资产 (INCLUDE_ASSETS=full 才有内容, lean 是空目录) ----
# /opt/openpi_assets_seed 包含: openpi-assets/checkpoints/{pi0_base, pi05_base, pi0_fast_base}
# + big_vision/paligemma_tokenizer.model. 运行时由 entrypoint 同步到 /openpi_assets.
COPY --from=assets_resolved / /opt/openpi_assets_seed/

# ---- 运行时环境 ----
ENV IS_DOCKER=true \
    OPENPI_DATA_HOME=/openpi_assets \
    HF_HOME=/root/.cache/huggingface \
    JAX_COMPILATION_CACHE_DIR=/jax_cache

RUN mkdir -p /openpi_assets /jax_cache /root/.cache/huggingface /dataset

# entrypoint: 启动时把 seed 同步到 /openpi_assets (只补缺失文件, 不覆盖宿主机已有)
COPY docker_fix/entrypoint.sh /usr/local/bin/openpi-entrypoint
RUN chmod +x /usr/local/bin/openpi-entrypoint

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/openpi-entrypoint"]
CMD ["bash"]
