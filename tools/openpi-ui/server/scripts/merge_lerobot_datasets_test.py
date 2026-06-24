import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pandas as pd


SCRIPT = Path(__file__).with_name("merge_lerobot_datasets.py")


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")


def write_episode_parquet(
    path: Path,
    *,
    episode_index: int,
    global_offset: int,
    length: int = 3,
    task_index: int = 0,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    df = pd.DataFrame(
        {
            "episode_index": np.full(length, episode_index, dtype=np.int64),
            "index": np.arange(global_offset, global_offset + length, dtype=np.int64),
            "frame_index": np.arange(length, dtype=np.int64),
            "timestamp": np.arange(length, dtype=np.float32) / 10.0,
            "task_index": np.full(length, task_index, dtype=np.int64),
        }
    )
    df.to_parquet(path, index=False)


def make_dataset(root: Path, repo_id: str, *, start_task_index: int = 0, task: str = "pick") -> None:
    dataset_dir = root / repo_id
    (dataset_dir / "meta").mkdir(parents=True, exist_ok=True)
    (dataset_dir / "data" / "chunk-000").mkdir(parents=True, exist_ok=True)
    (dataset_dir / "meta" / "info.json").write_text(
        json.dumps(
            {
                "robot_type": "testbot",
                "fps": 10,
                "total_episodes": 1,
                "total_frames": 3,
                "total_videos": 0,
                "chunks_size": 1000,
                "features": {"action": {"dtype": "float32", "shape": [2]}},
            }
        ),
        encoding="utf-8",
    )
    write_jsonl(dataset_dir / "meta" / "tasks.jsonl", [{"task_index": start_task_index, "task": task}])
    write_jsonl(
        dataset_dir / "meta" / "episodes.jsonl",
        [{"episode_index": 0, "tasks": [start_task_index], "length": 3}],
    )
    write_jsonl(
        dataset_dir / "meta" / "episodes_stats.jsonl",
        [
            {
                "episode_index": 0,
                "stats": {
                    "action": {
                        "min": [0.0, 0.0],
                        "max": [1.0, 1.0],
                        "mean": [0.5, 0.5],
                        "std": [0.1, 0.1],
                        "count": [3],
                    }
                },
            }
        ],
    )
    write_episode_parquet(
        dataset_dir / "data" / "chunk-000" / "episode_000000.parquet",
        episode_index=0,
        global_offset=0,
        task_index=start_task_index,
    )


def run_merge(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--root", str(root), *args],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def parse_json(stdout: str) -> dict:
    return json.loads(stdout[stdout.index("{") :])


def test_merge_two_datasets(tmp_path: Path) -> None:
    make_dataset(tmp_path, "alice/one", start_task_index=0, task="pick")
    make_dataset(tmp_path, "alice/two", start_task_index=7, task="place")

    proc = run_merge(tmp_path, "--sources", "alice/one", "alice/two", "--target-repo-id", "alice/merged")

    assert proc.returncode == 0, proc.stderr
    payload = parse_json(proc.stdout)
    assert payload["ok"] is True
    assert payload["targetRepoId"] == "alice/merged"
    assert payload["episodesMerged"] == 2
    assert payload["framesMerged"] == 6
    assert payload["tasksMerged"] == 2
    assert (tmp_path / "alice" / "merged" / "data" / "chunk-000" / "episode_000000.parquet").exists()
    assert (tmp_path / "alice" / "merged" / "data" / "chunk-000" / "episode_000001.parquet").exists()

    info = json.loads((tmp_path / "alice" / "merged" / "meta" / "info.json").read_text())
    assert info["total_episodes"] == 2
    assert info["total_frames"] == 6

    tasks = [json.loads(line) for line in (tmp_path / "alice" / "merged" / "meta" / "tasks.jsonl").read_text().splitlines()]
    assert tasks == [{"task_index": 0, "task": "pick"}, {"task_index": 1, "task": "place"}]

    episodes = [
        json.loads(line) for line in (tmp_path / "alice" / "merged" / "meta" / "episodes.jsonl").read_text().splitlines()
    ]
    assert episodes[0]["episode_index"] == 0
    assert episodes[0]["tasks"] == [0]
    assert episodes[1]["episode_index"] == 1
    assert episodes[1]["tasks"] == [1]

    episodes_stats = [
        json.loads(line)
        for line in (tmp_path / "alice" / "merged" / "meta" / "episodes_stats.jsonl").read_text().splitlines()
    ]
    assert len(episodes_stats) == 2
    assert episodes_stats[0]["episode_index"] == 0
    assert episodes_stats[1]["episode_index"] == 1

    ep0 = pd.read_parquet(tmp_path / "alice" / "merged" / "data" / "chunk-000" / "episode_000000.parquet")
    ep1 = pd.read_parquet(tmp_path / "alice" / "merged" / "data" / "chunk-000" / "episode_000001.parquet")
    assert ep0["episode_index"].tolist() == [0, 0, 0]
    assert ep0["index"].tolist() == [0, 1, 2]
    assert ep0["task_index"].tolist() == [0, 0, 0]
    assert ep1["episode_index"].tolist() == [1, 1, 1]
    assert ep1["index"].tolist() == [3, 4, 5]
    assert ep1["task_index"].tolist() == [1, 1, 1]


def test_merge_episodes_with_task_strings(tmp_path: Path) -> None:
    make_dataset(tmp_path, "alice/one", start_task_index=0, task="move the bag to the shelf")
    make_dataset(tmp_path, "alice/two", start_task_index=0, task="place the cup on the table")
    episodes_path = tmp_path / "alice" / "one" / "meta" / "episodes.jsonl"
    write_jsonl(
        episodes_path,
        [{"episode_index": 0, "tasks": ["move the bag to the shelf"], "length": 3}],
    )
    episodes_path = tmp_path / "alice" / "two" / "meta" / "episodes.jsonl"
    write_jsonl(
        episodes_path,
        [{"episode_index": 0, "tasks": ["place the cup on the table"], "length": 3}],
    )

    proc = run_merge(tmp_path, "--sources", "alice/one", "alice/two", "--target-repo-id", "alice/merged")

    assert proc.returncode == 0, proc.stderr
    payload = parse_json(proc.stdout)
    assert payload["ok"] is True
    episodes = [
        json.loads(line) for line in (tmp_path / "alice" / "merged" / "meta" / "episodes.jsonl").read_text().splitlines()
    ]
    assert episodes[0]["tasks"] == [0]
    assert episodes[1]["tasks"] == [1]


def test_refuses_existing_target_without_overwrite(tmp_path: Path) -> None:
    make_dataset(tmp_path, "alice/one")
    make_dataset(tmp_path, "alice/two")
    make_dataset(tmp_path, "alice/merged")

    proc = run_merge(tmp_path, "--sources", "alice/one", "alice/two", "--target-repo-id", "alice/merged")

    payload = parse_json(proc.stdout)

    assert proc.returncode != 0
    assert "already exists" in payload["error"]


def test_rejects_invalid_repo_id(tmp_path: Path) -> None:
    make_dataset(tmp_path, "alice/one")
    make_dataset(tmp_path, "alice/two")

    proc = run_merge(tmp_path, "--sources", "alice/one", "../bad", "--target-repo-id", "alice/merged")
    payload = parse_json(proc.stdout)

    assert proc.returncode != 0
    assert "invalid repoId" in payload["error"]


def test_requires_compatible_info(tmp_path: Path) -> None:
    make_dataset(tmp_path, "alice/one")
    make_dataset(tmp_path, "alice/two")
    info_path = tmp_path / "alice" / "two" / "meta" / "info.json"
    info = json.loads(info_path.read_text())
    info["fps"] = 30
    info_path.write_text(json.dumps(info), encoding="utf-8")

    proc = run_merge(tmp_path, "--sources", "alice/one", "alice/two", "--target-repo-id", "alice/merged")
    payload = parse_json(proc.stdout)

    assert proc.returncode != 0
    assert "incompatible" in payload["error"]
