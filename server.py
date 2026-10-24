"""Pose Arcade server: receives JPEG camera frames over WebSocket, runs
YOLO pose on the GB10, and streams back body keypoints.

Wire format (client -> server, binary):
    8 bytes  float64 little-endian client timestamp (performance.now() ms)
    rest     JPEG bytes
Client -> server (text JSON): {"hands": true|false} turns hand tracking on/off.
Server -> client (text JSON):
    {"t": <echoed ts>, "w": W, "h": H, "ms": infer_ms, "people": [
        {"score": s, "box": [x1,y1,x2,y2], "kp": [[x,y,conf] * 17]}],
     "hands": [{"score": s, "palm": [x,y], "tip": [x,y]}], "ht": <ts of hands frame>}
"hands"/"ht" are only present when a new hand result is ready: hands run in
the background so they never hold up the pose result.
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
import mediapipe as mp
import numpy as np
import torch
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from mediapipe.tasks import python as mpt
from mediapipe.tasks.python import vision as mpv
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

# Hands: MediaPipe Hand Landmarker on the CPU. A hand a few metres away is
# only a few dozen pixels, too small for MediaPipe's full-frame palm search,
# so we crop around each wrist the pose model found and look there.
HAND_MODEL = ROOT / "models" / "hand_landmarker.task"
HAND_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task"
PALM = (0, 5, 9, 13, 17)
CROP = 224


def make_hand_detector():
    if not HAND_MODEL.exists():
        HAND_MODEL.parent.mkdir(exist_ok=True)
        import urllib.request
        urllib.request.urlretrieve(HAND_URL, HAND_MODEL)
    return mpv.HandLandmarker.create_from_options(mpv.HandLandmarkerOptions(
        base_options=mpt.BaseOptions(model_asset_path=str(HAND_MODEL)),
        running_mode=mpv.RunningMode.IMAGE, num_hands=1,
        min_hand_detection_confidence=0.3, min_hand_presence_confidence=0.3))


def hand_in_crop(detector, img, kp, elbow, wrist):
    """Find the hand near one wrist. kp is the player's [[x,y,c]*17] (normalized)."""
    h, w = img.shape[:2]
    if kp[wrist][2] < 0.3:
        return None
    wx, wy = kp[wrist][0] * w, kp[wrist][1] * h
    if kp[elbow][2] >= 0.3:
        ex, ey = kp[elbow][0] * w, kp[elbow][1] * h
        fore = max(20.0, ((wx - ex) ** 2 + (wy - ey) ** 2) ** 0.5)
        cx, cy = wx + (wx - ex) * 0.4, wy + (wy - ey) * 0.4
    else:
        fore, cx, cy = 0.09 * h, wx, wy
    size = int(min(max(fore * 2.4, 64), 0.9 * h))
    x0, y0 = int(cx - size / 2), int(cy - size / 2)
    padded = cv2.copyMakeBorder(img, size, size, size, size, cv2.BORDER_CONSTANT)
    crop = cv2.resize(padded[y0 + size:y0 + 2 * size, x0 + size:x0 + 2 * size], (CROP, CROP))
    res = detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)))
    if not res.hand_landmarks:
        return None
    lms = res.hand_landmarks[0]
    to_img = lambda lx, ly: [round((x0 + lx * size) / w, 4), round((y0 + ly * size) / h, 4)]
    px = sum(lms[i].x for i in PALM) / len(PALM)
    py = sum(lms[i].y for i in PALM) / len(PALM)
    return {"score": round(res.handedness[0][0].score, 3), "palm": to_img(px, py), "tip": to_img(lms[8].x, lms[8].y)}


def decode(jpeg: bytes):
    return cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)


def infer(img):
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
for _ in range(3):
    infer(np.zeros((360, 640, 3), np.uint8))

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
    # one detector per side so both crops can run at once
    detectors = await asyncio.gather(asyncio.to_thread(make_hand_detector), asyncio.to_thread(make_hand_detector))
    hand_state = {"on": True, "job": None, "ready": None}

    async def run_hands(img, kp, ts):
        found = await asyncio.gather(
            asyncio.to_thread(hand_in_crop, detectors[0], img, kp, 7, 9),
            asyncio.to_thread(hand_in_crop, detectors[1], img, kp, 8, 10))
        hand_state["ready"] = ([f for f in found if f], ts)

    async def worker():
        while not closed:
            await have_frame.wait()
            have_frame.clear()
            frame, latest["frame"] = latest["frame"], None
            if frame is None:
                continue
            ts, jpeg = frame
            img = await asyncio.to_thread(decode, jpeg)
            if img is None:
                continue
            out = await asyncio.to_thread(infer, img)
            job = hand_state["job"]
            if hand_state["on"] and out["people"] and (job is None or job.done()):
                hand_state["job"] = asyncio.create_task(run_hands(img, out["people"][0]["kp"], ts))
            if hand_state["ready"]:
                out["hands"], out["ht"] = hand_state["ready"]
                hand_state["ready"] = None
            out["t"] = ts
            try:
                await ws.send_text(json.dumps(out, separators=(",", ":")))
            except Exception:
                return

    task = asyncio.create_task(worker())
    try:
        while True:
            m = await ws.receive()
            if m["type"] == "websocket.disconnect":
                break
            if m.get("text"):
                try:
                    hand_state["on"] = bool(json.loads(m["text"]).get("hands", True))
                except ValueError:
                    pass
                continue
            msg = m.get("bytes") or b""
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
        for t in (task, hand_state["job"]):
            if t is None:
                continue
            try:
                await t
            except BaseException:
                pass
        for d in detectors:
            d.close()


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
