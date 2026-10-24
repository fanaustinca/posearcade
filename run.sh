#!/usr/bin/env bash
# Start the Pose Arcade server (HTTPS on port 8600 by default).
# Override with: POSE_MODEL=yolo11m-pose.pt POSE_IMGSZ=480 PORT=8600 ./run.sh
cd "$(dirname "$0")"
PY="${PYTHON:-python}"
exec "$PY" server.py
