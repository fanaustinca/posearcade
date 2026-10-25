"""Find the NVIDIA GPU and what CUDA version its driver supports.

We bundle the CUDA 12 runtime + cuDNN 9 with the app, so the only thing the
PC itself has to provide is an NVIDIA driver new enough for CUDA 12
(driver 528.33+ on Windows, i.e. anything from 2023 on). No CUDA toolkit
install is needed. Older drivers or non-NVIDIA GPUs fall back to DirectML.
"""
import ctypes
import os
import shutil
import subprocess
import sys

CUDA_NEEDED = 12000  # nvml encodes 12.0 as 12000
NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0


def _nvml():
    if sys.platform != "win32":
        for name in ("libnvidia-ml.so.1", "libnvidia-ml.so"):
            try:
                return ctypes.CDLL(name)
            except OSError:
                pass
        return None
    dirs = [os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32"),
            os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "NVIDIA Corporation", "NVSMI")]
    for d in dirs:
        p = os.path.join(d, "nvml.dll")
        if os.path.exists(p):
            try:
                return ctypes.WinDLL(p)
            except OSError:
                pass
    return None


def _from_nvml():
    lib = _nvml()
    if lib is None or lib.nvmlInit_v2() != 0:
        return None
    try:
        buf = ctypes.create_string_buffer(96)
        lib.nvmlSystemGetDriverVersion(buf, 96)
        driver = buf.value.decode()
        cuda = ctypes.c_int(0)
        lib.nvmlSystemGetCudaDriverVersion_v2(ctypes.byref(cuda))
        count = ctypes.c_uint(0)
        lib.nvmlDeviceGetCount_v2(ctypes.byref(count))
        gpus = []
        for i in range(count.value):
            h = ctypes.c_void_p()
            if lib.nvmlDeviceGetHandleByIndex_v2(i, ctypes.byref(h)) != 0:
                continue
            lib.nvmlDeviceGetName(h, buf, 96)
            major, minor = ctypes.c_int(0), ctypes.c_int(0)
            lib.nvmlDeviceGetCudaComputeCapability(h, ctypes.byref(major), ctypes.byref(minor))

            class Mem(ctypes.Structure):
                _fields_ = [("total", ctypes.c_ulonglong), ("free", ctypes.c_ulonglong), ("used", ctypes.c_ulonglong)]
            mem = Mem()
            lib.nvmlDeviceGetMemoryInfo(h, ctypes.byref(mem))
            gpus.append({"index": i, "name": buf.value.decode(), "cc": major.value + minor.value / 10,
                         "vram_gb": round(mem.total / 2 ** 30, 1)})
        return {"driver": driver, "cuda": cuda.value, "gpus": gpus}
    finally:
        lib.nvmlShutdown()


def _from_smi():
    smi = shutil.which("nvidia-smi") or os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "nvidia-smi.exe")
    try:
        out = subprocess.run([smi, "--query-gpu=index,name,driver_version,memory.total,compute_cap",
                              "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=15,
                             creationflags=NO_WINDOW).stdout
        head = subprocess.run([smi], capture_output=True, text=True, timeout=15, creationflags=NO_WINDOW).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    gpus, driver = [], None
    for line in out.strip().splitlines():
        f = [x.strip() for x in line.split(",")]
        if len(f) < 5:
            continue
        driver = f[2]
        try:
            gpus.append({"index": int(f[0]), "name": f[1], "cc": float(f[4]), "vram_gb": round(float(f[3]) / 1024, 1)})
        except ValueError:
            pass
    cuda = 0
    if "CUDA Version:" in head:
        v = head.split("CUDA Version:")[1].split()[0]
        a, _, b = v.partition(".")
        cuda = int(a) * 1000 + int(b or 0) * 10
    return {"driver": driver, "cuda": cuda, "gpus": gpus} if gpus else None


def detect():
    """{"driver": "581.57", "cuda": 13000, "gpus": [{"name", "cc", "vram_gb"}]} or None."""
    try:
        info = _from_nvml()
    except Exception:
        info = None
    if not info or not info["gpus"]:
        info = _from_smi()
    return info if info and info["gpus"] else None


def plan(info):
    """Which ONNX Runtime backends to try, best first, plus a note for the user."""
    if info is None:
        return ["dml", "cpu"], "No NVIDIA GPU found, using DirectML."
    best = max(info["gpus"], key=lambda g: (g["cc"], g["vram_gb"]))
    if best["cc"] and best["cc"] < 5.0:
        return ["dml", "cpu"], f"{best['name']} is too old for CUDA 12, using DirectML."
    if info["cuda"] < CUDA_NEEDED:
        have = f"{info['cuda'] // 1000}.{info['cuda'] % 1000 // 10}" if info["cuda"] else "unknown"
        return ["dml", "cpu"], (f"NVIDIA driver {info['driver']} only supports CUDA {have}; "
                                "update your NVIDIA driver for the faster CUDA engine. Using DirectML for now.")
    return ["cuda", "dml", "cpu"], None


if __name__ == "__main__":
    i = detect()
    print(i)
    print(plan(i))
