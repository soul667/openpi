"""Shared utilities and JAX pi0.5 MTBot inference backend."""

from __future__ import annotations

import dataclasses
import json
import logging
import pathlib
import sys
import time
from typing import Any

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent
OPENPI_SRC = ROOT / "openpi" / "src"
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(OPENPI_SRC))

from hdf5_recorder import LeRobotHdf5Recorder  # noqa: E402
from openpi.policies import policy_config as _policy_config  # noqa: E402
from openpi.training import config as _config  # noqa: E402

LOGGER = logging.getLogger("pi05_infer")


def format_bytes(num_bytes: int) -> str:
    value = float(num_bytes)
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if value < 1024.0 or unit == "TiB":
            return f"{value:.2f} {unit}"
        value /= 1024.0
    return f"{value:.2f} TiB"


def float_list(value: Any, length: int, name: str) -> list[float]:
    if not isinstance(value, (list, tuple, np.ndarray)) or len(value) != length:
        raise ValueError(f"observation.{name} must be a length-{length} sequence")
    try:
        values = [float(v) for v in value]
    except (TypeError, ValueError) as exc:
        raise ValueError(f"observation.{name} must contain numbers") from exc
    if not np.isfinite(values).all():
        raise ValueError(f"observation.{name} contains non-finite values")
    return values


def parse_image(image: Any) -> np.ndarray:
    image = np.asarray(image)
    if image.ndim == 2:
        image = np.repeat(image[..., None], 3, axis=-1)
    if image.ndim == 3 and image.shape[0] == 3 and image.shape[-1] != 3:
        image = np.transpose(image, (1, 2, 0))
    if image.ndim != 3 or image.shape[-1] != 3:
        raise ValueError("image must have shape HxWx3, 3xHxW, or HxW")
    if not np.isfinite(image).all():
        raise ValueError("image contains non-finite values")
    if np.issubdtype(image.dtype, np.floating):
        max_value = float(np.nanmax(image)) if image.size else 0.0
        if max_value <= 1.0:
            image = image * 255.0
    image = np.clip(image, 0, 255).astype(np.uint8)
    return np.ascontiguousarray(image)


def get_first_present(mapping: dict[str, Any], keys: tuple[str, ...]) -> Any | None:
    for key in keys:
        if key in mapping:
            return mapping[key]
    return None


def clamp_joint_step(target: np.ndarray, current: np.ndarray, max_step_deg: float) -> np.ndarray:
    if max_step_deg <= 0:
        return target
    delta = np.clip(target - current, -max_step_deg, max_step_deg)
    return current + delta


def gripper_from_action(value: float, closed_pos: int, open_pos: int) -> int:
    del closed_pos, open_pos
    return int(round(float(np.clip(value, 0, 100))))


def _array_nbytes(value: Any) -> int:
    nbytes = getattr(value, "nbytes", None)
    if nbytes is not None:
        return int(nbytes)
    size = getattr(value, "size", None)
    dtype = getattr(value, "dtype", None)
    itemsize = getattr(dtype, "itemsize", None)
    if size is None or itemsize is None:
        return 0
    return int(size) * int(itemsize)


def _array_devices(value: Any) -> list[str]:
    devices_fn = getattr(value, "devices", None)
    if callable(devices_fn):
        return sorted(str(device) for device in devices_fn())
    device = getattr(value, "device", None)
    if device is not None:
        return [str(device)]
    return ["host"]


