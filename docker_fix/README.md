# openpi 便携 Docker 镜像

为了能把镜像直接拷到别的机器上跑，这套配置和仓库根目录的 `compose.yml` / `scripts/docker/` 隔离，**不修改任何外面的文件**。

## 设计：镜像负责"环境 + 可选权重"，git 负责"源码"

镜像里都打了什么：
- CUDA 12.2 + cuDNN8 base
- 系统依赖（`libgl1`、`ffmpeg` 等，不再启动时联网装）
- `/opt/venv`：所有 Python 依赖（`uv sync --frozen` 出来的，跟 `uv.lock` 一致）
- transformers patch（已经 patch 到 venv 里 site-packages 的 transformers）
- 一份源码兜底（COPY 了一份，没挂载也能跑）
- **可选**：`pi0_base` / `pi05_base` / `pi0_fast_base` 等预训练权重 + paligemma tokenizer（共 34 GB）

容器跑起来时：
- **`/app` 是宿主仓库的 bind mount**（`SRC_DIR=..` 指向仓库根目录），git pull 的改动立即生效
- venv 在 `/opt/venv`，跟 `/app` 互不干扰，挂载不会把依赖盖掉
- editable install (`-e .` / `-e packages/openpi-client`) 在镜像里已经装好了，链接指向 `/app/src`，挂载后 import 走的就是宿主仓库里的源码
- entrypoint 启动时把镜像里 `/opt/openpi_assets_seed/` 的权重补到 `/openpi_assets/`（**只补缺失文件，不覆盖**），所以宿主机有新版权重时仍以宿主为准

## 两种构建模式

## Build 阶段网络 / apt 代理

如果 build 卡在 `apt-get update`，出现 `Temporary failure resolving 'archive.ubuntu.com'`，说明 Docker build 容器内 DNS/代理没通。先在 `.env` 里保留：

```bash
BUILD_NETWORK=host
```

如果还是不通，填代理：

```bash
HTTP_PROXY=http://127.0.0.1:7890
HTTPS_PROXY=http://127.0.0.1:7890
http_proxy=http://127.0.0.1:7890
https_proxy=http://127.0.0.1:7890
NO_PROXY=localhost,127.0.0.1
no_proxy=localhost,127.0.0.1
```

如果是 Ubuntu 源慢/解析失败，可改国内源：

```bash
APT_MIRROR=http://mirrors.tuna.tsinghua.edu.cn/ubuntu
# 或
APT_MIRROR=http://mirrors.aliyun.com/ubuntu
```

然后重新 build。

### Lean (默认, 镜像 ~15 GB)

不带预训练权重，权重靠宿主机 `OPENPI_ASSETS_DIR` 挂载或运行时下载。适合：
- 开发机，权重已经在 `~/.cache/openpi/` 里
- 不想等 cp/scp 大文件

```bash
cp docker_fix/.env.example docker_fix/.env
# .env 里 INCLUDE_ASSETS=lean (默认)
docker compose -f docker_fix/compose.yml --env-file docker_fix/.env build
```

### Full (镜像 ~50 GB)

把 `~/.cache/openpi` (34 GB) 烘进镜像，离线机器拿到镜像就能直接跑推理。适合：
- 部署到外网不通的机器
- 要把"环境 + 权重"打成一个 tar 分发

```bash
# 1. 把权重暂存到 docker_fix/_assets_stage/ (BuildKit 只能从 build context 拷)
bash docker_fix/prepare_assets.sh           # dry-run, 只列动作
bash docker_fix/prepare_assets.sh --apply   # 真执行

# 2. .env 里改 INCLUDE_ASSETS=full
sed -i 's/^INCLUDE_ASSETS=.*/INCLUDE_ASSETS=full/' docker_fix/.env

# 3. 构建
docker compose -f docker_fix/compose.yml --env-file docker_fix/.env build

# 4. 构建完可以删了 _assets_stage, 已经烘进镜像
rm -rf docker_fix/_assets_stage/*
```

> `prepare_assets.sh` 检测同/跨文件系统：同 FS 用硬链接（不占空间），跨 FS 走 rsync（会真占 34 GB）。这台机器上 `~/.cache/openpi` 在 `/`，仓库在 `/data2`，跨 FS，需要真复制。

## 启动 / 进入容器

```bash
docker compose -f docker_fix/compose.yml --env-file docker_fix/.env up -d
docker compose -f docker_fix/compose.yml --env-file docker_fix/.env exec openpi bash
```

容器里:

