"""Check that every DLL the CUDA engine needs is in the install or in Windows.

Walks the PE import tables starting from ONNX Runtime's CUDA provider (and
cuDNN's lazily-loaded sub-libraries), so it works on a machine with no GPU.
The NVIDIA driver's own DLLs are the only things allowed to be missing.
Usage: python check_imports.py <install dir>
"""
import os
import sys
from pathlib import Path

import pefile

DRIVER = {"nvcuda.dll", "nvml.dll", "nvapi64.dll", "nvfatbinaryloader.dll"}
inst = Path(sys.argv[1])
search = [inst / "runtime", inst / "rt" / "cuda" / "onnxruntime" / "capi"] + sorted((inst / "rt" / "cuda" / "nvidia").glob("*/bin"))
system = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"
index = {}
for d in search:
    for f in d.glob("*.dll"):
        index.setdefault(f.name.lower(), f)

roots = [inst / "rt" / "cuda" / "onnxruntime" / "capi" / "onnxruntime_providers_cuda.dll"]
roots += [f for f in index.values() if f.name.lower().startswith("cudnn")]
seen, missing, queue = set(), [], list(roots)
while queue:
    f = queue.pop()
    if f.name.lower() in seen:
        continue
    seen.add(f.name.lower())
    pe = pefile.PE(str(f), fast_load=True)
    pe.parse_data_directories(directories=[pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_IMPORT"],
                                           pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT"]])
    for entry in getattr(pe, "DIRECTORY_ENTRY_IMPORT", []) + getattr(pe, "DIRECTORY_ENTRY_DELAY_IMPORT", []):
        name = entry.dll.decode().lower()
        if name in index:
            queue.append(index[name])
        elif name in DRIVER:
            print(f"driver  {name:40s} (from {f.name})")
        elif name.startswith(("api-ms-win-", "ext-ms-")) or (system / name).exists():
            continue
        else:
            missing.append(f"{name} (needed by {f.name})")
print(f"checked {len(seen)} DLLs")
for m in missing:
    print("MISSING", m)
print("IMPORT CHECK", "FAILED" if missing else "PASSED")
sys.exit(1 if missing else 0)
