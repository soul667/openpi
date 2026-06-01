import sys, json, os, shutil, time, glob, argparse
from pathlib import Path
import numpy as np
import pandas as pd

CHANNEL_KEYS = ["action", "observation.state"]


def detect_dim(df, key):
    if key not in df.columns:
        return None
    arr = np.stack(df[key].to_list())
    return arr.shape[1] if arr.ndim == 2 else None


def gather_stats(parquet_files, gripper_idx):
    out = {}
    for key in CHANNEL_KEYS:
        all_vals = []
        for f in parquet_files:
            df = pd.read_parquet(f, columns=[key])
            arr = np.stack(df[key].to_list())
            if gripper_idx >= arr.shape[1]:
                continue
            all_vals.append(arr[:, gripper_idx].astype(np.float64))
        if not all_vals:
            continue
        v = np.concatenate(all_vals)
        uniq = np.unique(np.round(v, 6))
        out[key] = {
            "min": float(v.min()),
            "max": float(v.max()),
            "mean": float(v.mean()),
            "std": float(v.std()),
            "median": float(np.median(v)),
            "count": int(v.size),
            "unique_count": int(uniq.size),
            "unique_preview": [float(x) for x in uniq[:10].tolist()],
        }
    return out


def cmd_stats(args):
    ds_dir = Path(args.dataset_dir)
    parquets = sorted(glob.glob(str(ds_dir / "data" / "chunk-*" / "episode_*.parquet")))
    if not parquets:
        print(json.dumps({"error": f"no parquet in {ds_dir}/data"}))
        return 1
    sample = pd.read_parquet(parquets[0])
    dims = {k: detect_dim(sample, k) for k in CHANNEL_KEYS}
    last_idx = max(d for d in dims.values() if d is not None) - 1
    g_idx = args.gripper_idx if args.gripper_idx is not None else last_idx
    stats = gather_stats(parquets, g_idx)
    print(json.dumps({
        "datasetDir": str(ds_dir),
        "fileCount": len(parquets),
        "dims": dims,
        "gripperIdx": g_idx,
        "stats": stats,
    }))
    return 0


def transform_value(v, mode, params):
    if mode == "threshold-binary":
        thr = float(params["threshold"])
        return (v >= thr).astype(np.float32)
    if mode == "minmax-01":
        lo = float(params["min"])
        hi = float(params["max"])
        if hi - lo < 1e-9:
            return np.zeros_like(v, dtype=np.float32)
        return ((v - lo) / (hi - lo)).clip(0.0, 1.0).astype(np.float32)
    if mode == "divide":
        d = float(params["divisor"])
        return (v / d).astype(np.float32)
    raise ValueError(f"unknown mode: {mode}")


def cmd_apply(args):
    ds_dir = Path(args.dataset_dir).resolve()
    parquets = sorted(glob.glob(str(ds_dir / "data" / "chunk-*" / "episode_*.parquet")))
    if not parquets:
        print(json.dumps({"error": "no parquet"}))
        return 1
    sample = pd.read_parquet(parquets[0])
    dims = {k: detect_dim(sample, k) for k in CHANNEL_KEYS}
    last_idx = max(d for d in dims.values() if d is not None) - 1
    g_idx = args.gripper_idx if args.gripper_idx is not None else last_idx

    backup_path = None
    if args.backup:
        ts = time.strftime("%Y%m%d-%H%M%S")
        backup_path = ds_dir.parent / f"{ds_dir.name}.bak.{ts}"
        shutil.copytree(ds_dir, backup_path)

    params = json.loads(args.params or "{}")
    changed = 0
    for f in parquets:
        df = pd.read_parquet(f)
        modified = False
        for key in CHANNEL_KEYS:
            if key not in df.columns:
                continue
            arr = np.stack(df[key].to_list()).astype(np.float32)
            if g_idx >= arr.shape[1]:
                continue
            arr[:, g_idx] = transform_value(arr[:, g_idx], args.mode, params)
            df[key] = list(arr)
            modified = True
        if modified:
            df.to_parquet(f, index=False)
            changed += 1

    print(json.dumps({
        "ok": True,
        "datasetDir": str(ds_dir),
        "backupPath": str(backup_path) if backup_path else None,
        "filesProcessed": len(parquets),
        "filesChanged": changed,
        "gripperIdx": g_idx,
        "mode": args.mode,
        "params": params,
    }))
    return 0


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("stats")
    s.add_argument("--dataset-dir", required=True)
    s.add_argument("--gripper-idx", type=int, default=None)
    a = sub.add_parser("apply")
    a.add_argument("--dataset-dir", required=True)
    a.add_argument("--gripper-idx", type=int, default=None)
    a.add_argument("--mode", required=True, choices=["threshold-binary", "minmax-01", "divide"])
    a.add_argument("--params", default="{}")
    a.add_argument("--backup", action="store_true")
    args = p.parse_args()
    if args.cmd == "stats":
        return cmd_stats(args)
    if args.cmd == "apply":
        return cmd_apply(args)
    return 1


if __name__ == "__main__":
    sys.exit(main())