```bash
uv run scripts/serve_policy.py ...
XLA_PYTHON_CLIENT_MEM_FRACTION=0.9 uv run scripts/train.py pi0_rcvlab_low_mem_finetune --exp-name=pi03 --overwrite
```

## 日常开发

宿主机 `git pull` → 容器里直接生效，**不需要重启容器**。
改了 `pyproject.toml` / `uv.lock` → 重 build 镜像。
只改 Python 代码不需要重 build。

## 拷到别的机器

### Full 镜像（最方便，新机器拿来即用）

```bash
docker save openpi_portable:latest | gzip > openpi_portable_full.tar.gz   # ~50 GB
scp openpi_portable_full.tar.gz docker_fix/compose.yml docker_fix/.env user@target:~/openpi/
# 目标机器:
gunzip -c openpi_portable_full.tar.gz | docker load
docker run --rm -it --gpus all --shm-size=32g openpi_portable bash
# 容器里 /openpi_assets 已经被 entrypoint 自动填好, 直接推理
```

### Lean 镜像 + 单独同步权重

镜像小（15 GB）但目标机器上得自己准备权重：

```bash
docker save openpi_portable:latest | gzip > openpi_portable_lean.tar.gz   # ~15 GB
scp openpi_portable_lean.tar.gz user@target:~/
# 单独 rsync 权重 (能续传, 比塞进镜像灵活)
rsync -av --progress ~/.cache/openpi/ user@target:~/.cache/openpi/
# 目标机器:
gunzip -c openpi_portable_lean.tar.gz | docker load
# .env 里把 OPENPI_ASSETS_DIR 指到 ~/.cache/openpi
```

## 给 openpi-ui 远端训练用的目标服务器配置

`tools/openpi-ui` 的远端训练逻辑会做三件事：

1. 本机 UI 根据 `Repo ID=user/dataset` 把数据集 rsync 到远端宿主机：
   `REMOTE.datasetRoot/user/dataset`
2. 本机 UI 通过 SSH 在远端执行：
   `docker exec -d <containerName> bash -lc "uv run scripts/train.py ..."`
3. 本机 UI 通过 SSH 读取远端宿主机上的：
   `REMOTE.repoRoot/logs/<job>.log`

因此远端服务器的 compose **必须**把 rsync 目标目录挂进容器。推荐直接用这里的模板：

```bash
cd /data2/axgu/code/openpi
cp docker_fix/.env.remote-example docker_fix/.env
docker compose -f docker_fix/compose.yml --env-file docker_fix/.env up -d --no-build
```

`.env.remote-example` 的关键挂载是：

```env
CONTAINER_NAME=openpi
SRC_DIR=..
OPENPI_ASSETS_DIR=/data2/axgu/.cache/openpi
HF_CACHE_DIR=/data2/axgu/.cache/huggingface
DATASET_DIR=/data2/axgu/.cache/huggingface/lerobot
JAX_CACHE_DIR=/data2/axgu/jaxcache
```

compose 会把：

```text
/data2/axgu/.cache/huggingface  ->  /root/.cache/huggingface
```

所以 UI rsync 到远端宿主机的：

```text
/data2/axgu/.cache/huggingface/lerobot/<user>/<dataset>
```

容器里能直接看到：

```text
/root/.cache/huggingface/lerobot/<user>/<dataset>
```

远端服务器启动后，用本机验证：

```bash
ssh axgu@10.16.117.238 "docker ps --format '{{.Names}}' | grep '^openpi$'"
ssh axgu@10.16.117.238 "docker exec openpi ls /app/scripts/train.py"
ssh axgu@10.16.117.238 "docker exec openpi ls /root/.cache/huggingface/lerobot"
ssh axgu@10.16.117.238 "nvidia-smi --query-gpu=index,name,memory.free --format=csv,noheader,nounits"
```

如果再加远端服务器，在本机 UI 的：

```text
tools/openpi-ui/.data/remotes.json
```

加入新 profile，例如：

```json
{
  "id": "srv-117-238",
  "label": "axgu@10.16.117.238",
  "sshTarget": "axgu@10.16.117.238",
  "repoRoot": "/data2/axgu/code/openpi",
  "datasetRoot": "/data2/axgu/.cache/huggingface/lerobot",
  "containerName": "openpi"
}
```

`datasetRoot` 必须和远端 `.env.remote-example` 里的 `DATASET_DIR` / `HF_CACHE_DIR` 对应，否则数据只会到远端宿主机，容器里看不到。

## 关于 finetune checkpoints

