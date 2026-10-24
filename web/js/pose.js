// Camera capture -> Spark pose server -> smoothed, mirrored body tracking.
//
// Coordinate spaces exposed to games:
//   screen: mirrored camera image, x in [0,1] left->right, y in [0,1] top->bottom
//   body:   origin at the shoulder midpoint, x right, y up, 1 unit = shoulder width
//           (so games play the same whether you stand 1.5m or 4m from the camera)

export const KP = {
  nose: 0, leftEye: 1, rightEye: 2, leftEar: 3, rightEar: 4,
  leftShoulder: 5, rightShoulder: 6, leftElbow: 7, rightElbow: 8,
  leftWrist: 9, rightWrist: 10, leftHip: 11, rightHip: 12,
  leftKnee: 13, rightKnee: 14, leftAnkle: 15, rightAnkle: 16,
};
export const BONES = [
  [5, 6], [5, 7], [7, 9], [6, 8], [8, 10], [5, 11], [6, 12], [11, 12],
  [11, 13], [13, 15], [12, 14], [14, 16], [0, 5], [0, 6],
];

// One Euro filter (Casiez et al.): low jitter when still, low lag when moving fast.
class OneEuro {
  constructor(minCutoff = 1.2, beta = 0.02, dCutoff = 1.0) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.x = null; this.dx = 0; this.t = 0;
  }
  static alpha(cutoff, dt) { const r = 2 * Math.PI * cutoff * dt; return r / (r + 1); }
  filter(x, t) {
    if (this.x === null || t - this.t > 0.5) { this.x = x; this.dx = 0; this.t = t; return x; }
    const dt = Math.max(1e-3, t - this.t); this.t = t;
    const dx = (x - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (x - this.x);
    return this.x;
  }
}

export class PoseClient {
  constructor() {
    this.video = document.createElement('video');
    this.video.playsInline = true; this.video.muted = true;
    this.grab = document.createElement('canvas');
    this.ws = null; this.pending = new Map();
    this.maxInflight = 2; this.sendWidth = 640; this.quality = 0.72;
    this.stats = { latency: 0, infer: 0, fps: 0, connected: false, camera: false };
    this._fpsCount = 0; this._fpsT = performance.now();
    this.listeners = new Set();
    this.aspect = 16 / 9;
    this.handsOn = true;
  }

  // Hand tracking costs CPU on the Spark; games that don't need it switch it off.
  setHands(on) {
    this.handsOn = on;
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ hands: on }));
  }

  async startCamera(deviceId) {
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    const video = deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } }
      : { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } };
    this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.aspect = this.video.videoWidth / this.video.videoHeight;
    this.stats.camera = true;
    this._pump();
  }

  static async listCameras() {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter(d => d.kind === 'videoinput');
  }

  connect(url) {
    url = url || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { this.stats.connected = true; this.pending.clear(); ws.send(JSON.stringify({ hands: this.handsOn })); };
    ws.onclose = () => {
      this.stats.connected = false;
      if (this.ws === ws) setTimeout(() => this.connect(url), 1000);
    };
    ws.onmessage = (e) => this._onResult(JSON.parse(e.data));
    this.ws = ws;
  }

  _pump() {
    const v = this.video;
    const onFrame = () => {
      this._maybeSend();
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(onFrame);
      else requestAnimationFrame(onFrame);
    };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(onFrame);
    else requestAnimationFrame(onFrame);
  }

  _maybeSend() {
    const now = performance.now();
    // Server drops stale frames silently, so expire anything old.
    for (const [ts] of this.pending) if (now - ts > 600) this.pending.delete(ts);
    if (!this.ws || this.ws.readyState !== 1 || this.pending.size >= this.maxInflight) return;
    if (this.ws.bufferedAmount > 256 * 1024) return;
    const v = this.video;
    if (!v.videoWidth) return;
    const w = this.sendWidth, h = Math.round(w * v.videoHeight / v.videoWidth);
    if (this.grab.width !== w) { this.grab.width = w; this.grab.height = h; }
    this.grab.getContext('2d').drawImage(v, 0, 0, w, h);
    const ts = now;
    this.pending.set(ts, true);
    this.grab.toBlob(async (blob) => {
      if (!blob) { this.pending.delete(ts); return; }
      const jpg = new Uint8Array(await blob.arrayBuffer());
      const buf = new Uint8Array(8 + jpg.length);
      new DataView(buf.buffer).setFloat64(0, ts, true);
      buf.set(jpg, 8);
      if (this.ws && this.ws.readyState === 1) this.ws.send(buf);
      else this.pending.delete(ts);
    }, 'image/jpeg', this.quality);
  }

  _onResult(msg) {
    const now = performance.now();
    for (const [ts] of this.pending) if (ts <= msg.t) this.pending.delete(ts);
    const lat = now - msg.t;
    this.stats.latency += (lat - this.stats.latency) * 0.1;
    this.stats.infer += (msg.ms - this.stats.infer) * 0.1;
    this._fpsCount++;
    if (now - this._fpsT > 1000) {
      this.stats.fps = this._fpsCount * 1000 / (now - this._fpsT);
      this._fpsCount = 0; this._fpsT = now;
    }
    for (const fn of this.listeners) fn(msg);
  }

  onPose(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
}