@dataclasses.dataclass
class Pi05PolicyBase:
    config_name: str
    checkpoint_dir: str
    prompt: str
    action_index: int
    chunk_size: int
    max_joint_step_deg: float
    missing_image: str
    dummy_image_size: tuple[int, int]
    include_gripper: bool
    gripper_closed: int
    gripper_open: int
    pytorch_device: str | None
    repo_id: str | None
    record_hdf5: str | None
    log_actions: bool

    def _load_config(self) -> None:
        self.config = _config.get_config(self.config_name)
        if self.repo_id is not None:
            self.config = dataclasses.replace(
                self.config,
                data=dataclasses.replace(self.config.data, repo_id=self.repo_id),
            )
        self.dataset_state_dim = 8
        self.dataset_action_dim = 8
        self.recorder = LeRobotHdf5Recorder(self.record_hdf5) if self.record_hdf5 else None
        self._logged_missing_image = False

    def close(self) -> None:
        if self.recorder is not None:
            self.recorder.close()

    def _load_norm_stat_dims(self, asset_id: str | None) -> None:
        if not asset_id:
            return

        norm_stats_path = pathlib.Path(self.checkpoint_dir) / "assets" / asset_id / "norm_stats.json"
        try:
            with norm_stats_path.open("r", encoding="utf-8") as f:
                norm_stats = json.load(f)["norm_stats"]
            self.dataset_state_dim = len(norm_stats["state"]["mean"])
            self.dataset_action_dim = len(norm_stats["actions"]["mean"])
        except Exception:
            LOGGER.exception("Could not read norm stat dims from %s", norm_stats_path)
            return

        LOGGER.info(
            "Dataset dims from norm stats: state_dim=%d action_dim=%d path=%s",
            self.dataset_state_dim,
            self.dataset_action_dim,
            norm_stats_path,
        )

    def _data_asset_id(self) -> str | None:
        assets = getattr(self.config.data, "assets", None)
        asset_id = getattr(assets, "asset_id", None)
        if asset_id:
            return str(asset_id)
        repo_id = getattr(self.config.data, "repo_id", None)
        return str(repo_id) if repo_id else None

    def _log_config_summary(self, logger: logging.Logger) -> None:
        model_dict = dataclasses.asdict(self.config.model)
        summary_keys = (
            "action_dim",
            "action_horizon",
            "max_token_len",
            "paligemma_variant",
            "action_expert_variant",
            "pi05",
            "discrete_state_input",
        )
        model_summary = {key: model_dict.get(key) for key in summary_keys}
        logger.info(
            "Loaded config=%s checkpoint=%s model=%s",
            self.config.name,
            self.checkpoint_dir,
            model_summary,
        )
        asset_id = self._data_asset_id()
        logger.info(
            "Data config repo_id=%s asset_id=%s checkpoint_assets=%s",
            getattr(self.config.data, "repo_id", None),
            asset_id,
            pathlib.Path(self.checkpoint_dir) / "assets" / asset_id if asset_id else None,
        )
        self._load_norm_stat_dims(asset_id)

    def _build_openpi_observation(self, robot_obs: dict[str, Any]) -> tuple[dict[str, Any], list[float], int]:
        joints_deg = float_list(robot_obs.get("joints_deg"), 6, "joints_deg")
        gripper = int(robot_obs.get("gripper", self.gripper_open))

        joints_rad = np.deg2rad(np.asarray(joints_deg, dtype=np.float32))
        if self.dataset_state_dim == 6:
            state = joints_rad
        elif self.dataset_state_dim == 7:
            state = np.asarray([*joints_rad, float(gripper)], dtype=np.float32)
        elif self.dataset_state_dim == 8:
            state = np.asarray([*joints_rad, 0.0, float(gripper)], dtype=np.float32)
        else:
            raise ValueError(f"unsupported dataset state dim: {self.dataset_state_dim}")
        if not np.isfinite(state).all():
            raise ValueError("constructed observation/state contains non-finite values")

        image_value = get_first_present(
            robot_obs,
            (
                "observation/image",
                "image",
                "base_rgb",
                "rgb",
                "camera",
            ),
        )
        if image_value is None:
            if self.missing_image == "error":
                raise ValueError(
                    "robot observation has no image. Send one of: image, base_rgb, rgb, camera, observation/image"
                )
            height, width = self.dummy_image_size
            image = np.zeros((height, width, 3), dtype=np.uint8)
            if not self._logged_missing_image:
                LOGGER.warning("No image in requests; using black %sx%s dummy image", width, height)
                self._logged_missing_image = True
        else:
            image = parse_image(image_value)

        prompt = str(robot_obs.get("prompt") or self.prompt)
        openpi_obs = {
            "observation/state": state,
            "observation/image": image,
            "prompt": prompt,
        }
        return openpi_obs, joints_deg, gripper

    def build_action(self, request: dict[str, Any]) -> dict[str, Any]:
        if request.get("type") == "ping":
            return {"type": "pong", "server_time": time.time()}
        if request.get("type") != "infer_request":
            raise ValueError(f"unsupported request type: {request.get('type')!r}")

        robot_obs = request.get("observation")
        if not isinstance(robot_obs, dict):
            raise ValueError("request.observation must be a dict")

        openpi_obs, joints_deg, current_gripper = self._build_openpi_observation(robot_obs)
        start_time = time.monotonic()
        result = self.policy.infer(openpi_obs)
        infer_ms = (time.monotonic() - start_time) * 1000.0

        actions = np.asarray(result["actions"], dtype=np.float32)
        if actions.ndim != 2 or actions.shape[1] < 6:
            raise ValueError(f"policy returned invalid actions shape: {actions.shape}")
        if not np.isfinite(actions).all():
            raise ValueError("policy returned non-finite actions")

        action_index = min(max(self.action_index, 0), actions.shape[0] - 1)
        chunk_size = max(1, self.chunk_size)
        end_index = min(action_index + chunk_size, actions.shape[0])
        raw_chunk = actions[action_index:end_index]

        chunk: list[dict[str, Any]] = []
        previous_target = np.asarray(joints_deg, dtype=np.float32)
        gripper_index = self.dataset_action_dim - 1 if self.dataset_action_dim > 6 else None
        for raw_action in raw_chunk:
            target_deg = np.rad2deg(raw_action[:6].astype(np.float32))
            target = clamp_joint_step(
                target_deg,
                previous_target,
                self.max_joint_step_deg,
            )
            action: dict[str, Any] = {"joints_deg": [float(v) for v in target]}
            if self.include_gripper:
                action["gripper"] = (
                    gripper_from_action(float(raw_action[gripper_index]), self.gripper_closed, self.gripper_open)
                    if gripper_index is not None and raw_action.shape[0] > gripper_index
                    else current_gripper
                )
            chunk.append(action)
            previous_target = target

        if self.log_actions:
            request_id = request.get("request_id", "?")
            final_rows = [
                [*action["joints_deg"], action.get("gripper", np.nan)]
                for action in chunk
            ]
            raw_cols = min(max(self.dataset_action_dim, 7), raw_chunk.shape[1])
            LOGGER.info(
                "request_id=%s final_action_chunk joint_deg+gripper shape=%s values=\n%s",
                request_id,
                np.asarray(final_rows, dtype=np.float32).shape,
                np.array2string(np.asarray(final_rows, dtype=np.float32), precision=4, suppress_small=False),
            )
            LOGGER.info(
                "request_id=%s raw_model_actions rad+gripper shape=%s values=\n%s",
                request_id,
                raw_chunk[:, :raw_cols].shape,
                np.array2string(raw_chunk[:, :raw_cols], precision=4, suppress_small=False),
            )

        if self.recorder is not None:
            self.recorder.append(
                prompt=str(openpi_obs["prompt"]),
                image=np.asarray(openpi_obs["observation/image"]),
                state=np.asarray(openpi_obs["observation/state"]),
                action=raw_chunk,
                timestamp=time.time(),
            )

        return {
            "type": "action_chunk",
            "action_space": "joint_degrees",
            "actions": chunk,
            "created_at": time.time(),
            "policy_timing": {
                "infer_ms": infer_ms,
                "model_infer_ms": result.get("policy_timing", {}).get("infer_ms"),
            },
            "debug": {
                "raw_actions": [
                    [float(v) for v in raw_action[: min(8, raw_action.shape[0])]] for raw_action in raw_chunk
                ],
                "action_index": action_index,
                "chunk_size": len(chunk),
            },
        }


