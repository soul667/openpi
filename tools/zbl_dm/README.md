# infer_server

Server-side ZMQ endpoints for MTBot VLA inference.

This directory is intended to live on the inference server, for example
`10.16.118.8`. It receives compact robot observations from the robot-side bridge
and replies with an action chunk.

## Environment

Create a conda environment for pi0.5 inference:

```bash
conda create -n pi05-infer python=3.11 -y
conda activate pi05-infer
cd /home/mtbot/project/infer_server
pip install -r requirements.txt
```

The dependency list is trimmed for inference. It does not include training,
dataset conversion, RLDS/TensorFlow, wandb, notebooks, or test tooling.

## Run pi0.5

```bash
cd /home/mtbot/project/infer_server
./run_pi05_server.sh \
  --bind tcp://0.0.0.0:5555 \
  --config-name pi05_mtbot \
  --checkpoint-dir /data2/axgu/code/openpi/checkpoints/pi05_mtbot/mtbot/9999 \
  --prompt "move to the target" \
  --chunk-size 1 \
  --max-joint-step-deg 2.0
```

The real server loads local OpenPI from `./openpi/src` and uses
`openpi/src/openpi/training/config.py:pi05_mtbot`.

First startup can take a couple of minutes while Orbax restores the 25GiB JAX
checkpoint. It may also download and cache `paligemma_tokenizer.model` under
`~/.cache/openpi`.

Model input mapping:

- `joints_deg` from the robot request becomes the first 6 values of
  `observation/state`.
- `gripper` becomes state value 8, with state value 7 padded as `0`.
- The request must include an RGB image under one of `image`, `base_rgb`,
  `rgb`, `camera`, or `observation/image`.
- `prompt` can be sent per request, otherwise `--prompt` is used.

For a smoke test without camera data, add `--missing-image zeros`. This only
checks the inference/transport path; real VLA behavior needs a real image.

The model predicts a 10-step horizon for `pi05_mtbot`. The server returns
`--chunk-size` clamped absolute joint targets per request; the default is `1`
for first-pass safety. To let the robot bridge execute several steps from one
inference, start the server with a larger `--chunk-size` and start the robot
bridge with matching `--max-chunk-steps`.

```python
{
    "type": "action_chunk",
    "action_space": "joint_degrees",
    "actions": [
        {"joints_deg": [j1, j2, j3, j4, j5, j6], "gripper": 20},
        {"joints_deg": [j1, j2, j3, j4, j5, j6], "gripper": 20},
    ],
}
```

## Run Mock

```bash
cd /home/mtbot/project/infer_server
./run_mock_server.sh --bind tcp://0.0.0.0:5555 --mode hold
```

Useful mock modes:

- `hold`: return the current joints, safest for first test.
- `joint_demo`: add a tiny demo delta to joint 6.
- `gripper_demo`: toggle gripper target.
- `ee_demo`: return an EE delta.

## Action Chunk Format

The server replies with a pickled dictionary:

```python
{
    "type": "action_chunk",
    "action_space": "joint_degrees",
    "actions": [
        {"joints_deg": [0, 0, 90, 0, 90, 0], "gripper": 50}
    ],
}
```

Supported first-pass action spaces:

- `joint_degrees`
- `gripper`
- `ee_delta_mm_deg`