// Smoothed single-player body state with prediction to cover network latency.
export class Body {
  constructor(client) {
    this.client = client;
    this.fx = KP_FILTERS(); this.fy = KP_FILTERS();
    this.pts = Array.from({ length: 17 }, () => ({ x: 0.5, y: 0.5, vx: 0, vy: 0, c: 0, seen: -1e9 }));
    this.present = false; this.lastSeen = -1e9; this.lastT = 0;
    // Hands from the dedicated hand tracker (palm centre), per side.
    this.hands = { L: { x: 0.5, y: 0.5, vx: 0, vy: 0, seen: -1e9 }, R: { x: 0.5, y: 0.5, vx: 0, vy: 0, seen: -1e9 } };
    this.hf = { L: [new OneEuro(1.5, 2.0), new OneEuro(1.5, 2.0)], R: [new OneEuro(1.5, 2.0), new OneEuro(1.5, 2.0)] };
    this.rawHands = [];
    this.center = null; this.scale = null; // body frame, in screen units (x scaled by aspect)
    this.frameLocked = false;
    this.predict = 0.6; // fraction of measured latency to extrapolate (0 = off)
    client.onPose((m) => this._update(m));
  }

  _update(msg) {
    const t = msg.t / 1000; // capture time, seconds
    const p = msg.people[0];
    if (!p) { this.present = performance.now() - this.lastSeen < 400 && this.present; return; }
    this.lastSeen = performance.now(); this.present = true; this.lastT = t;
    for (let i = 0; i < 17; i++) {
      const [x, y, c] = p.kp[i];
      const pt = this.pts[i];
      pt.c = c;
      if (c < 0.3) continue;
      const mx = 1 - x; // mirror so it feels like a mirror
      const nx = this.fx[i].filter(mx, t), ny = this.fy[i].filter(y, t);
      pt.x = nx; pt.y = ny; pt.vx = this.fx[i].dx; pt.vy = this.fy[i].dx; pt.seen = t;
    }
    this._updateFrame();
    if (msg.hands) this._updateHands(msg.hands, p, msg.ht / 1000);
  }

  // Match detected hands to the player's left/right using where the pose
  // expects each hand to be (wrist pushed a bit past the forearm).
  _updateHands(hands, person, t) {
    const [bx1, by1, bx2, by2] = person.box, padX = (bx2 - bx1) * 0.6, padY = (by2 - by1) * 0.3;
    const cand = hands.filter(h => h.palm[0] > bx1 - padX && h.palm[0] < bx2 + padX && h.palm[1] > by1 - padY && h.palm[1] < by2 + padY)
      .map(h => ({ x: 1 - h.palm[0], y: h.palm[1], tip: [1 - h.tip[0], h.tip[1]] }));
    this.rawHands = cand;
    const expect = {};
    for (const [side, w, e] of [['L', KP.leftWrist, KP.leftElbow], ['R', KP.rightWrist, KP.rightElbow]]) {
      const W = this.pts[w], E = this.pts[e];
      if (W.c >= 0.3) expect[side] = E.c >= 0.3 ? { x: W.x + (W.x - E.x) * 0.35, y: W.y + (W.y - E.y) * 0.35 } : { x: W.x, y: W.y };
    }
    const a = this.client.aspect;
    const cost = (h, side) => {
      const ex = expect[side];
      if (ex) return Math.hypot((h.x - ex.x) * a, h.y - ex.y);
      // no wrist: player's left hand shows on the left of the mirror
      const ls = this.pts[KP.leftShoulder], rs = this.pts[KP.rightShoulder], mid = (ls.x + rs.x) / 2;
      return (side === 'L') === (h.x < mid) ? 0.3 : 1;
    };
    let assign = {};
    if (cand.length === 1) {
      assign[cost(cand[0], 'L') <= cost(cand[0], 'R') ? 'L' : 'R'] = cand[0];
    } else if (cand.length >= 2) {
      const [h0, h1] = cand;
      assign = cost(h0, 'L') + cost(h1, 'R') <= cost(h0, 'R') + cost(h1, 'L') ? { L: h0, R: h1 } : { L: h1, R: h0 };
    }
    for (const side of ['L', 'R']) {
      const h = assign[side]; if (!h) continue;
      // a hand far from where that arm can reach is probably someone else's
      const ex = expect[side];
      if (ex && Math.hypot((h.x - ex.x) * a, h.y - ex.y) > (this.scale || 0.3) * 1.6) continue;
      const st = this.hands[side];
      st.x = this.hf[side][0].filter(h.x, t); st.y = this.hf[side][1].filter(h.y, t);
      st.vx = this.hf[side][0].dx; st.vy = this.hf[side][1].dx; st.seen = t; st.tip = h.tip;
    }
  }

