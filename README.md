# Unbound

Full-body motion games in the browser, powered by GPU pose estimation on a separate machine.

Your laptop or phone captures the camera and streams small JPEG frames over a WebSocket to a GPU box (built for an NVIDIA DGX Spark / GB10). The box runs YOLO11-pose for 17 body keypoints and, around each wrist it finds, MediaPipe's hand landmarker for precise hand positions. The browser smooths them (One Euro filter), predicts ahead to hide network latency, and drives the games.

## Games

- **Beat Slicer**: a Beat Saber–style rhythm game where **every block is a note**. Your forearms become lightsabers (red = left, blue = right); touch a block as it arrives and it plays its note, so hitting them all performs the song. Block height follows pitch. It has 18 public-domain songs, each with its own instrument (Twinkle Twinkle, Frère Jacques, Ode to Joy, Amazing Grace, Greensleeves, Minuet in G, Für Elise, Korobeiniki, Hall of the Mountain King, and more), defined in `web/js/songs.js` in a simple text notation. Difficulty sets the tempo; Hard and Expert add bombs and require the matching saber colour.
- **Hole in the Wall**: walls fly at you with a body-shaped hole cut out. Strike the pose, step sideways, or crouch to fit. Your glowing silhouette turns green or red as the wall approaches, and the fit has to match both the hole and the pose.
- **Whack-a-Mole**: moles pop up at fixed spots across the camera view (move your body to reach them), drawn over your live image; your hands are the mallets. Gold moles score extra; bombs cost points. 60 seconds.
- **Star Gunner (beta)**: first-person gun turret on a starship. Hold your hands together to fire (infinite ammo); where your joined hands are relative to your chest aims the gun. Endless waves of asteroids (big ones split), alien drones and plasma-firing saucers, with bloom, a procedural nebula and a gas giant.
- **Joint Viewer**: your camera with the detected skeleton, hands, per-joint confidence, and latency stats.

Menus are hands-free: hover a hand over a button to select it. The cursor follows your hand (MediaPipe hand tracking), so it keeps working even when your hand hides your forearm. Esc pauses; walking out of frame auto-pauses.

## Running

```bash
conda create -n posearcade python=3.12 -y && conda activate posearcade
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu130   # match your CUDA
pip install -r requirements.txt
pip install --no-deps mediapipe absl-py flatbuffers   # hand tracking
./run.sh
```

The first run downloads the pose and hand models and creates a self-signed TLS certificate in `certs/`.

Then, on any device on the same network, open:

```
https://<gpu-machine-LAN-IP>:8600
```

Browsers only allow camera access on HTTPS pages. Because the certificate is self-signed, you'll see a warning the first time. Choose **Advanced → Proceed** once.

Settings (environment variables):

| var | default | |
|---|---|---|
| `POSE_MODEL` | `yolo11l-pose.pt` | `yolo11s/m/l/x-pose.pt` |
| `POSE_IMGSZ` | `640` | inference size; 480 is a bit faster |
| `PORT` | `8600` | |

## Windows app (one installer, everything runs on your PC)

Download **Unbound-Setup.exe** from the [`windows-latest` release](../../releases/tag/windows-latest), run it, and play. It installs per user, so there is no admin prompt, and adds a Start menu and desktop shortcut.

- **Nothing else to install.** The installer bundles Python, the pose and hand models, the CUDA 12 runtime with cuDNN, and ONNX Runtime. The PC only needs its normal GPU driver.
- **GPU picked automatically.** On first launch it reads the NVIDIA driver through NVML and tries each engine in a separate process, keeping the fastest one that works:
  1. **CUDA**: NVIDIA GPU with a driver from 2023 or newer (528+). An RTX 3050 or better is recommended.
  2. **DirectML**: any DirectX 12 GPU, and NVIDIA cards whose driver is too old for CUDA 12 (the start screen tells you to update).
  3. **CPU**: uses the small pose model so it stays playable.

  If the big model is slower than 45 ms a frame, it switches to the small one. The choice is cached in `%LOCALAPPDATA%\Unbound\engine.json` and redone after a driver or app update.
- **One window.** Games open in a chromeless Chrome or Edge window on `http://127.0.0.1`, and camera access is granted automatically. Closing the window quits the app.
- Windows SmartScreen may warn because the installer isn't code-signed. Click **More info → Run anyway**.
- Logs: `%LOCALAPPDATA%\Unbound\unbound.log`. Useful flags for `Unbound.exe`:
  - `--reprobe` picks the GPU engine again.
  - `--backend cuda|dml|cpu` forces an engine.
  - `--selftest` checks the install.

**Building the installer.** Every push to the `windows` branch builds it on GitHub Actions ([`.github/workflows/windows.yml`](.github/workflows/windows.yml)) and publishes the release. Before publishing, the workflow:
  - installs the build silently;
  - checks that the CUDA libraries load;
  - self-tests the engine and hand tracker;
  - plays every game in Chrome with a fake webcam.

To build locally on Windows, you need Python 3.12, the Visual Studio 2022 C++ tools and Inno Setup 6. Run `powershell -ExecutionPolicy Bypass -File windows\build.ps1 -Version 1.0.0`.

## Tips

- Stand back so your head, shoulders, and both arms (fully raised) stay in frame.
- Body coordinates are normalized to your shoulder width, so distance from the camera doesn't matter much.
- On a GB10, inference is about 5–15 ms. Most of the latency is network plus JPEG encoding, typically 30–60 ms round trip on Wi-Fi.

## Layout

```
server.py            FastAPI + WebSocket pose server (newest-frame-wins, one shared GPU model)
engine.py            pose backends: PyTorch (Spark) and ONNX Runtime CUDA/DirectML/CPU (Windows)
windows/             Windows app: launcher (unbound.py, launcher/), GPU detection, build + installer scripts, tests
web/index.html       UI shell
web/js/pose.js       camera capture, streaming, One Euro smoothing, body coordinate frame
web/js/audio.js      WebAudio instrument voices, chord backing, SFX
web/js/songs.js      melodies + chords in text notation, parser
web/js/main.js       menus, hand-hover selection, game loop, pause/results
web/js/games/        saber.js (Beat Slicer), wall.js (Hole in the Wall), mole.js (Whack-a-Mole), shooter.js (Star Gunner), viewer.js (Joint Viewer)
web/vendor/          three.js r169 + bloom postprocessing addons (MIT)
```
