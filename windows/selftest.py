"""End-to-end check of an installed Unbound (run with `Unbound.exe --selftest`,
or `python windows/unbound.py --selftest`). Exits 0 if everything works.

Set UNBOUND_TEST_IMAGE to a photo with people in it to also check that
people are actually detected.
"""
import json
import os
import struct
import time
import urllib.request

import cv2
import numpy as np


def run(url, server):
    report, ok = {}, True

    def check(name, cond, info=""):
        nonlocal ok
        report[name] = {"ok": bool(cond), "info": info}
        ok &= bool(cond)
        print(("PASS " if cond else "FAIL ") + name, info, flush=True)

    html = urllib.request.urlopen(url, timeout=10).read().decode()
    check("index page", "<title>Unbound</title>" in html)
    for f in ("js/main.js", "js/pose.js", "js/games/saber.js", "js/games/wall.js", "js/games/mole.js",
              "js/games/shooter.js", "js/games/tennis.js", "js/games/viewer.js", "vendor/three.module.js"):
        try:
            code = urllib.request.urlopen(url + f, timeout=10).status
        except Exception as e:
            code = str(e)
        check("static " + f, code == 200, code)

    t0 = time.monotonic()
    while server.status["state"] == "loading" and time.monotonic() - t0 < 600:
        time.sleep(0.5)
    info = json.load(urllib.request.urlopen(url + "api/info", timeout=10))
    check("engine ready", info["state"] == "ready", json.dumps(info))
    if info["state"] != "ready":
        return finish(report, ok)

    path = os.environ.get("UNBOUND_TEST_IMAGE")
    img = cv2.imread(path) if path else None
    if img is None:
        img = np.random.default_rng(0).integers(0, 255, (360, 640, 3), dtype=np.uint8)
    else:  # what the browser sends: 640 wide JPEG
        img = cv2.resize(img, (640, round(640 * img.shape[0] / img.shape[1])))
    jpeg = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 72])[1].tobytes()

    from websockets.sync.client import connect
    ws_url = url.replace("http", "ws") + "ws"
    with connect(ws_url, max_size=None, open_timeout=30) as ws:
        ws.send(json.dumps({"hands": True}))
        times, got_hands, last = [], False, None
        for i in range(40):
            ws.send(struct.pack("<d", 1000.0 + i) + jpeg)
            last = json.loads(ws.recv(timeout=30))
            times.append(last["ms"])
            got_hands |= "hands" in last
        check("pose round trips", len(times) == 40, f"median inference {sorted(times)[20]} ms, backend {info['backend']}")
        if path:
            check("people detected", len(last["people"]) >= 1, f"{len(last['people'])} people")
        if path:
            check("hand tracker ran", got_hands)
    return finish(report, ok)


def finish(report, ok):
    out = os.environ.get("UNBOUND_SELFTEST_OUT")
    if out:
        with open(out, "w") as f:
            json.dump(report, f, indent=1)
    print("SELFTEST", "PASSED" if ok else "FAILED", flush=True)
    return 0 if ok else 1
