import argparse
import json
import re
import shutil
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd


DEFAULT_ROOT = Path("/root/.cache/huggingface/lerobot")
REPO_ID_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
EPISODE_RE = re.compile(r"episode_(\d+)\.parquet$")
COMPAT_FIELDS = ("robot_type", "fps", "features", "codebase_version")


class MergeError(Exception):
    pass


def print_json(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def validate_repo_id(repo_id: str) -> None:
    if not REPO_ID_RE.fullmatch(repo_id):
        raise MergeError(f"invalid repoId: {repo_id}")
    if any(part in {".", ".."} for part in repo_id.split("/")):
        raise MergeError(f"invalid repoId: {repo_id}")


def dataset_dir(root: Path, repo_id: str) -> Path:
    validate_repo_id(repo_id)
    user, name = repo_id.split("/", 1)
    return root / user / name


def read_json(path: Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")


def info_path(ds_dir: Path) -> Path:
    meta_info = ds_dir / "meta" / "info.json"
    return meta_info if meta_info.exists() else ds_dir / "info.json"


def require_sources(root: Path, source_repo_ids: list[str]) -> list[Path]:
    if len(source_repo_ids) < 2:
        raise MergeError("at least two source repoIds are required")
    source_dirs = []
    for repo_id in source_repo_ids:
        ds_dir = dataset_dir(root, repo_id)
        if not ds_dir.exists() or not ds_dir.is_dir():
            raise MergeError(f"source dataset not found: {repo_id}")
        source_dirs.append(ds_dir)
    return source_dirs


def check_compatible(source_repo_ids: list[str], source_dirs: list[Path]) -> list[dict]:
    infos = [read_json(info_path(ds_dir)) for ds_dir in source_dirs]
    base = infos[0]
    for repo_id, info in zip(source_repo_ids[1:], infos[1:], strict=True):
        for field in COMPAT_FIELDS:
            if base.get(field) != info.get(field):
                raise MergeError(f"incompatible {field} in {repo_id}")
    return infos


def parse_task_index(value: object, fallback: int) -> int:
    if isinstance(value, bool):
        return fallback
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return fallback


def resolve_task_ref(
    ref: object,
    task_index_map: dict[int, int],
    task_text_to_index: dict[str, int],
) -> int | None:
    if isinstance(ref, bool):
        return None
    if isinstance(ref, int):
        return task_index_map.get(ref)
    if isinstance(ref, str):
        text = ref.strip()
        if not text:
            return None
        if text.isdigit():
            return task_index_map.get(int(text))
        return task_text_to_index.get(text)
    return None


def collect_tasks(source_dirs: list[Path]) -> tuple[list[dict], list[dict[int, int]], dict[str, int]]:
    tasks: list[dict] = []
    task_index_maps: list[dict[int, int]] = []
    task_text_to_index: dict[str, int] = {}
    for ds_dir in source_dirs:
        index_map: dict[int, int] = {}
        for row in read_jsonl(ds_dir / "meta" / "tasks.jsonl"):
            task = str(row.get("task", "")).strip()
            if not task:
                continue
            old_index = parse_task_index(row.get("task_index"), len(index_map))
            if task not in task_text_to_index:
                task_text_to_index[task] = len(tasks)
                new_row = {**row, "task_index": task_text_to_index[task], "task": task}
                tasks.append(new_row)
            index_map[old_index] = task_text_to_index[task]
        task_index_maps.append(index_map)
    return tasks, task_index_maps, task_text_to_index


def copy_sidecars(source_dirs: list[Path], target_dir: Path) -> None:
    for src_dir in source_dirs:
        for child in src_dir.iterdir():
            if child.name in {"data", "meta", "videos"}:
                continue
            dst = target_dir / child.name
            if dst.exists():
                continue
            if child.is_dir():
                shutil.copytree(child, dst)
            elif child.is_file():
                shutil.copy2(child, dst)


def iter_episode_files(ds_dir: Path) -> list[Path]:
    data_dir = ds_dir / "data"
    if not data_dir.exists():
        raise MergeError(f"missing data directory: {ds_dir}")
    files = sorted(data_dir.glob("chunk-*/episode_*.parquet"))
    if not files:
        raise MergeError(f"no episode parquet files in {data_dir}")
    return files


def rewrite_episode_parquet(
    src: Path,
    dst: Path,
    *,
    new_episode_index: int,
    global_frame_offset: int,
    task_index_map: dict[int, int],
) -> int:
    df = pd.read_parquet(src)
    length = len(df)
    df["episode_index"] = np.int64(new_episode_index)
    df["index"] = np.arange(global_frame_offset, global_frame_offset + length, dtype=np.int64)
    if "task_index" in df.columns and task_index_map:
        df["task_index"] = df["task_index"].map(lambda value: task_index_map.get(int(value), int(value)))
    df.to_parquet(dst, index=False)
    return length


def copy_episodes(
    source_dirs: list[Path],
    target_dir: Path,
    chunk_size: int,
    task_index_maps: list[dict[int, int]],
) -> tuple[int, int]:
    episode_count = 0
    global_frame_offset = 0
    files_copied = 0
    for source_dir, task_index_map in zip(source_dirs, task_index_maps, strict=True):
        for src in iter_episode_files(source_dir):
            match = EPISODE_RE.search(src.name)
            old_episode_index = int(match.group(1)) if match else episode_count
            chunk_idx = episode_count // chunk_size
            dst_dir = target_dir / "data" / f"chunk-{chunk_idx:03d}"
            dst_dir.mkdir(parents=True, exist_ok=True)
            dst = dst_dir / f"episode_{episode_count:06d}.parquet"
            episode_length = rewrite_episode_parquet(
                src,
                dst,
                new_episode_index=episode_count,
                global_frame_offset=global_frame_offset,
                task_index_map=task_index_map,
            )
            global_frame_offset += episode_length
            files_copied += copy_video_files(source_dir, target_dir, old_episode_index, episode_count, chunk_size)
            episode_count += 1
            files_copied += 1
    return episode_count, files_copied


def copy_video_files(
    source_dir: Path,
    target_dir: Path,
    old_episode_index: int,
    new_episode_index: int,
    chunk_size: int,
) -> int:
    videos_dir = source_dir / "videos"
    if not videos_dir.exists():
        return 0
    copied = 0
    old_stem = f"episode_{old_episode_index:06d}"
    new_stem = f"episode_{new_episode_index:06d}"
    new_chunk = f"chunk-{new_episode_index // chunk_size:03d}"
    for src in videos_dir.rglob(f"{old_stem}.*"):
        rel = src.relative_to(videos_dir)
        parts = list(rel.parts)
        parts = [new_chunk if part.startswith("chunk-") else part for part in parts]
        parts[-1] = src.name.replace(old_stem, new_stem, 1)
        dst = target_dir / "videos" / Path(*parts)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        copied += 1
    return copied


def remap_episode_row(
    row: dict,
    episode_index: int,
    task_index_map: dict[int, int],
    task_text_to_index: dict[str, int],
) -> dict:
    out = {**row, "episode_index": episode_index}
    tasks = row.get("tasks")
    if isinstance(tasks, list):
        mapped: list[int] = []
        for ref in tasks:
            new_index = resolve_task_ref(ref, task_index_map, task_text_to_index)
            if new_index is not None:
                mapped.append(new_index)
        if mapped:
            out["tasks"] = mapped
    elif "task_index" in row:
        new_index = resolve_task_ref(row["task_index"], task_index_map, task_text_to_index)
        if new_index is not None:
            out["task_index"] = new_index
    return out


def merge_episodes_stats(source_dirs: list[Path]) -> list[dict]:
    rows: list[dict] = []
    episode_index = 0
    for ds_dir in source_dirs:
        src_rows = read_jsonl(ds_dir / "meta" / "episodes_stats.jsonl")
        ep_files = iter_episode_files(ds_dir)
        if src_rows:
            if len(src_rows) != len(ep_files):
                raise MergeError(f"episodes_stats count mismatch in {ds_dir.name}")
            for row in src_rows:
                rows.append({**row, "episode_index": episode_index})
                episode_index += 1
            continue
        stats_path = ds_dir / "meta" / "stats.json"
        if stats_path.exists():
            stats = read_json(stats_path)
            for _ in ep_files:
                rows.append({"episode_index": episode_index, "stats": stats})
                episode_index += 1
            continue
        raise MergeError(
            f"missing meta/episodes_stats.jsonl in {ds_dir.name}; "
            "recompute dataset stats before merging"
        )
    return rows


def merge_episode_metadata(
    source_dirs: list[Path],
    task_index_maps: list[dict[int, int]],
    task_text_to_index: dict[str, int],
) -> list[dict]:
    rows: list[dict] = []
    episode_index = 0
    for ds_dir, task_index_map in zip(source_dirs, task_index_maps, strict=True):
        src_rows = read_jsonl(ds_dir / "meta" / "episodes.jsonl")
        if not src_rows:
            for _ in iter_episode_files(ds_dir):
                rows.append({"episode_index": episode_index})
                episode_index += 1
            continue
        for row in src_rows:
            rows.append(remap_episode_row(row, episode_index, task_index_map, task_text_to_index))
            episode_index += 1
    return rows


def merge_info(infos: list[dict], episodes_merged: int) -> dict:
    out = dict(infos[0])
    out["total_episodes"] = episodes_merged
    out["total_frames"] = sum(int(info.get("total_frames") or 0) for info in infos)
    if any("total_videos" in info for info in infos):
        out["total_videos"] = sum(int(info.get("total_videos") or 0) for info in infos)
    return out


def merge_datasets(root: Path, source_repo_ids: list[str], target_repo_id: str, overwrite: bool) -> dict:
    root = root.resolve()
    target_dir = dataset_dir(root, target_repo_id)
    source_dirs = require_sources(root, source_repo_ids)
    if target_repo_id in source_repo_ids:
        raise MergeError("target repoId must not be one of the sources")
    if target_dir.exists() and not overwrite:
        raise MergeError(f"target dataset already exists: {target_repo_id}")

    infos = check_compatible(source_repo_ids, source_dirs)
    chunk_size = int(infos[0].get("chunks_size") or 1000)
    tasks, task_index_maps, task_text_to_index = collect_tasks(source_dirs)
    episodes = merge_episode_metadata(source_dirs, task_index_maps, task_text_to_index)
    episodes_stats = merge_episodes_stats(source_dirs)
    staging = target_dir.parent / f".{target_dir.name}.tmp.{int(time.time() * 1000)}"
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    try:
        copy_sidecars(source_dirs, staging)
        episodes_merged, files_copied = copy_episodes(source_dirs, staging, chunk_size, task_index_maps)
        if episodes and len(episodes) != episodes_merged:
            raise MergeError("episode metadata count does not match copied files")
        write_jsonl(staging / "meta" / "tasks.jsonl", tasks)
        write_jsonl(staging / "meta" / "episodes.jsonl", episodes)
        write_jsonl(staging / "meta" / "episodes_stats.jsonl", episodes_stats)
        info = merge_info(infos, episodes_merged)
        write_json(staging / "meta" / "info.json", info)
        if target_dir.exists():
            shutil.rmtree(target_dir)
        target_dir.parent.mkdir(parents=True, exist_ok=True)
        staging.rename(target_dir)
    except Exception:
        if staging.exists():
            shutil.rmtree(staging)
        raise

    return {
        "ok": True,
        "targetRepoId": target_repo_id,
        "targetDir": str(target_dir),
        "sourceRepoIds": source_repo_ids,
        "episodesMerged": episodes_merged,
        "framesMerged": int(info.get("total_frames") or 0),
        "tasksMerged": len(tasks),
        "filesCopied": files_copied,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Merge local LeRobot-style datasets")
    parser.add_argument("--root", default=str(DEFAULT_ROOT))
    parser.add_argument("--sources", nargs="+", required=True)
    parser.add_argument("--target-repo-id", required=True)
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()

    try:
        payload = merge_datasets(Path(args.root), args.sources, args.target_repo_id, args.overwrite)
        print_json(payload)
        return 0
    except MergeError as exc:
        print_json({"error": str(exc)})
        return 1
    except Exception as exc:
        print_json({"error": f"merge failed: {exc}"})
        return 1


if __name__ == "__main__":
    sys.exit(main())
