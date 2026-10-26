"""Unbound for Windows: the whole app in one process.

Unbound.exe runs this with the bundled Python. It
  1. starts the game server on http://127.0.0.1 (localhost counts as a secure
     origin, so the camera works without a certificate),
  2. opens the games in a chromeless Chrome/Edge app window,
  3. picks the fastest pose engine this PC can run (CUDA -> DirectML -> CPU,
     each tried in a throwaway process so a broken driver can't take the app
     down) and caches the choice,
  4. quits when the game window is closed.

Install layout (see build.ps1):
    Unbound.exe  runtime\\  (Python)   app\\  (this repo)   models\\   rt\\cuda  rt\\dml  (ONNX Runtime builds)

Flags: --no-browser  --serve (stay up with no window, for tests)  --selftest
       --reprobe (forget the cached engine choice)  --backend cuda|dml|cpu
"""
import argparse
import ctypes
import glob
import json
import logging
import logging.handlers
import os
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
import webbrowser
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = HERE.parent                       # server.py, engine.py, web/
INSTALL = APP.parent                    # Unbound.exe lives here
MODELS = Path(os.environ.get("UNBOUND_MODELS", INSTALL / "models"))
RT = INSTALL / "rt"
DATA = Path(os.environ.get("LOCALAPPDATA", Path.home() / ".local" / "share")) / "Unbound"
VERSION = (APP / "VERSION").read_text().strip() if (APP / "VERSION").exists() else "dev"
PORT = 8600
BIG, SMALL = "yolo11l-pose.onnx", "yolo11s-pose.onnx"
SLOW_MS = 45  # if the big model is slower than this per frame, use the small one
NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0
log = logging.getLogger("unbound")

sys.path.insert(0, str(APP))
sys.path.insert(0, str(HERE))
import gpu  # noqa: E402


# ---------------------------------------------------------------- setup

def setup_logging():
    DATA.mkdir(parents=True, exist_ok=True)
    h = logging.handlers.RotatingFileHandler(DATA / "unbound.log", maxBytes=2_000_000, backupCount=2, encoding="utf-8")
    h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.addHandler(h)
    root.setLevel(logging.INFO)
    if sys.stdout is None or sys.executable.lower().endswith("pythonw.exe"):
        # pythonw has no console; keep print()/tracebacks from libraries in the log
        f = open(DATA / "console.log", "a", buffering=1, encoding="utf-8", errors="replace")
        sys.stdout = sys.stderr = f
    else:
        root.addHandler(logging.StreamHandler(sys.stdout))


def message_box(text, title="Unbound"):
    log.error(text)
    if sys.platform == "win32":
        ctypes.windll.user32.MessageBoxW(None, text, title, 0x10)
    else:
        print(text, file=sys.stderr)


def activate_runtime(backend):
    """Put the right ONNX Runtime build on the import path. Must run before
    anything imports onnxruntime; the CUDA and DirectML builds can't coexist."""
    d = RT / ("cuda" if backend == "cuda" else "dml")
    if not d.exists():
        return  # dev checkout: use whatever onnxruntime is installed
    sys.path.insert(0, str(d))
    if backend == "cuda" and sys.platform == "win32":
        # Room for the driver to keep JIT-compiled kernels between launches
        # (the 256 MB default is too small for cuDNN on newer GPUs).
        os.environ.setdefault("CUDA_CACHE_MAXSIZE", str(4 << 30))
        bins = sorted(glob.glob(str(d / "nvidia" / "*" / "bin")))
        os.environ["PATH"] = os.pathsep.join(bins + [os.environ.get("PATH", "")])
        for b in bins:
            os.add_dll_directory(b)
        # Load the CUDA libraries by full path first, so ONNX Runtime's CUDA
        # provider binds to our copies instead of whatever is on the PC.
        for pat in ("cudart64_12*.dll", "cublasLt64_12*.dll", "cublas64_12*.dll", "cufft64_11*.dll",
                    "curand64_10*.dll", "nvrtc64_12*.dll", "cudnn64_9*.dll"):
            for b in bins:
                for f in glob.glob(os.path.join(b, pat)):
                    try:
                        ctypes.WinDLL(f)
                    except OSError as e:
                        log.warning("could not preload %s: %s", f, e)


