"""Turn a photo into a short Y4M clip Chrome can use as a fake webcam
(--use-file-for-fake-video-capture). Usage: make_y4m.py photo.jpg out.y4m"""
import sys

import cv2
import numpy as np

W, H, FRAMES = 1280, 720, 30
img = cv2.imread(sys.argv[1])
r = min(W / img.shape[1], H / img.shape[0])
img = cv2.resize(img, (int(img.shape[1] * r) // 2 * 2, int(img.shape[0] * r) // 2 * 2))
canvas = np.full((H, W, 3), 40, np.uint8)
y0, x0 = (H - img.shape[0]) // 2, (W - img.shape[1]) // 2
canvas[y0:y0 + img.shape[0], x0:x0 + img.shape[1]] = img
yuv = cv2.cvtColor(canvas, cv2.COLOR_BGR2YUV_I420).tobytes()
with open(sys.argv[2], "wb") as f:
    f.write(f"YUV4MPEG2 W{W} H{H} F30:1 Ip A1:1 C420jpeg\n".encode())
    for _ in range(FRAMES):
        f.write(b"FRAME\n" + yuv)
