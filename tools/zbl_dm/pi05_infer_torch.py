"""PyTorch pi0.5 MTBot inference backend."""

from __future__ import annotations

import logging
import dataclasses

import torch

from pi05_infer import OPENPI_SRC, Pi05PolicyBase, format_bytes
from openpi.policies import policy_config as _policy_config

LOGGER = logging.getLogger("pi05_infer_torch")


@dataclasses.dataclass
class Pi05TorchPolicy(Pi05PolicyBase):
    def __post_init__(self) -> None:
        LOGGER.info("Using local openpi source: %s", OPENPI_SRC)
        self._load_config()
        self.policy = _policy_config.create_trained_policy(
            self.config,
            self.checkpoint_dir,
            default_prompt=self.prompt,
            pytorch_device=self.pytorch_device,
        )
        if not getattr(self.policy, "_is_pytorch_model", False):
            raise RuntimeError(
                "pi05_infer_torch.py requires a PyTorch checkpoint directory containing "
                "model.safetensors. Convert the JAX checkpoint first with "
                "openpi/examples/convert_jax_model_to_pytorch.py and pass that converted "
                "directory as --checkpoint-dir."
            )
        self._log_config_summary(LOGGER)
        self._log_model_device_summary()

    def _log_model_device_summary(self) -> None:
        LOGGER.info("PyTorch version=%s cuda_available=%s", torch.__version__, torch.cuda.is_available())
        if torch.cuda.is_available():
            devices = [
                {
                    "index": idx,
                    "name": torch.cuda.get_device_name(idx),
                    "capability": torch.cuda.get_device_capability(idx),
                }
                for idx in range(torch.cuda.device_count())
            ]
            LOGGER.info("PyTorch CUDA devices=%s", devices)

        model = getattr(self.policy, "_model", None)
        device = getattr(self.policy, "_pytorch_device", None)
        LOGGER.info("Policy is PyTorch; pytorch_device=%s", device)
        if model is None:
            return

        try:
            total_params = sum(parameter.numel() for parameter in model.parameters())
            total_bytes = sum(parameter.numel() * parameter.element_size() for parameter in model.parameters())
            device_counts: dict[str, int] = {}
            dtype_counts: dict[str, int] = {}
            for parameter in model.parameters():
                device_name = str(parameter.device)
                dtype_name = str(parameter.dtype)
                device_counts[device_name] = device_counts.get(device_name, 0) + parameter.numel()
                dtype_counts[dtype_name] = dtype_counts.get(dtype_name, 0) + parameter.numel()
            LOGGER.info(
                "Model params total=%d bytes=%s devices=%s dtypes=%s",
                total_params,
                format_bytes(total_bytes),
                device_counts,
                dtype_counts,
            )
        except Exception:
            LOGGER.exception("Could not summarize PyTorch model device placement")