def check_dlls():
    """Build check: every DLL the CUDA engine needs is bundled and loads.
    (No GPU needed: the driver itself is only touched when a session starts.)"""
    activate_runtime("cuda")
    d = RT / "cuda"
    # (onnxruntime_providers_cuda.dll itself can only be loaded by ONNX Runtime; the session test below covers it)
    dlls = sorted(glob.glob(str(d / "nvidia" / "*" / "bin" / "*.dll")))
    bad = 0
    for f in dlls:
        try:
            ctypes.WinDLL(f)
            print("ok  ", os.path.basename(f))
        except OSError as e:
            bad += 1
            print("FAIL", os.path.basename(f), e)
    for b in ("cuda", "dml"):
        r = subprocess.run([sys.executable, "-c", f"import sys; sys.path.insert(0, r'{RT / b}'); import onnxruntime as o; "
                            "print(o.__version__, o.get_available_providers())"], capture_output=True, text=True)
        print(b, "runtime:", r.stdout.strip() or r.stderr.strip()[-500:])
        bad += r.returncode != 0
    # Start a real CUDA session in a fresh process. Without an NVIDIA GPU this
    # fails with "no CUDA device"; it must never fail with a missing DLL (126).
    model = next(iter(sorted(MODELS.glob("*.onnx"))), None)
    if model:
        r = subprocess.run([sys.executable, __file__, "--probe", "cuda", "--out", str(DATA / "check-cuda.json")],
                           capture_output=True, text=True, timeout=300)
        log_tail = (DATA / "console.log").read_text(errors="replace")[-3000:] if (DATA / "console.log").exists() else ""
        res = (DATA / "check-cuda.json").read_text() if (DATA / "check-cuda.json").exists() else "{}"
        missing = "error 126" in (r.stderr + log_tail) or "error 1114" in (r.stderr + log_tail)
        print("cuda session:", res, "\n", (r.stderr + log_tail)[-1500:])
        if missing:
            print("FAIL CUDA provider could not load its DLLs")
            bad += 1
    print("DLL CHECK", "FAILED" if bad else "PASSED")
    return 1 if bad else 0


def providers_for(backend):
    if backend == "cuda":
        return [("CUDAExecutionProvider", {"cudnn_conv_algo_search": "HEURISTIC", "do_copy_in_default_stream": True}),
                "CPUExecutionProvider"]
    if backend == "dml":
        return [("DmlExecutionProvider", {"device_id": 0}), "CPUExecutionProvider"]
    return ["CPUExecutionProvider"]


def make_engine(backend, model, gpu_name, log_level=3):
    from engine import OnnxPose
    eng = OnnxPose(MODELS / model, providers_for(backend), gpu=gpu_name, log_level=log_level)
    want = {"cuda": "CUDAExecutionProvider", "dml": "DmlExecutionProvider", "cpu": "CPUExecutionProvider"}[backend]
    if eng.provider != want:
        raise RuntimeError(f"{want} not available (got {eng.provider})")
    return eng


# ---------------------------------------------------------------- picking an engine

