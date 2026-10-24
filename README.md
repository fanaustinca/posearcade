# Pose Arcade

Full-body motion games in the browser, powered by GPU pose estimation on a separate machine.

Your laptop or phone captures the camera and streams small JPEG frames over a WebSocket to a GPU box (built for an NVIDIA DGX Spark / GB10). The box runs YOLO11-pose and sends back 17 body keypoints per frame. The browser smooths them (One Euro filter), predicts ahead to hide network latency, and drives the games.

## Games

- **Beat Slicer**: a Beat Saber–style rhythm game where **every block is a note**. Your forearms become lightsabers (red = left, blue = right); touch a block as it arrives and it plays its note, so hitting them all performs the song. Block height follows pitch. There are nine public-domain songs, each with its own instrument: Twinkle Twinkle, Mary Had a Little Lamb, Ode to Joy, Jingle Bells, Happy Birthday, Canon in D, Für Elise, Korobeiniki (Tetris), and Hall of the Mountain King. Difficulty sets the tempo; Hard and Expert add bombs and require the matching saber colour. Songs live in `web/js/songs.js` in a simple text notation, so adding more is easy.
- **Test: Easy Slicer**: Beat Slicer slowed right down. Sparse blocks, no bombs, can't fail.
- **Joint Viewer**: your camera with the detected skeleton, per-joint confidence, and latency stats.

Menus are hands-free: hover a hand over a button to select it. Esc pauses; walking out of frame auto-pauses.

## Running

```bash
conda create -n posearcade python=3.12 -y && conda activate posearcade
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu130   # match your CUDA
pip install -r requirements.txt
./run.sh
```

The first run downloads the pose model and creates a self-signed TLS certificate in `certs/`.

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

## Tips

- Stand back so your head, shoulders, and both arms (fully raised) stay in frame.
- Body coordinates are normalized to your shoulder width, so distance from the camera doesn't matter much.
- On a GB10, inference is about 5–15 ms. Most of the latency is network plus JPEG encoding, typically 30–60 ms round trip on Wi-Fi.

## Layout

```
server.py            FastAPI + WebSocket pose server (newest-frame-wins, one shared GPU model)
web/index.html       UI shell
web/js/pose.js       camera capture, streaming, One Euro smoothing, body coordinate frame
web/js/audio.js      WebAudio instrument voices, chord backing, SFX
web/js/songs.js      melodies + chords in text notation, parser
web/js/main.js       menus, hand-hover selection, game loop, pause/results
web/js/games/        saber.js (Beat Slicer), viewer.js (Joint Viewer)
web/vendor/          three.js r169 (MIT)
```
