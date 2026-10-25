# Builds the Unbound Windows installer: dist\Unbound-Setup-<version>.exe
#
# Needs (all present on GitHub's windows-2022 runners):
#   - Python 3.12 on PATH (only used to fetch packages and export the model)
#   - Visual Studio 2022 C++ build tools (for the tiny Unbound.exe launcher)
#   - Inno Setup 6 (choco install innosetup)
#
#   powershell -ExecutionPolicy Bypass -File windows\build.ps1 -Version 1.0.0
param(
    [string]$Version = "0.1.0",
    [string]$ModelsDir = ""      # reuse already-exported .onnx models instead of exporting
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Repo = Resolve-Path "$PSScriptRoot\.."
$Work = "$Repo\build"
$Stage = "$Work\Unbound"
$Dist = "$Repo\dist"
$PyVer = "3.12.10"            # last 3.12 release with an embeddable build
$OrtGpu = "1.26.0"            # last ONNX Runtime GPU build on CUDA 12 (runs on drivers 528+)
$OrtDml = "1.24.4"

function Step($m) { Write-Host "`n=== $m" -ForegroundColor Cyan }
function Run($exe) {
    & $exe @args
    if ($LASTEXITCODE -ne 0) { throw "$exe $args failed ($LASTEXITCODE)" }
}

Step "clean"
Remove-Item -Recurse -Force $Stage, $Dist -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $Stage, $Dist, "$Work\cache", "$Stage\models", "$Stage\rt" | Out-Null

Step "embedded Python $PyVer"
$zip = "$Work\cache\python-$PyVer-embed-amd64.zip"
if (-not (Test-Path $zip)) {
    Invoke-WebRequest "https://www.python.org/ftp/python/$PyVer/python-$PyVer-embed-amd64.zip" -OutFile $zip
}
Expand-Archive $zip "$Stage\runtime"
# ._pth makes the embedded Python ignore the PC's own Python setup entirely
@"
python312.zip
.
Lib\site-packages
..\app
import site
"@ | Set-Content -Encoding ascii "$Stage\runtime\python312._pth"
# Visual C++ runtime, so nothing has to be installed on the target PC
foreach ($d in "msvcp140.dll", "msvcp140_1.dll", "msvcp140_2.dll", "vcruntime140.dll", "vcruntime140_1.dll", "concrt140.dll") {
    $src = "$env:SystemRoot\System32\$d"
    if ((Test-Path $src) -and -not (Test-Path "$Stage\runtime\$d")) { Copy-Item $src "$Stage\runtime\" }
}

Step "Python packages"
$site = "$Stage\runtime\Lib\site-packages"
$pip = @("-m", "pip", "install", "--disable-pip-version-check", "--no-compile", "--only-binary=:all:",
         "--platform", "win_amd64", "--python-version", "3.12", "--implementation", "cp")
Run python @pip --target $site -r "$PSScriptRoot\requirements-win.txt"
# mediapipe's own deps pull in a second OpenCV, matplotlib and jax; it needs none of them for hand tracking
Run python @pip --target $site --no-deps "mediapipe==1.1.1"

Step "ONNX Runtime: CUDA 12 build (with its CUDA + cuDNN DLLs) and DirectML build"
Run python @pip --target "$Stage\rt\cuda" --no-deps "onnxruntime-gpu==$OrtGpu" `
    "nvidia-cuda-runtime-cu12==12.9.*" "nvidia-cublas-cu12==12.9.*" "nvidia-cufft-cu12==11.4.*" `
    "nvidia-curand-cu12==10.3.*" "nvidia-cuda-nvrtc-cu12==12.9.*" "nvidia-cudnn-cu12==9.*"
Run python @pip --target "$Stage\rt\dml" --no-deps "onnxruntime-directml==$OrtDml"
# headers, import libs and dist-info aren't needed at runtime
Get-ChildItem "$Stage\rt\cuda\nvidia" -Directory | ForEach-Object {
    Remove-Item -Recurse -Force "$($_.FullName)\include", "$($_.FullName)\lib" -ErrorAction SilentlyContinue
}
Get-ChildItem "$Stage\rt" -Recurse -Directory -Filter "*.dist-info" | Remove-Item -Recurse -Force

Step "pose + hand models"
if ($ModelsDir) {
    Copy-Item "$ModelsDir\*" "$Stage\models\"
} else {
    $exp = "$Work\export"
    New-Item -ItemType Directory -Force $exp | Out-Null
    Run python -m pip install --disable-pip-version-check -q torch torchvision --index-url https://download.pytorch.org/whl/cpu
    Run python -m pip install --disable-pip-version-check -q "ultralytics==8.4.*" onnx onnxslim
    Push-Location $exp
    # 384x640 matches the 16:9 frames the browser sends (640x360), so no compute is wasted on padding
    Run python -c "from ultralytics import YOLO; [YOLO(n + '.pt').export(format='onnx', imgsz=(384, 640), opset=17, simplify=True, device='cpu') for n in ('yolo11l-pose', 'yolo11s-pose')]"
    Pop-Location
    Copy-Item "$exp\yolo11l-pose.onnx", "$exp\yolo11s-pose.onnx" "$Stage\models\"
}
if (-not (Test-Path "$Stage\models\hand_landmarker.task")) {
    Invoke-WebRequest "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task" -OutFile "$Stage\models\hand_landmarker.task"
}

Step "app files"
New-Item -ItemType Directory -Force "$Stage\app\windows" | Out-Null
Copy-Item "$Repo\server.py", "$Repo\engine.py" "$Stage\app\"
Copy-Item -Recurse "$Repo\web" "$Stage\app\web"
Copy-Item "$PSScriptRoot\unbound.py", "$PSScriptRoot\gpu.py", "$PSScriptRoot\selftest.py" "$Stage\app\windows\"
$Version | Set-Content -Encoding ascii "$Stage\app\VERSION"
Copy-Item "$PSScriptRoot\unbound.ico" "$Stage\"
# precompile so the first launch is quick
& "$Stage\runtime\python.exe" -m compileall -q -j 0 "$Stage\app" "$site" | Out-Null

Step "Unbound.exe launcher"
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw "Visual Studio C++ build tools not found" }
$v = @(($Version -split '[^0-9]+') | Where-Object { $_ }) + @(0, 0, 0)
$obj = "$Work\launcher"
New-Item -ItemType Directory -Force $obj | Out-Null
@"
#define VER_MAJOR $($v[0])
#define VER_MINOR $($v[1])
#define VER_PATCH $($v[2])
#define VER_STRING "$Version"
"@ | Set-Content -Encoding ascii "$obj\version.h"
@"
@echo off
call "$vs\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
cd /d "$PSScriptRoot\launcher"
rc /nologo /i "$obj" /fo "$obj\launcher.res" launcher.rc || exit /b 1
cl /nologo /O2 /W3 /Fo"$obj\\" launcher.c "$obj\launcher.res" /link /SUBSYSTEM:WINDOWS user32.lib /OUT:"$Stage\Unbound.exe" || exit /b 1
"@ | Set-Content -Encoding ascii "$obj\build.cmd"
cmd /c "$obj\build.cmd"
$code = $LASTEXITCODE
if ($code -ne 0) { throw "launcher build failed" }

Step "installer"
$iscc = @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe", "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw "Inno Setup 6 not found (choco install innosetup)" }
$mb = [math]::Round((Get-ChildItem $Stage -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)
Write-Host "staged app: $mb MB"
Run $iscc /Q "/DAppVersion=$Version" "/DSrcDir=$Stage" "/DOutDir=$Dist" "$PSScriptRoot\installer.iss"
Get-ChildItem $Dist | ForEach-Object { Write-Host ("{0}  {1:N0} MB" -f $_.Name, ($_.Length / 1MB)) }
