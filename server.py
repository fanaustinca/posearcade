"""Pose Arcade server: receives JPEG camera frames over WebSocket, runs
YOLO pose on the GB10, and streams back body keypoints.

Wire format (client -> server, binary):
    8 bytes  float64 little-endian client timestamp (performance.now() ms)
    rest     JPEG bytes
Server -> client (text JSON):
    {"t": <echoed ts>, "w": W, "h": H, "ms": infer_ms, "people": [
        {"score": s, "box": [x1,y1,x2,y2], "kp": [[x,y,conf] * 17]}]}
Coordinates are normalized to 0..1 in the (unmirrored) camera image.
"""
import asyncio
import json
import os
import struct
import subprocess
import threading
import time
from pathlib import Path

import cv2
import numpy as np
import torch
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from ultralytics import YOLO

ROOT = Path(__file__).parent
WEB = ROOT / "web"
MODEL_NAME = os.environ.get("POSE_MODEL", "yolo11l-pose.pt")
IMGSZ = int(os.environ.get("POSE_IMGSZ", "640"))
PORT = int(os.environ.get("PORT", "8600"))

device = "cuda" if torch.cuda.is_available() else "cpu"
model = YOLO(str(ROOT / "models" / MODEL_NAME) if (ROOT / "models" / MODEL_NAME).exists() else MODEL_NAME)
model.to(device)
gpu_lock = threading.Lock()  # one inference at a time across all clients


def infer(jpeg: bytes):
    img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return None
    h, w = img.shape[:2]
    t0 = time.perf_counter()
    with gpu_lock:
        res = model.predict(img, imgsz=IMGSZ, conf=0.35, quantize=16 if device == "cuda" else None,
                            device=device, verbose=False, max_det=4)[0]
    ms = (time.perf_counter() - t0) * 1000
    people = []
    if res.keypoints is not None and len(res.boxes):
        kxy = res.keypoints.xy.cpu().numpy()
        kc = res.keypoints.conf.cpu().numpy() if res.keypoints.conf is not None else np.ones(kxy.shape[:2])
        boxes = res.boxes.xyxy.cpu().numpy()
        scores = res.boxes.conf.cpu().numpy()
        for i in range(len(boxes)):
            kp = [[round(float(x) / w, 4), round(float(y) / h, 4), round(float(c), 3)]
                  for (x, y), c in zip(kxy[i], kc[i])]
            b = boxes[i]
            people.append({"score": round(float(scores[i]), 3),
                           "box": [round(float(b[0]) / w, 4), round(float(b[1]) / h, 4),
                                   round(float(b[2]) / w, 4), round(float(b[3]) / h, 4)],
                           "kp": kp})
        # largest person first: that's the player
        people.sort(key=lambda p: -(p["box"][2] - p["box"][0]) * (p["box"][3] - p["box"][1]))
    return {"w": w, "h": h, "ms": round(ms, 1), "people": people}


# Warm up so the first real frame isn't slow (cudnn autotune, half-cast).
_, _warm = cv2.imencode(".jpg", np.zeros((360, 640, 3), np.uint8))
for _ in range(3):
    infer(_warm.tobytes())

app = FastAPI()


@app.get("/")
def index():
    return FileResponse(WEB / "index.html")


@app.get("/api/info")
def info():
    return JSONResponse({"model": MODEL_NAME, "imgsz": IMGSZ, "device": device,
                         "gpu": torch.cuda.get_device_name(0) if device == "cuda" else None})


@app.websocket("/ws")
async def ws_pose(ws: WebSocket):
    await ws.accept()
    latest = {"frame": None}
    have_frame = asyncio.Event()
    closed = False

    async def worker():
        while not closed:
            await have_frame.wait()
            have_frame.clear()
            frame, latest["frame"] = latest["frame"], None
            if frame is None:
                continue
            ts, jpeg = frame
            out = await asyncio.to_thread(infer, jpeg)
            if out is None:
                continue
            out["t"] = ts
            try:
                await ws.send_text(json.dumps(out, separators=(",", ":")))
            except Exception:
                return

    task = asyncio.create_task(worker())
    try:
        while True:
            msg = await ws.receive_bytes()
            if len(msg) < 9:
                continue
            (ts,) = struct.unpack("<d", msg[:8])
            # Only the newest frame matters; older unprocessed ones are dropped.
            latest["frame"] = (ts, msg[8:])
            have_frame.set()
    except WebSocketDisconnect:
        pass
    finally:
        closed = True
        have_frame.set()
        task.cancel()


app.mount("/", StaticFiles(directory=WEB), name="web")


def ensure_cert():
    cert, key = ROOT / "certs" / "cert.pem", ROOT / "certs" / "key.pem"
    if not cert.exists():
        cert.parent.mkdir(exist_ok=True)
        ips = subprocess.run(["hostname", "-I"], capture_output=True, text=True).stdout.split()
        san = ",".join(["DNS:localhost", "DNS:" + os.uname().nodename, "DNS:" + os.uname().nodename + ".local"]
                       + ["IP:" + ip for ip in ips if ":" not in ip] + ["IP:127.0.0.1"])
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650",
                        "-keyout", str(key), "-out", str(cert), "-subj", "/CN=posearcade",
                        "-addext", f"subjectAltName={san}"],
                       check=True, capture_output=True)
    return str(cert), str(key)


if __name__ == "__main__":
    cert, key = ensure_cert()
    print(f"Pose Arcade on https://0.0.0.0:{PORT}  model={MODEL_NAME} imgsz={IMGSZ} device={device}", flush=True)
    uvicorn.run(app, host="0.0.0.0", port=PORT, ssl_certfile=cert, ssl_keyfile=key,
                ws_max_size=4 * 1024 * 1024, log_level="warning")