`/data2/axgu/code/openpi/checkpoints/` 那 432 GB 没有打进镜像，理由：
- 单个 ckpt 几十到几百 GB，每次训完都变，镜像跟着膨胀不合理
- 镜像层一旦确定 hash 不会变，新 ckpt 只能重 build
- Docker registry 也 push 不动

建议用 rsync/scp 单独同步 `checkpoints/` 目录。当前 `compose.yml` 把仓库整个挂到 `/app`，所以 `/app/checkpoints` = 宿主 `<仓库>/checkpoints`，足够了。

## .env 配置说明

| 变量 | 默认 | 说明 |
|---|---|---|
| `INCLUDE_ASSETS` | `lean` | `lean` (~15GB) / `full` (~50GB), 切换前先跑 `prepare_assets.sh --apply` |
| `SRC_DIR` | `..` (仓库根) | 挂到 `/app` 的宿主仓库路径 |
| `GPU_COUNT` | `all` | 用几张卡, 可填 `1` / `2` / `all` |
| `NVIDIA_VISIBLE_DEVICES` | `all` | 哪些卡可见, 可填 `0,1` |
| `OPENPI_ASSETS_DIR` | `./_volumes/openpi_assets` | `/openpi_assets` 的宿主机路径 |
| `DATASET_DIR` | `./_volumes/dataset` | `/dataset` 的宿主机路径 |
| `HF_CACHE_DIR` | `./_volumes/hf_cache` | huggingface 缓存 |
| `JAX_CACHE_DIR` | `./_volumes/jax_cache` | JAX 编译缓存 |
| `SHM_SIZE` | `32gb` | 大 batch 训练别给少了 |
| `NETWORK_MODE` | `host` | 不需要 host 网络可改 `bridge` |
| `BASE_IMAGE` | docker.io 的 cuda 12.2.2 | 墙内可换成华为云/阿里云 mirror |
| `WANDB_API_KEY` | 空 | wandb 登录 |
| `HUGGING_FACE_HUB_TOKEN` | 空 | HF 私有模型用 |

`_volumes/` 默认是 compose 文件**所在目录**的相对路径，即 `docker_fix/_volumes/`。要沿用绝对路径如 `/data2/qeli/datasets/...` 把 `.env` 里改成绝对路径即可。

## 它修了什么（vs 旧 compose.yml）

| 问题 | 旧版 | 这里 |
|---|---|---|
| 启动时 `apt-get install libgl1 libglib2.0-0 ffmpeg` | 每次启动联网装 | 一次性打进镜像 |
| 源码靠 `$PWD:/app` 挂载, 但镜像里啥都没有 | 离开本机就空了 | 镜像 COPY 一份兜底 + 仍 bind mount 宿主 |
| GPU id 写死 `["0","1","2","3"]` | 别的机器卡数不一样就崩 | `GPU_COUNT=all` 走 env |
| 数据/权重路径 `/data2/...` | 别的机器没有这些路径 | 全部走 `.env`, 默认相对路径 |
| `JAX_COMPILATION_CACHE_DIR=/jaxconfig_cache` 但挂 `/jax_cache` | 路径不一致缓存白挂 | 统一 `/jax_cache` |
| 没有 `.dockerignore` 配 Dockerfile | 把 `checkpoints/`、`wandb/`、`.venv` 全打进 build context | `openpi.Dockerfile.dockerignore` |
| PID 1 是 bash | Ctrl-C 信号传不进去 | `tini` 接管 |
| `transformers_replace` patch 用 `xargs dirname` | 在某些 sh 下脆弱 | python 直接拿路径 |
| 预训练权重必须靠宿主机 | 离线机器没法跑 | 可选烘进镜像 |
| 镜像 tag/registry 写死 docker.io | 墙内拉不到 | `BASE_IMAGE` ARG 可换 mirror |

## 文件清单

| 文件 | 作用 |
|---|---|
| `openpi.Dockerfile` | 镜像构建 |
| `openpi.Dockerfile.dockerignore` | 排除 checkpoints/wandb/.venv 等不进 build context |
| `compose.yml` | 服务编排 |
| `.env.example` | 配置模板, 复制成 `.env` 后改 |
| `.gitignore` | 忽略 `.env`、`_volumes/`、`_assets_stage/` 内容 |
| `entrypoint.sh` | 启动时把 seed 资产同步到 `/openpi_assets` |
| `prepare_assets.sh` | full 构建前的暂存脚本 |
| `_assets_stage/` | 占位目录, full 模式构建时由 prepare 脚本填 |
| `_volumes/` | 默认数据卷宿主机位置 (compose 自动建) |
