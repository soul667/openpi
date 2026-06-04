#!/usr/bin/env python3
"""pi0.5 MTBot ZMQ inference server for the robot-side ZMQ bridge."""

from __future__ import annotations

import argparse
import logging
import os
import pickle
import sys
import time
from typing import Any, Literal

import zmq

LOGGER = logging.getLogger("pi05_zmq_server")


def parse_size(value: str) -> tuple[int, int]:
    try:
        height_s, width_s = value.lower().split("x", 1)
        height, width = int(height_s), int(width_s)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("expected HxW, for example 224x224") from exc
    if height <= 0 or width <= 0:
        raise argparse.ArgumentTypeError("image size must be positive")
    return height, width


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", choices=("jax", "torch"), default="jax")
    parser.add_argument("--bind", default="tcp://0.0.0.0:5555")
    parser.add_argument("--config-name", default="pi05_mtbot")
    parser.add_argument(
        "--checkpoint-dir",
        required=True,
        help="OpenPI checkpoint directory, e.g. checkpoints/pi05_mtbot/exp/10000 or gs://...",
    )
    parser.add_argument("--prompt", required=True, help="Default language instruction for pi0.5")
    parser.add_argument("--action-index", type=int, default=0)
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=1,
        help="Number of model actions to return in each ZMQ action_chunk. pi05_mtbot horizon is 10.",
    )
    parser.add_argument("--max-joint-step-deg", type=float, default=2.0)
    parser.add_argument("--missing-image", choices=("error", "zeros"), default="error")
    parser.add_argument("--dummy-image-size", type=parse_size, default=(224, 224), metavar="HxW")
    parser.add_argument("--no-gripper", action="store_true", help="Do not include gripper in joint action replies")
    parser.add_argument("--gripper-closed", type=int, default=20)
    parser.add_argument("--gripper-open", type=int, default=80)
    parser.add_argument(
        "--pytorch-device",
        default=None,
        help="Device for PyTorch checkpoint inference, e.g. cpu, cuda, cuda:0. Default: cuda if available else cpu.",
    )
    parser.add_argument("--repo-id", default=None, help="Override the OpenPI data repo_id for the selected config")
    parser.add_argument(
        "--record-hdf5",
        default=None,
        help="Append LeRobot-style inference samples to this HDF5 file",
    )
    parser.add_argument("--no-log-actions", action="store_true", help="Do not print inferred action chunks")
    parser.add_argument("--log-level", default="INFO", choices=("DEBUG", "INFO", "WARNING", "ERROR"))
    return parser.parse_args()


def create_policy(args: argparse.Namespace) -> Any:
    policy_cls: Any
    backend: Literal["jax", "torch"] = args.backend
    if backend == "torch":
        from pi05_infer_torch import Pi05TorchPolicy

        policy_cls = Pi05TorchPolicy
    else:
        from pi05_infer import Pi05Policy

        policy_cls = Pi05Policy

    return policy_cls(
        config_name=args.config_name,
        checkpoint_dir=args.checkpoint_dir,
        prompt=args.prompt,
        action_index=args.action_index,
        chunk_size=args.chunk_size,
        max_joint_step_deg=args.max_joint_step_deg,
        missing_image=args.missing_image,
        dummy_image_size=args.dummy_image_size,
        include_gripper=not args.no_gripper,
        gripper_closed=args.gripper_closed,
        gripper_open=args.gripper_open,
        pytorch_device=args.pytorch_device,
        repo_id=args.repo_id,
        record_hdf5=args.record_hdf5,
        log_actions=not args.no_log_actions,
    )


def main() -> None:
    os.environ.setdefault("PYTHONUNBUFFERED", "1")
    args = parse_args()
    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        stream=sys.stdout,
        force=True,
    )

    policy = create_policy(args)
    context = zmq.Context()
    socket = context.socket(zmq.REP)
    socket.setsockopt(zmq.LINGER, 0)
    socket.bind(args.bind)
    endpoint = socket.getsockopt_string(zmq.LAST_ENDPOINT)
    LOGGER.info("Listening on %s (requested %s, backend=%s)", endpoint, args.bind, args.backend)

    try:
        while True:
            raw = socket.recv()
            request: dict[str, Any] = {}
            try:
                request = pickle.loads(raw)
                response = policy.build_action(request)
            except Exception as exc:
                LOGGER.exception("Request failed")
                response = {
                    "type": "error",
                    "message": str(exc),
                    "created_at": time.time(),
                }
            socket.send(pickle.dumps(response))
            LOGGER.info(
                "request_id=%s -> %s",
                request.get("request_id", "?") if isinstance(request, dict) else "?",
                response.get("action_space") or response.get("type"),
            )
    except KeyboardInterrupt:
        LOGGER.info("Stopped")
    finally:
        policy.close()
        socket.close(linger=0)
        context.term()


if __name__ == "__main__":
    main()