  // Hand position (screen space). Uses the hand tracker when it has the hand,
  // otherwise falls back to the wrist estimate from the pose.
  handScreen(side) {
    const st = this.hands[side];
    if (this.lastT - st.seen < 0.25) {
      const ahead = Math.min(0.12, this.client.stats.latency / 1000) * this.predict;
      return { x: st.x + st.vx * ahead, y: st.y + st.vy * ahead, ok: true, src: 'hand' };
    }
    const w = this.screen(side === 'L' ? KP.leftWrist : KP.rightWrist), e = this.screen(side === 'L' ? KP.leftElbow : KP.rightElbow);
    if (!w.ok) return { x: 0, y: 0, ok: false };
    return e.ok ? { x: w.x + (w.x - e.x) * 0.35, y: w.y + (w.y - e.y) * 0.35, ok: true, src: 'wrist' } : { ...w, src: 'wrist' };
  }

  // Hand position in body space.
  handBody(side) {
    const s = this.handScreen(side);
    if (!s.ok || !this.center) return { x: 0, y: 0, ok: false };
    const a = this.client.aspect;
    return { x: (s.x * a - this.center.x) / this.scale, y: (this.center.y - s.y) / this.scale, ok: true, src: s.src };
  }

  _updateFrame() {
    const ls = this.pts[KP.leftShoulder], rs = this.pts[KP.rightShoulder];
    if (ls.c < 0.4 || rs.c < 0.4) return;
    const a = this.client.aspect;
    const cx = (ls.x + rs.x) / 2 * a, cy = (ls.y + rs.y) / 2;
    let sw = Math.hypot((ls.x - rs.x) * a, ls.y - rs.y);
    // Turned sideways the shoulders collapse; fall back to torso length.
    const lh = this.pts[KP.leftHip], rh = this.pts[KP.rightHip];
    if (lh.c > 0.4 && rh.c > 0.4) {
      const torso = Math.hypot(((lh.x + rh.x) / 2) * a - cx, (lh.y + rh.y) / 2 - cy);
      sw = Math.max(sw, torso * 0.72);
    }
    if (!this.center) { this.center = { x: cx, y: cy }; this.scale = sw; return; }
    const kc = this.frameLocked ? 0.04 : 0.15, ks = this.frameLocked ? 0.01 : 0.1;
    this.center.x += (cx - this.center.x) * kc;
    this.center.y += (cy - this.center.y) * kc;
    this.scale += (sw - this.scale) * ks;
  }

  // Predicted screen-space point (mirrored, 0..1) at "now".
  screen(i) {
    const pt = this.pts[i];
    const ahead = Math.min(0.12, (this.client.stats.latency / 1000)) * this.predict;
    return { x: pt.x + pt.vx * ahead, y: pt.y + pt.vy * ahead, c: pt.c, ok: pt.c >= 0.3 && this.lastT - pt.seen < 0.35 };
  }

  // Body-space point: shoulder-centered, y-up, shoulder-width units.
  body(i) {
    const s = this.screen(i);
    if (!this.center) return { x: 0, y: 0, ok: false };
    const a = this.client.aspect;
    return { x: (s.x * a - this.center.x) / this.scale, y: (this.center.y - s.y) / this.scale, ok: s.ok };
  }

  // Angle (deg, screen space, y-up, 0 = pointing right) of the segment a->b.
  angle(a, b) {
    const p = this.screen(a), q = this.screen(b), asp = this.client.aspect;
    return { deg: Math.atan2(-(q.y - p.y), (q.x - p.x) * asp) * 180 / Math.PI, ok: p.ok && q.ok };
  }
}

function KP_FILTERS() {
  // Wrists/elbows need to be fast (sabers); face/torso can be calmer.
  return Array.from({ length: 17 }, (_, i) =>
    (i >= 7 && i <= 10) ? new OneEuro(1.7, 3.0) : new OneEuro(1.0, 1.0));
}
