# Robot VLA ZMQ Interface

This is the server-side protocol expected by:

- Robot bridge: `/home/mtbot/project/infer/robot_zmq_bridge.py`
- Mock server reference: `/home/mtbot/project/infer_server/mock_vla_server.py`

## Transport

- Pattern: ZeroMQ `REQ` / `REP`
- Robot side: `REQ`, connects to server
- Server side: `REP`, binds to an address such as `tcp://0.0.0.0:5555`
- Serialization: Python `pickle`
- Every request must receive exactly one reply. If the server does not reply,
  the robot bridge times out and resets its socket.

Robot bridge default endpoint:

```bash
tcp://10.16.118.8:5555
```

Robot bridge default timeout:

```bash
--timeout-s 2.0
```

If model inference takes longer, either lower the bridge rate or start the bridge
with a larger `--timeout-s`.

## Startup Ping

Robot sends this once at startup:

```python
{
    "type": "ping",
    "request_id": "startup",
}
```

Server should reply:

```python
{
    "type": "pong",
    "server_time": time.time(),
}
```

## Inference Request

After robot state is available, the bridge sends:

```python
{
    "type": "infer_request",
    "request_id": 0,
    "observation": {
        "stamp": 1779116000.123,
        "joints_deg": [j1, j2, j3, j4, j5, j6],
        "cart_mm_deg": [x, y, z, a, b, c],
        "gripper": 20,
        "emg": False,
        "motion_done": 1,
        "mc_queue_len": 0,
    },
}
```

Field notes:

- `joints_deg`: six current joint angles, degrees.
- `cart_mm_deg`: current TCP pose. `x/y/z` are millimeters, `a/b/c` are degrees.
- `gripper`: integer, usually `0..100`. In current tests, `20` is close-ish and
  `80`/`100` is open-ish.
- `emg`: emergency stop flag. The bridge skips inference if this is true.
- `motion_done`: controller motion-done flag from ROS state.
- `mc_queue_len`: controller motion queue length from ROS state.

## Normal Response

Server returns one action chunk:

```python
{
    "type": "action_chunk",
    "action_space": "joint_degrees",
    "actions": [
        {"joints_deg": [-18.7, -82.6, 89.9, -104.3, -85.6, 69.8]},
    ],
    "created_at": time.time(),
}
```

The bridge currently executes only the first `--max-chunk-steps` actions from
the list. Default is `1`, so start by returning one action per request.

## Error Response

Server may return:

```python
{
    "type": "error",
    "message": "reason",
    "created_at": time.time(),
}
```

The bridge logs the error and does not execute an action.

## Supported Action Spaces

### 1. Absolute Joint Target

```python
{
    "type": "action_chunk",
    "action_space": "joint_degrees",
    "actions": [
        {
            "joints_deg": [j1, j2, j3, j4, j5, j6],
            "gripper": 20,  # optional
        }
    ],
    "created_at": time.time(),
}
```

Robot-side execution:

```text
JNTPoint(point_id, j1, j2, j3, j4, j5, j6)
MoveJ(JNTpoint_id, movej_speed, tool, user)
```

Defaults:

- `point_id = 1`
- `movej_speed = 20`
- `tool = 0`
- `user = 0`

This is the most stable first integration target because it was tested directly
with all six joints.

### 2. Relative EE Delta

```python
{
    "type": "action_chunk",
    "action_space": "ee_delta_mm_deg",
    "actions": [
        {
            "ee_delta_mm_deg": [dx, dy, dz, da, db, dc],
            "gripper": 20,  # optional
        }
    ],
    "created_at": time.time(),
}
```

Units:

- `dx/dy/dz`: millimeters
- `da/db/dc`: degrees

Robot-side behavior:

```python
target_cart = current_cart_mm_deg + ee_delta_mm_deg
```

Then the bridge sends:

```text
CARTPoint(cart_point_id, x, y, z, a, b, c)
MoveL(CARTcart_point_id, cart_speed, tool, user)
```

Defaults:

- `cart_point_id = 1`
- `cart_speed = 20`
- `tool = 0`
- `user = 0`
- `ee_mode = movel`

Important: if the server returns the same nonzero delta every tick, the robot
will keep walking in that direction. Return small deltas and use a low bridge
rate at first.

### 3. Absolute EE Pose

```python
{
    "type": "action_chunk",
    "action_space": "ee_pose_mm_deg",
    "actions": [
        {
            "ee_pose_mm_deg": [x, y, z, a, b, c],
            "gripper": 20,  # optional
        }
    ],
    "created_at": time.time(),
}
```

Units are the same as `cart_mm_deg`.

### 4. Gripper Only

```python
{
    "type": "action_chunk",
    "action_space": "gripper",
    "actions": [
        {"gripper": 20}
    ],
    "created_at": time.time(),
}
```

Robot-side execution:

```text
MoveGripper(gripper_index, position, speed, force, timeout_ms, block)
```

Defaults:

- `gripper_index = 1`
- `gripper_speed = 100`
- `gripper_force = 50`
- `gripper_timeout_ms = 5000`
- `gripper_block = 0`

## Minimal Server Template

```python
#!/usr/bin/env python3
import pickle
import time

import zmq


def build_action(request):
    if request.get("type") == "ping":
        return {"type": "pong", "server_time": time.time()}

    obs = request["observation"]

    # Hold current joint pose by default.
    joints = list(obs["joints_deg"])

    # Example: tiny joint-6 target offset.
    # For real VLA output, replace this with model inference.
    joints[5] += 1.0

    return {
        "type": "action_chunk",
        "action_space": "joint_degrees",
        "actions": [
            {
                "joints_deg": joints,
                "gripper": obs.get("gripper", 20),
            }
        ],
        "created_at": time.time(),
    }


def main():
    context = zmq.Context()
    socket = context.socket(zmq.REP)
    socket.setsockopt(zmq.LINGER, 0)
    socket.bind("tcp://0.0.0.0:5555")
    print("listening on tcp://0.0.0.0:5555", flush=True)

    while True:
        request = pickle.loads(socket.recv())
        try:
            response = build_action(request)
        except Exception as exc:
            response = {
                "type": "error",
                "message": str(exc),
                "created_at": time.time(),
            }
        socket.send(pickle.dumps(response))


if __name__ == "__main__":
    main()
```

## First Real Model Recommendation

Start with `joint_degrees`.

For the first integration, have the server:

1. Read `obs["joints_deg"]`.
2. Run model inference.
3. Convert model output to one absolute six-joint target in degrees.
4. Clamp per-step movement, for example no more than `1..3` degrees from the
   current observed joint position.
5. Return exactly one action in `actions`.

Robot-side command:

```bash
cd /home/mtbot/project/infer
./run_robot_bridge.sh \
  --server tcp://10.16.118.8:5555 \
  --rate-hz 0.5 \
  --action-filter joint \
  --max-chunk-steps 1 \
  --execute
```

When `--execute` is used, the robot bridge now sends these two startup commands
before it begins inference requests:

```text
ServoMoveEnd(0)
MotionQueueClear()
```

This matches the direct `test_robot_actions.py` path that was verified on the
robot. Pass `--no-startup-clear` only if you intentionally want to skip that.

For EE delta testing:

```bash
cd /home/mtbot/project/infer
./run_robot_bridge.sh \
  --server tcp://10.16.118.8:5555 \
  --rate-hz 0.5 \
  --action-filter ee \
  --ee-mode movel \
  --max-chunk-steps 1 \
  --execute
```
