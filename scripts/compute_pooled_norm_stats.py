import dataclasses
from typing import Sequence

import numpy as np
import tqdm
import tyro

import openpi.models.model as _model
import openpi.shared.normalize as normalize
import openpi.training.config as _config
import openpi.training.data_loader as _data_loader
import openpi.transforms as transforms


class RemoveStrings(transforms.DataTransformFn):
    def __call__(self, x: dict) -> dict:
        return {k: v for k, v in x.items() if not np.issubdtype(np.asarray(v).dtype, np.str_)}


def create_torch_dataloader(
    data_config: _config.DataConfig,
    action_horizon: int,
    batch_size: int,
    model_config: _model.BaseModelConfig,
    num_workers: int,
    max_frames: int | None = None,
) -> tuple[_data_loader.Dataset, int]:
    if data_config.repo_id is None:
        raise ValueError("Data config must have a repo_id")
    dataset = _data_loader.create_torch_dataset(data_config, action_horizon, model_config)
    dataset = _data_loader.TransformedDataset(
        dataset,
        [
            *data_config.repack_transforms.inputs,
            *data_config.data_transforms.inputs,
            RemoveStrings(),
        ],
    )
    if max_frames is not None and max_frames < len(dataset):
        num_batches = max_frames // batch_size
        shuffle = True
    else:
        num_batches = len(dataset) // batch_size
        shuffle = False
    data_loader = _data_loader.TorchDataLoader(
        dataset,
        local_batch_size=batch_size,
        num_workers=num_workers,
        shuffle=shuffle,
        num_batches=num_batches,
    )
    return data_loader, num_batches


def create_rlds_dataloader(
    data_config: _config.DataConfig,
    action_horizon: int,
    batch_size: int,
    max_frames: int | None = None,
) -> tuple[_data_loader.Dataset, int]:
    dataset = _data_loader.create_rlds_dataset(data_config, action_horizon, batch_size, shuffle=False)
    dataset = _data_loader.IterableTransformedDataset(
        dataset,
        [
            *data_config.repack_transforms.inputs,
            *data_config.data_transforms.inputs,
            RemoveStrings(),
        ],
        is_batched=True,
    )
    if max_frames is not None and max_frames < len(dataset):
        num_batches = max_frames // batch_size
    else:
        num_batches = len(dataset) // batch_size
    data_loader = _data_loader.RLDSDataLoader(
        dataset,
        num_batches=num_batches,
    )
    return data_loader, num_batches


def main(
    config_name: str,
    *,
    asset_id: str,
    repo_ids: Sequence[str],
    max_frames: int | None = None,
    max_frames_per_dataset: int | None = None,
):
    """Compute ONE stable norm by pooling raw episodes from several LeRobot repos.

    Why this exists:
      Individual small datasets (your luobai/pick_bag_3 etc.) often produce
      terrible per-dim std/q01/q99 (especially on gripper or rarely-used joints).
      After normalization (z-score for pi0, quantile for pi05) you get huge values
      → immediate loss=nan / grad=nan at step 0. The README even documents this
      exact failure mode under "Diverging training loss".

    This script does the same transform pipeline as compute_norm_stats.py but
    feeds *all* the chosen repo-ids into the same RunningStats objects, then
    saves the result under a *stable* asset name instead of the repo name.

    Result location:
        assets/<config-name>/<asset_id>/norm_stats.json

    How to use the result:
      - In openpi-ui Train page: the new "Norm asset ID" dropdown will list it
        (once the file exists). Pick it → server will --data.assets.asset-id + do
        the "manual replace into the repo slot" before starting the job.
      - Or pass on the command line:
        --data.assets.asset-id=luobai_pooled
      - Or hard-code in your TrainConfig:
        data=LeRobotRcvlabDataConfig(..., assets=AssetsConfig(asset_id="luobai_pooled"))

    All your luobai repos must share the same robot kinematics + the same
    DataConfig transforms (repack, RcvlabInputs, DeltaActions mask, etc.).

    Example:
        python scripts/compute_pooled_norm_stats.py \
            --config-name=pi05_mtbot \
            --asset-id=luobai_pooled \
            --repo-ids luobai/pick_bag_3 luobai/move_banana_to_box_3 ... \
            --max-frames 150000
    """
    if not repo_ids:
        raise ValueError("At least one --repo-ids is required")

    base_config = _config.get_config(config_name)
    assets_dirs = base_config.assets_dirs

    keys = ["state", "actions"]
    pooled_stats = {key: normalize.RunningStats() for key in keys}

    total_samples = 0
    per_repo_limits = max_frames_per_dataset or max_frames

    for rid in repo_ids:
        print(f"\n=== Pooling from {rid} ===")
        cfg = dataclasses.replace(
            base_config,
            data=dataclasses.replace(base_config.data, repo_id=rid),
        )
        data_config = cfg.data.create(assets_dirs, cfg.model)

        if data_config.rlds_data_dir is not None:
            loader, nbatches = create_rlds_dataloader(
                data_config, cfg.model.action_horizon, cfg.batch_size, per_repo_limits
            )
            print("  (RLDS)")
        else:
            loader, nbatches = create_torch_dataloader(
                data_config,
                cfg.model.action_horizon,
                cfg.batch_size,
                cfg.model,
                cfg.num_workers,
                per_repo_limits,
            )

        desc = f"pooling {rid}"
        for batch in tqdm.tqdm(loader, total=nbatches, desc=desc):
            for key in keys:
                arr = np.asarray(batch[key])
                pooled_stats[key].update(arr)
                total_samples += arr.shape[0] if arr.ndim > 1 else 1

            if max_frames is not None and total_samples >= max_frames:
                print(f"  Reached global --max-frames={max_frames}, stopping.")
                break

        if max_frames is not None and total_samples >= max_frames:
            break

    norm_stats = {key: st.get_statistics() for key, st in pooled_stats.items()}

    output_path = assets_dirs / asset_id
    print(f"\nWriting **pooled** stats to: {output_path}")
    print(f"  Total samples processed across all repos: {total_samples}")
    normalize.save(output_path, norm_stats)
    print("Done. You can now use this asset_id for training/inference for better stability.")


if __name__ == "__main__":
    tyro.cli(main)