def probe(backend, out):
    """Child process: can this backend run here, and how fast?"""
    import numpy as np
    result = {"backend": backend, "ok": False}
    try:
        activate_runtime(backend)
        info = gpu.detect()
        nv = max(info["gpus"], key=lambda g: g["cc"])["name"] if info else None
        name = {"cuda": nv, "dml": nv or "DirectX 12 GPU", "cpu": None}[backend]
        frame = np.random.default_rng(0).integers(0, 255, (360, 640, 3), dtype=np.uint8)

        def bench(model):
            t = time.monotonic()
            eng = make_engine(backend, model, name, log_level=2)
            log.info("probe %s: %s session took %.1f s", backend, model, time.monotonic() - t)
            for _ in range(3):
                eng(frame)
            times = sorted(eng(frame)[1] for _ in range(10))
            return eng, times[len(times) // 2]

        model = SMALL if backend == "cpu" else BIG
        eng, ms = bench(model)
        if ms > SLOW_MS and model == BIG:
            log.info("probe %s: %s takes %.1f ms, trying the small model", backend, BIG, ms)
            model = SMALL
            eng, ms = bench(model)
        result.update(ok=True, model=model, ms=round(ms, 1), gpu=name)
    except Exception as e:
        result["error"] = f"{type(e).__name__}: {e}"
        log.warning("probe %s failed:\n%s", backend, traceback.format_exc())
    Path(out).write_text(json.dumps(result))


def choose_engine(forced=None, reprobe=False, report=lambda s: None):
    info = gpu.detect()
    order, note = gpu.plan(info)
    if forced:
        order = [forced]
    key = {"version": VERSION, "driver": info and info["driver"], "gpus": info and [g["name"] for g in info["gpus"]],
           "order": order}
    cache = DATA / "engine.json"
    if not reprobe and cache.exists():
        try:
            c = json.loads(cache.read_text())
            if c.get("key") == key:
                log.info("using cached engine choice %s", c["choice"])
                return c["choice"], note
        except (ValueError, KeyError):
            pass
    log.info("GPU info: %s; trying %s", info, order)
    tried = []
    for b in order:
        report({"cuda": "Setting up CUDA on your NVIDIA GPU (first launch only, ~20 s)…",
                "dml": "Trying DirectML on your GPU…", "cpu": "Trying the CPU…"}[b])
        out = DATA / f"probe-{b}.json"
        out.unlink(missing_ok=True)
        try:
            subprocess.run([sys.executable, __file__, "--probe", b, "--out", str(out)],
                           timeout=180, creationflags=NO_WINDOW, check=False)
            r = json.loads(out.read_text())
        except (OSError, ValueError, subprocess.SubprocessError) as e:
            r = {"backend": b, "ok": False, "error": f"probe crashed: {e}"}
        log.info("probe result: %s", r)
        tried.append(r)
        if r["ok"]:
            cache.write_text(json.dumps({"key": key, "choice": r, "tried": tried}, indent=1))
            return r, note
    raise RuntimeError("No pose engine could start on this PC:\n" + "\n".join(f"{t['backend']}: {t.get('error')}" for t in tried))


# ---------------------------------------------------------------- browser window

def find_browser():
    if sys.platform != "win32":
        return None
    import winreg
    cands = []
    for exe in ("chrome.exe", "msedge.exe"):
        for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            try:
                with winreg.OpenKey(hive, rf"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exe}") as k:
                    cands.append(winreg.QueryValue(k, None))
            except OSError:
                pass
        for base in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
            root = os.environ.get(base)
            if root:
                sub = r"Google\Chrome\Application" if exe == "chrome.exe" else r"Microsoft\Edge\Application"
                cands.append(os.path.join(root, sub, exe))
    for c in cands:
        if c and os.path.exists(c.strip('"')):
            return c.strip('"')
    return None


def open_window(url):
    exe = find_browser()
    if not exe:
        log.info("no Chrome/Edge found, opening the default browser")
        webbrowser.open(url)
        return None
    profile = DATA / "browser"
    args = [exe, f"--app={url}", f"--user-data-dir={profile}", "--start-maximized",
            "--no-first-run", "--no-default-browser-check", "--disable-background-mode",
            # it's our own local page in its own profile: allow the camera without a prompt
            "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required",
            "--disable-features=Translate,msEdgeStartupBoost,msImplicitSignin,msEdgeSidebarV2,TranslateUI"]
    log.info("opening %s", args)
    return subprocess.Popen(args, creationflags=NO_WINDOW)


# ---------------------------------------------------------------- main

def existing_instance():
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/info", timeout=1.5) as r:
            return json.load(r).get("app") == "unbound"
    except Exception:
        return False


def free_port():
    for p in [PORT] + list(range(8601, 8650)):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--probe")
    ap.add_argument("--out")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--serve", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--reprobe", action="store_true")
    ap.add_argument("--backend", choices=["cuda", "dml", "cpu"])
    ap.add_argument("--port", type=int)
    ap.add_argument("--check-dlls", action="store_true")
    a = ap.parse_args()
    if a.check_dlls:
        DATA.mkdir(parents=True, exist_ok=True)
        sys.exit(check_dlls())
    setup_logging()
    if a.probe:
        return probe(a.probe, a.out)
    log.info("Unbound %s starting (python %s)", VERSION, sys.version.split()[0])

    if not (a.serve or a.selftest or a.port) and existing_instance():
        log.info("already running, just opening another window")
        open_window(f"http://127.0.0.1:{PORT}/")
        return

    os.environ["UNBOUND_MODELS"] = str(MODELS)
    os.environ["UNBOUND_LOCAL"] = "1"
    import uvicorn
    import server

    port = a.port or free_port()
    srv = uvicorn.Server(uvicorn.Config(server.app, host="127.0.0.1", port=port, log_level="warning",
                                       ws_max_size=4 * 1024 * 1024, log_config=None))
    threading.Thread(target=srv.run, daemon=True).start()
    while not srv.started:
        time.sleep(0.05)
    url = f"http://127.0.0.1:{port}/"
    log.info("serving %s", url)

    def start_engine():
        def report(s):
            server.status["detail"] = s
        try:
            t0 = time.monotonic()
            choice, note = choose_engine(a.backend, a.reprobe, report)
            t1 = time.monotonic()
            report(f"Loading the pose model ({choice['backend'].upper()})…")
            activate_runtime(choice["backend"])
            os.environ["POSE_MODEL"] = server.MODEL_NAME = choice["model"]
            eng = make_engine(choice["backend"], choice["model"], choice.get("gpu"))
            t2 = time.monotonic()
            server.load_engine(eng)
            log.info("startup times: choose engine %.1f s, create session %.1f s, warm-up %.1f s",
                     t1 - t0, t2 - t1, time.monotonic() - t2)
            if choice["backend"] == "cpu" and not a.backend:
                note = "No GPU engine could start on this PC, so it runs on the CPU with the small model (playable, but slower)."
            elif choice["backend"] == "dml" and note is None:
                note = "CUDA couldn't start, so it uses DirectML instead. Updating your NVIDIA driver may help."
            server.status["detail"] = note
            log.info("engine ready: %s %s on %s", server.model.backend, choice["model"], server.model.gpu)
        except Exception as e:
            server.status.update(state="error", error=str(e))
            server.ready.set()
            log.error("engine failed:\n%s", traceback.format_exc())
            if not (a.selftest or a.serve):
                message_box(f"Unbound couldn't start its pose engine.\n\n{e}\n\nLog: {DATA / 'unbound.log'}")
    eng_thread = threading.Thread(target=start_engine, daemon=True)
    eng_thread.start()

    if a.selftest:
        import selftest
        code = selftest.run(url, server)
        srv.should_exit = True
        os._exit(code)

    browser = None if (a.no_browser or a.serve) else open_window(url)
    t0 = time.monotonic()
    life = server.life
    while True:
        time.sleep(1)
        if a.serve:
            continue
        idle = time.monotonic() - life["last"]
        if life["seen"] and life["clients"] == 0 and idle > 6:
            log.info("game window closed, shutting down")
            break
        if not life["seen"] and time.monotonic() - t0 > 180 and (browser is None or browser.poll() is not None):
            log.info("no window ever connected, shutting down")
            break
    srv.should_exit = True
    time.sleep(0.5)
    os._exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException:
        tb = traceback.format_exc()
        try:
            message_box("Unbound hit an error and has to close.\n\n" + tb[-1500:])
        finally:
            sys.exit(1)