@dataclasses.dataclass
class Pi05Policy(Pi05PolicyBase):
    def __post_init__(self) -> None:
        LOGGER.info("Using local openpi source: %s", OPENPI_SRC)
        self._load_config()
        self.policy = _policy_config.create_trained_policy(
            self.config,
            self.checkpoint_dir,
            default_prompt=self.prompt,
            pytorch_device=self.pytorch_device,
        )
        self._log_config_summary(LOGGER)
        self._log_model_device_summary()

    def _log_model_device_summary(self) -> None:
        import flax.nnx as nnx
        import jax

        LOGGER.info("JAX backend=%s devices=%s", jax.default_backend(), jax.devices())
        if getattr(self.policy, "is_pytorch", False):
            LOGGER.info("Policy is PyTorch; pytorch_device=%s", getattr(self.policy, "_pytorch_device", None))
            return

        try:
            _, state = nnx.split(self.policy._model)  # noqa: SLF001
            params = state.to_pure_dict()
            leaves = jax.tree.leaves(params)
            total_bytes = sum(_array_nbytes(leaf) for leaf in leaves)
            device_counts: dict[str, int] = {}
            for leaf in leaves:
                for device in _array_devices(leaf):
                    device_counts[device] = device_counts.get(device, 0) + 1
            LOGGER.info(
                "Model params leaves=%d total=%s devices=%s",
                len(leaves),
                format_bytes(total_bytes),
                device_counts,
            )
            for idx, leaf in enumerate(leaves[:3]):
                LOGGER.info(
                    "Param sample %d: shape=%s dtype=%s sharding=%s devices=%s",
                    idx,
                    getattr(leaf, "shape", None),
                    getattr(leaf, "dtype", None),
                    getattr(leaf, "sharding", None),
                    _array_devices(leaf),
                )
        except Exception:
            LOGGER.exception("Could not summarize model device placement")
