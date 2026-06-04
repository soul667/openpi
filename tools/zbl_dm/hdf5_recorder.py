"""LeRobot-style HDF5 recorder for pi0.5 ZMQ inference samples."""

from __future__ import annotations

import pathlib
import time

import numpy as np


class LeRobotHdf5Recorder:
    """Append inference samples to a LeRobot-style HDF5 episode file."""

    def __init__(self, path: str | pathlib.Path, *, episode_index: int = 0) -> None:
        try:
            import h5py
        except ImportError as exc:
            raise RuntimeError("HDF5 recording requires h5py. Install it with: pip install h5py") from exc

        self._h5py = h5py
        self.path = pathlib.Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.episode_index = int(episode_index)
        self._file = h5py.File(self.path, "a")
        self._init_attrs()

    def _init_attrs(self) -> None:
        self._file.attrs.setdefault("schema", "lerobot_inference_v1")
        self._file.attrs.setdefault("action_source", "raw_model_actions")
        self._file.attrs.setdefault("action_units", "rad_plus_gripper")
        self._file.attrs.setdefault("created_at", time.time())

    def __len__(self) -> int:
        if "frame_index" not in self._file:
            return 0
        return int(self._file["frame_index"].shape[0])

    def append(
        self,
        *,
        prompt: str,
        image: np.ndarray,
        state: np.ndarray,
        action: np.ndarray,
        timestamp: float | None = None,
    ) -> int:
        image = self._as_image(image)
        state = self._as_float_array(state, "state")
        action = self._as_float_array(action, "action")
        if action.ndim != 2:
            raise ValueError(f"action must have shape [chunk_size, action_dim], got {action.shape}")

        row = len(self)
        self._ensure_datasets(image_shape=image.shape, state_dim=state.shape[0], action_shape=action.shape)
        self._append_array("observation/image", image)
        self._append_array("observation/state", state)
        self._append_array("action", action)
        self._append_scalar("task", str(prompt))
        self._append_scalar("timestamp", float(time.time() if timestamp is None else timestamp))
        self._append_scalar("frame_index", row)
        self._append_scalar("episode_index", self.episode_index)
        self._append_scalar("index", row)
        self._file.flush()
        return row

    def close(self) -> None:
        self._file.close()

    def _ensure_datasets(self, *, image_shape: tuple[int, ...], state_dim: int, action_shape: tuple[int, ...]) -> None:
        self._ensure_group("observation")
        self._ensure_array_dataset("observation/image", image_shape, np.uint8, chunks=(1, *image_shape))
        self._ensure_array_dataset("observation/state", (state_dim,), np.float32, chunks=(1, state_dim))
        self._ensure_array_dataset("action", action_shape, np.float32, chunks=(1, *action_shape))

        string_dtype = self._h5py.string_dtype(encoding="utf-8")
        self._ensure_scalar_dataset("task", string_dtype)
        self._ensure_scalar_dataset("timestamp", np.float64)
        self._ensure_scalar_dataset("frame_index", np.int64)
        self._ensure_scalar_dataset("episode_index", np.int64)
        self._ensure_scalar_dataset("index", np.int64)

    def _ensure_group(self, name: str) -> None:
        if name not in self._file:
            self._file.create_group(name)

    def _ensure_array_dataset(
        self,
        name: str,
        sample_shape: tuple[int, ...],
        dtype: np.dtype | type,
        *,
        chunks: tuple[int, ...],
    ) -> None:
        if name in self._file:
            dataset = self._file[name]
            expected_shape = sample_shape
            if dataset.shape[1:] != expected_shape:
                raise ValueError(f"dataset {name} has sample shape {dataset.shape[1:]}, expected {expected_shape}")
            return
        self._file.create_dataset(
            name,
            shape=(0, *sample_shape),
            maxshape=(None, *sample_shape),
            dtype=dtype,
            chunks=chunks,
        )

    def _ensure_scalar_dataset(self, name: str, dtype: np.dtype | type) -> None:
        if name in self._file:
            return
        self._file.create_dataset(name, shape=(0,), maxshape=(None,), dtype=dtype, chunks=(1,))

    def _append_array(self, name: str, value: np.ndarray) -> None:
        dataset = self._file[name]
        row = dataset.shape[0]
        dataset.resize(row + 1, axis=0)
        dataset[row] = value

    def _append_scalar(self, name: str, value: object) -> None:
        dataset = self._file[name]
        row = dataset.shape[0]
        dataset.resize(row + 1, axis=0)
        dataset[row] = value

    @staticmethod
    def _as_image(value: np.ndarray) -> np.ndarray:
        image = np.asarray(value)
        if image.ndim != 3 or image.shape[-1] != 3:
            raise ValueError(f"image must have shape [H, W, 3], got {image.shape}")
        return np.ascontiguousarray(image.astype(np.uint8, copy=False))

    @staticmethod
    def _as_float_array(value: np.ndarray, name: str) -> np.ndarray:
        array = np.asarray(value, dtype=np.float32)
        if not np.isfinite(array).all():
            raise ValueError(f"{name} contains non-finite values")
        return np.ascontiguousarray(array)
