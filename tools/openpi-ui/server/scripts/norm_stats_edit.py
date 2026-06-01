import argparse
import glob
import json
import shutil
import sys
import time
from pathlib import Path

ASSETS_ROOT = Path("/app/assets")


def find_norm_stats_files(user: str, dataset: str):
    matches = []
    for cfg_dir in sorted(ASSETS_ROOT.iterdir() if ASSETS_ROOT.exists() else []):
        if not cfg_dir.is_dir():
            continue
        f = cfg_dir / user / dataset / "norm_stats.json"
        if f.exists():
            matches.append(
                {
                    "configName": cfg_dir.name,
                    "path": str(f),
                    "mtimeMs": int(f.stat().st_mtime * 1000),
                    "sizeBytes": f.stat().st_size,
                }
            )
    return matches


def cmd_list(args):
    files = find_norm_stats_files(args.user, args.dataset)
    print(json.dumps({"user": args.user, "dataset": args.dataset, "files": files}))
    return 0


def parse_norm_stats(payload: dict):
    norm_stats = payload.get("norm_stats", payload)
    out = {}
    for key, stat in norm_stats.items():
        entry = {
            "mean": list(stat.get("mean") or []),
            "std": list(stat.get("std") or []),
            "q01": list(stat.get("q01") or []) if stat.get("q01") is not None else None,
            "q99": list(stat.get("q99") or []) if stat.get("q99") is not None else None,
        }
        out[key] = entry
    return out


def diagnose(stats: dict):
    diag = {}
    for key, entry in stats.items():
        per_dim = []
        q01 = entry.get("q01")
        q99 = entry.get("q99")
        std = entry.get("std") or []
        n = len(std) if std else (len(q01) if q01 else 0)
        for i in range(n):
            d = {"dim": i}
            if std and i < len(std):
                d["std"] = float(std[i])
                d["stdNearZero"] = float(std[i]) < 1e-3
            if q01 and q99 and i < len(q01) and i < len(q99):
                span = float(q99[i]) - float(q01[i])
                d["q01"] = float(q01[i])
                d["q99"] = float(q99[i])
                d["span"] = span
                d["spanNearZero"] = span < 1e-2
            per_dim.append(d)
        diag[key] = per_dim
    return diag


def cmd_get(args):
    f = Path(args.path)
    if not f.exists():
        print(json.dumps({"error": f"not found: {f}"}))
        return 1
    payload = json.loads(f.read_text())
    stats = parse_norm_stats(payload)
    print(
        json.dumps(
            {
                "path": str(f),
                "mtimeMs": int(f.stat().st_mtime * 1000),
                "stats": stats,
                "diagnostics": diagnose(stats),
            }
        )
    )
    return 0


def cmd_patch(args):
    f = Path(args.path)
    if not f.exists():
        print(json.dumps({"error": f"not found: {f}"}))
        return 1
    payload = json.loads(f.read_text())
    norm_stats = payload.get("norm_stats")
    if norm_stats is None:
        print(json.dumps({"error": "missing norm_stats key in file"}))
        return 1

    overrides = json.loads(args.overrides)
    if not isinstance(overrides, dict):
        print(json.dumps({"error": "overrides must be object"}))
        return 1

    if args.backup:
        ts = time.strftime("%Y%m%d-%H%M%S")
        bak = f.with_suffix(f.suffix + f".bak.{ts}")
        shutil.copy2(f, bak)
    else:
        bak = None

    changed_dims = []
    for key, dim_overrides in overrides.items():
        if key not in norm_stats:
            continue
        stat = norm_stats[key]
        for field in ("mean", "std", "q01", "q99"):
            new_vals = (dim_overrides or {}).get(field)
            if not new_vals:
                continue
            if stat.get(field) is None:
                stat[field] = list(new_vals.get("values") or [])
            cur = list(stat.get(field) or [])
            for idx_str, val in (new_vals.get("dims") or {}).items():
                idx = int(idx_str)
                if idx < 0 or idx >= len(cur):
                    continue
                if cur[idx] != val:
                    cur[idx] = float(val)
                    changed_dims.append({"key": key, "field": field, "dim": idx, "value": float(val)})
            stat[field] = cur
        norm_stats[key] = stat
    payload["norm_stats"] = norm_stats

    f.write_text(json.dumps(payload, indent=2))
    print(
        json.dumps(
            {
                "ok": True,
                "path": str(f),
                "backupPath": str(bak) if bak else None,
                "changedDims": changed_dims,
            }
        )
    )
    return 0


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    s_list = sub.add_parser("list")
    s_list.add_argument("--user", required=True)
    s_list.add_argument("--dataset", required=True)
    s_list.set_defaults(func=cmd_list)

    s_get = sub.add_parser("get")
    s_get.add_argument("--path", required=True)
    s_get.set_defaults(func=cmd_get)

    s_patch = sub.add_parser("patch")
    s_patch.add_argument("--path", required=True)
    s_patch.add_argument("--overrides", required=True)
    s_patch.add_argument("--backup", action="store_true")
    s_patch.set_defaults(func=cmd_patch)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
