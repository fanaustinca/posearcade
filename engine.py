"""Pose backends. Both turn a BGR image into a list of people:
    {"score": s, "box": [x1,y1,x2,y2], "kp": [[x,y,conf] * 17]}  (normalized 0..1)

UltralyticsPose: PyTorch via ultralytics (the Linux / DGX Spark server).
OnnxPose:        a YOLO11-pose model exported to ONNX, run with ONNX Runtime
                 (CUDA, DirectML or CPU). This is what the Windows build ships,
                 since it needs no PyTorch and no CUDA toolkit install.
"""
import time

import cv2
import numpy as np

CONF = 0.35
IOU = 0.7
MAX_DET = 4


class UltralyticsPose:
    def __init__(self, weights, imgsz=640):
        import torch
        from ultralytics import YOLO
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.gpu = torch.cuda.get_device_name(0) if self.device == "cuda" else None
        self.backend = "PyTorch " + ("CUDA" if self.device == "cuda" else "CPU")
        self.imgsz = imgsz
        self.model = YOLO(weights)
        self.model.to(self.device)

    def __call__(self, img):
        h, w = img.shape[:2]
        t0 = time.perf_counter()
        res = self.model.predict(img, imgsz=self.imgsz, conf=CONF, quantize=16 if self.device == "cuda" else None,
                                 device=self.device, verbose=False, max_det=MAX_DET)[0]
        ms = (time.perf_counter() - t0) * 1000
        people = []
        if res.keypoints is not None and len(res.boxes):
            kxy = res.keypoints.xy.cpu().numpy()
            kc = res.keypoints.conf.cpu().numpy() if res.keypoints.conf is not None else np.ones(kxy.shape[:2])
            boxes = res.boxes.xyxy.cpu().numpy()
            scores = res.boxes.conf.cpu().numpy()
            for i in range(len(boxes)):
                people.append(_person(scores[i], boxes[i], kxy[i], kc[i], w, h))
        return people, ms


class OnnxPose:
    """YOLO11-pose ONNX export: input (1,3,H,W) RGB 0..1, output (1,56,N) with
    rows cx,cy,w,h, person score, then 17 * (x, y, visibility) in input pixels."""

    def __init__(self, path, providers, gpu=None):
        import onnxruntime as ort
        so = ort.SessionOptions()
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        so.log_severity_level = 3
        self.sess = ort.InferenceSession(str(path), so, providers=providers)
        inp = self.sess.get_inputs()[0]
        self.input = inp.name
        self.in_h, self.in_w = int(inp.shape[2]), int(inp.shape[3])
        used = self.sess.get_providers()[0]
        self.provider = used
        self.backend = {"CUDAExecutionProvider": "CUDA", "DmlExecutionProvider": "DirectML",
                        "CPUExecutionProvider": "CPU"}.get(used, used)
        self.gpu = gpu
        self.imgsz = max(self.in_h, self.in_w)
        self._buf = np.full((self.in_h, self.in_w, 3), 114, np.uint8)

    def _letterbox(self, img):
        h, w = img.shape[:2]
        r = min(self.in_h / h, self.in_w / w)
        nh, nw = int(round(h * r)), int(round(w * r))
        top, left = (self.in_h - nh) // 2, (self.in_w - nw) // 2
        buf = self._buf
        buf[:] = 114
        buf[top:top + nh, left:left + nw] = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
        x = cv2.cvtColor(buf, cv2.COLOR_BGR2RGB).transpose(2, 0, 1)[None].astype(np.float32) * (1 / 255)
        return x, r, left, top

    def __call__(self, img):
        h, w = img.shape[:2]
        t0 = time.perf_counter()
        x, r, left, top = self._letterbox(img)
        out = self.sess.run(None, {self.input: x})[0][0].T  # (N, 56)
        ms = (time.perf_counter() - t0) * 1000
        out = out[out[:, 4] > CONF]
        if not len(out):
            return [], ms
        boxes = np.empty((len(out), 4), np.float32)
        boxes[:, 0] = out[:, 0] - out[:, 2] / 2
        boxes[:, 1] = out[:, 1] - out[:, 3] / 2
        boxes[:, 2] = out[:, 0] + out[:, 2] / 2
        boxes[:, 3] = out[:, 1] + out[:, 3] / 2
        keep = cv2.dnn.NMSBoxes([[float(b[0]), float(b[1]), float(b[2] - b[0]), float(b[3] - b[1])] for b in boxes],
                                out[:, 4].tolist(), CONF, IOU)
        keep = sorted(np.array(keep).reshape(-1).tolist(), key=lambda i: -out[i, 4])[:MAX_DET]
        people = []
        for i in keep:
            box = (boxes[i] - [left, top, left, top]) / r
            kp = out[i, 5:].reshape(17, 3)
            kxy = (kp[:, :2] - [left, top]) / r
            people.append(_person(out[i, 4], box, kxy, kp[:, 2], w, h))
        return people, ms


def _person(score, box, kxy, kc, w, h):
    kp = [[round(float(x) / w, 4), round(float(y) / h, 4), round(float(c), 3)] for (x, y), c in zip(kxy, kc)]
    b = box
    return {"score": round(float(score), 3),
            "box": [round(float(b[0]) / w, 4), round(float(b[1]) / h, 4), round(float(b[2]) / w, 4), round(float(b[3]) / h, 4)],
            "kp": kp}
