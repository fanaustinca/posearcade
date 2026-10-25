import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ctx as audio, sfxBus } from '../audio.js';
import { KP } from '../pose.js';

// Tennis: you're the near player in a floodlit stadium, seen from behind.
// Your player runs to the ball on its own; you swing your arm to hit.
// Swing speed = power, sideways swing + timing = direction (early goes
// cross-court, late goes down the line), an upward swing lobs.
// Court in metres: you at +z, the CPU at -z, x to your right.
const HL = 11.885, HW = 4.115, DW = 5.485, SL = 6.40, NET_C = 0.914, NET_P = 1.07, POST_X = 6.4;
const BALL_R = 0.033, G = 9.81;
const netHeight = (x) => NET_C + (NET_P - NET_C) * Math.min(1, (x / POST_X) ** 2);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);

// aiSpeed m/s, aiReach m, aiErr = chance a CPU shot misses, pace = CPU ball speed m/s,
// aim 0 (straight back at you) .. 1 (corners), swing = hand speed (shoulder widths/s)
// that counts as a swing, win = timing window (s) either side of the ideal contact,
// hold = how long a swing stays "live", assist 1 = your shots always land in,
// run/reach = how fast your player runs and how far your racket reaches (m).
export const TENNIS_DIFFS = {
  Novice:       { games: 2, aiSpeed: 3.0, aiReach: 1.5,  aiErr: 0.22,  pace: 10,   aim: 0.0,  swing: 2.0, win: 0.32, hold: 0.55, assist: 1.0,  run: 9.0, reach: 2.0,  marker: true },
  Beginner:     { games: 3, aiSpeed: 3.8, aiReach: 1.45, aiErr: 0.15,  pace: 12.5, aim: 0.25, swing: 2.4, win: 0.26, hold: 0.45, assist: 0.95, run: 8.0, reach: 1.85, marker: true },
  Intermediate: { games: 3, aiSpeed: 4.8, aiReach: 1.4,  aiErr: 0.10,  pace: 15.5, aim: 0.5, swing: 2.8, win: 0.21, hold: 0.38, assist: 0.8,  run: 6.0, reach: 1.7,  marker: true },
  Advanced:     { games: 3, aiSpeed: 5.8, aiReach: 1.35, aiErr: 0.07,  pace: 18.5, aim: 0.68,  swing: 3.2, win: 0.17, hold: 0.32, assist: 0.6,  run: 5.3, reach: 1.6,  marker: false },
  Expert:       { games: 3, aiSpeed: 6.8, aiReach: 1.3,  aiErr: 0.05,  pace: 21.5, aim: 0.8, swing: 3.6, win: 0.14, hold: 0.27, assist: 0.45, run: 4.8, reach: 1.5,  marker: false },
  Master:       { games: 3, aiSpeed: 7.8, aiReach: 1.25, aiErr: 0.03,  pace: 24.5, aim: 0.9, swing: 4.0, win: 0.11, hold: 0.23, assist: 0.3,  run: 4.5, reach: 1.4,  marker: false },
  Grandmaster:  { games: 3, aiSpeed: 9.0, aiReach: 1.25, aiErr: 0.018, pace: 28,   aim: 1.0,  swing: 4.4, win: 0.09, hold: 0.2,  assist: 0.15, run: 4.3, reach: 1.35, marker: false },
};
const CALLS = ['Love', 'Fifteen', 'Thirty', 'Forty'];
// a relaxed swing is ~6 shoulder widths/s, a full-speed one 18+
const swingPower = (speed) => clamp((speed - 3) / 15, 0, 1);

// Launch velocity that lands the ball at (tx, tz) travelling at ~speed m/s,
// raising the arc until it clears the net by `clear` metres (negative = into the net).
function plan(p, tx, tz, speed, spin, clear) {
  const g = G + spin, dx = tx - p.x, dz = tz - p.z, dist = Math.hypot(dx, dz);
  let T = Math.max(0.25, dist / speed), v = null;
  for (let i = 0; i < 60; i++) {
    const vy = (BALL_R - p.y + 0.5 * g * T * T) / T;
    v = { x: dx / T, y: vy, z: dz / T };
    const tn = -p.z / v.z;
    if (tn > 0 && tn < T) {
      const x = p.x + v.x * tn, y = p.y + vy * tn - 0.5 * g * tn * tn;
      if (y < netHeight(x) + BALL_R + clear) { T *= 1.05; continue; }
    }
    break;
  }
  return v;
}

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function glowTexture() {
  return canvasTex(128, 128, (g) => {
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.3, 'rgba(255,255,255,.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  });
}

// ---------- the stadium ----------
function makeCourt(maxAniso) {
  // 18 x 36 m painted area, 112 px per metre
  const PX = 112, W = 18, L = 36;
  const tex = canvasTex(W * PX, L * PX, (g, w, h) => {
    const X = (x) => (x + W / 2) * PX, Z = (z) => (z + L / 2) * PX;
    g.fillStyle = '#2d6a4d'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#2a5ea8'; g.fillRect(X(-DW), Z(-HL), DW * 2 * PX, HL * 2 * PX);
    // acrylic texture: fine speckle
    const img = g.getImageData(0, 0, w, h), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const n = (Math.random() - 0.5) * 14; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
    g.putImageData(img, 0, 0);
    g.fillStyle = '#f4f6fb';
    const line = (x1, z1, x2, z2, wd = 0.05) => {
      if (x1 === x2) g.fillRect(X(x1) - wd * PX / 2, Z(z1), wd * PX, (z2 - z1) * PX);
      else g.fillRect(X(x1), Z(z1) - wd * PX / 2, (x2 - x1) * PX, wd * PX);
    };
    for (const s of [-1, 1]) {
      line(-DW, s * HL, DW, s * HL, 0.1);                 // baselines
      line(s * DW, -HL, s * DW, HL); line(s * HW, -HL, s * HW, HL); // side lines
      line(-HW, s * SL, HW, s * SL);                      // service lines
      line(0, s * HL - (s > 0 ? 0.1 : 0), 0, s * HL + (s > 0 ? 0 : 0.1), 0.05); // centre marks
    }
    line(0, -SL, 0, SL);                                  // centre service line
    g.fillRect(X(-0.05), Z(HL - 0.2), 0.1 * PX, 0.2 * PX); g.fillRect(X(-0.05), Z(-HL), 0.1 * PX, 0.2 * PX);
    // painted name behind each baseline
    g.save(); g.fillStyle = 'rgba(255,255,255,.16)'; g.font = `900 ${1.5 * PX}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('UNBOUND', X(0), Z(HL + 3)); g.translate(X(0), Z(-HL - 3)); g.rotate(Math.PI); g.fillText('UNBOUND', 0, 0); g.restore();
  });
  tex.anisotropy = maxAniso;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(W, L), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.82, metalness: 0 }));
  m.rotation.x = -Math.PI / 2; m.receiveShadow = true;
  return m;
}

function makeNet() {
  const grp = new THREE.Group();
  const netTex = canvasTex(256, 32, (g, w, h) => {
    g.clearRect(0, 0, w, h); g.strokeStyle = 'rgba(20,20,24,.9)'; g.lineWidth = 2;
    for (let x = 0; x <= w; x += 8) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    for (let y = 0; y <= h; y += 8) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  });
  netTex.wrapS = netTex.wrapT = THREE.RepeatWrapping; netTex.repeat.set(36, 3);
  const span = POST_X * 2, geo = new THREE.PlaneGeometry(span, 1, 64, 1), pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {   // sag: top edge follows the net height
    const x = pos.getX(i), top = pos.getY(i) > 0;
    pos.setY(i, top ? netHeight(x) : 0.0);
  }
  geo.computeVertexNormals();
  const net = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: netTex, transparent: true, alphaTest: 0.2, side: THREE.DoubleSide, roughness: 1 }));
  net.castShadow = true; grp.add(net);
  const band = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(
    Array.from({ length: 17 }, (_, i) => { const x = -POST_X + i * span / 16; return new THREE.Vector3(x, netHeight(x) - 0.03, 0); })), 64, 0.035, 6),
  new THREE.MeshStandardMaterial({ color: 0xf5f5f5, roughness: 0.6 }));
  band.castShadow = true; grp.add(band);
  const strap = new THREE.Mesh(new THREE.BoxGeometry(0.05, NET_C, 0.02), new THREE.MeshStandardMaterial({ color: 0xf5f5f5 }));
  strap.position.y = NET_C / 2; grp.add(strap);
  const postMat = new THREE.MeshStandardMaterial({ color: 0x1c3b2c, metalness: 0.6, roughness: 0.35 });
  for (const s of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, NET_P + 0.04, 16), postMat);
    post.position.set(s * POST_X, (NET_P + 0.04) / 2, 0); post.castShadow = true; grp.add(post);
  }
  return grp;
}

function makeSky() {
  const geo = new THREE.SphereGeometry(500, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `varying vec3 vP;
      float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,45.164))) * 43758.5453); }
      void main(){
        float y = vP.y;
        vec3 top = vec3(0.012,0.018,0.06), mid = vec3(0.05,0.05,0.16), hor = vec3(0.30,0.16,0.36);
        vec3 c = mix(mid, top, smoothstep(0.05, 0.6, y));
        c = mix(hor, c, smoothstep(-0.02, 0.18, y));
        vec3 q = floor(vP * 260.0);
        float s = step(0.9965, h(q)) * smoothstep(0.1, 0.4, y);
        c += vec3(s) * (0.6 + 0.4 * h(q + 3.0));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  return new THREE.Mesh(geo, mat);
}

function adBoardTexture() {
  const t = canvasTex(2048, 96, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, w, 0);
    gr.addColorStop(0, '#0a1b4a'); gr.addColorStop(0.5, '#152a7a'); gr.addColorStop(1, '#0a1b4a');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.font = '900 58px system-ui, sans-serif'; g.textBaseline = 'middle';
    const words = ['UNBOUND', '● GRAND SLAM', 'UNBOUND', '● MOVE TO PLAY', 'UNBOUND', '● ACE!'];
    let x = 30;
    for (const wd of words) { g.fillStyle = wd.startsWith('●') ? '#7fe3ff' : '#ffffff'; g.fillText(wd, x, h / 2 + 3); x += g.measureText(wd).width + 60; }
  });
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

// low-poly tennis player; arms are re-posed every frame
function makePlayer(shirt, shorts, skin, hair) {
  const P = new THREE.Group();
  const mat = (c, r = 0.7) => new THREE.MeshStandardMaterial({ color: c, roughness: r });
  const mShirt = mat(shirt, 0.65), mShorts = mat(shorts), mSkin = mat(skin, 0.55), mShoe = mat(0xf2f2f2, 0.5), mHair = mat(hair, 0.9);
  const add = (geo, m, x, y, z, parent = P) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.castShadow = true; parent.add(o); return o; };
  add(new THREE.CapsuleGeometry(0.2, 0.42, 6, 14), mShirt, 0, 1.2, 0).scale.set(1, 1, 0.72);
  add(new THREE.CylinderGeometry(0.2, 0.22, 0.25, 14), mShorts, 0, 0.87, 0).scale.set(1, 1, 0.75);
  add(new THREE.CylinderGeometry(0.05, 0.06, 0.1, 10), mSkin, 0, 1.55, 0);
  const head = add(new THREE.SphereGeometry(0.12, 20, 16), mSkin, 0, 1.69, 0);
  add(new THREE.SphereGeometry(0.125, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), mHair, 0, 0.02, 0.0, head).scale.set(1, 0.9, 1);
  const band = add(new THREE.TorusGeometry(0.118, 0.018, 8, 24), mat(0xffffff), 0, 0.03, 0, head); band.rotation.x = Math.PI / 2;
  P.legs = [];
  for (const s of [-1, 1]) {
    const hip = new THREE.Group(); hip.position.set(s * 0.1, 0.82, 0); P.add(hip);
    add(new THREE.CapsuleGeometry(0.075, 0.6, 4, 10), mSkin, 0, -0.38, 0, hip);
    add(new THREE.BoxGeometry(0.11, 0.08, 0.26), mShoe, 0, -0.78, -0.04, hip);
    P.legs.push(hip);
  }
  // arms: unit capsules stretched between shoulder and hand each frame
  P.arms = [-1, 1].map(() => { const a = add(new THREE.CapsuleGeometry(0.055, 1, 4, 10), mSkin, 0, 0, 0); return a; });
  P.shoulders = [new THREE.Vector3(-0.24, 1.42, 0), new THREE.Vector3(0.24, 1.42, 0)];
  return P;
}
function makeRacket(frameColor) {
  const R = new THREE.Group();
  const frame = new THREE.Mesh(new THREE.TorusGeometry(0.135, 0.014, 10, 40), new THREE.MeshStandardMaterial({ color: frameColor, roughness: 0.35, metalness: 0.4 }));
  frame.scale.set(0.8, 1, 1); frame.position.y = 0.42; frame.castShadow = true; R.add(frame);
  const strings = canvasTex(128, 128, (g, w, h) => {
    g.clearRect(0, 0, w, h); g.strokeStyle = 'rgba(240,240,220,.85)'; g.lineWidth = 1.5;
    for (let i = 4; i < w; i += 9) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, h); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(w, i); g.stroke(); }
  });
  const face = new THREE.Mesh(new THREE.CircleGeometry(0.133, 32), new THREE.MeshBasicMaterial({ map: strings, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
  face.scale.set(0.8, 1, 1); face.position.y = 0.42; R.add(face);
  const throat = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.016, 0.2, 8), frame.material);
  throat.position.y = 0.2; R.add(throat);
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.2, 10), new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 }));
  grip.position.y = 0.0; R.add(grip);
  return R;
}

// ---------- sound ----------
function env(g, t, a, peak, d) { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); }
let noiseBuf = null;
function noise() {
  if (!noiseBuf) { noiseBuf = audio.createBuffer(1, audio.sampleRate * 2, audio.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
  const n = audio.createBufferSource(); n.buffer = noiseBuf; return n;
}
const snd = {
  pock(vol = 1, pan = 0) {
    const t = audio.currentTime, p = audio.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); p.connect(sfxBus);
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.setValueAtTime(1100, t); o.frequency.exponentialRampToValueAtTime(380, t + 0.05);
    env(g, t, 0.001, 0.5 * vol, 0.07); o.connect(g).connect(p); o.start(t); o.stop(t + 0.1);
    const n = noise(), f = audio.createBiquadFilter(), ng = audio.createGain(); f.type = 'bandpass'; f.frequency.value = 2400; f.Q.value = 1.2;
    env(ng, t, 0.001, 0.7 * vol, 0.04); n.connect(f).connect(ng).connect(p); n.start(t); n.stop(t + 0.08);
  },
  bounce(vol = 1, pan = 0) {
    const t = audio.currentTime, p = audio.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); p.connect(sfxBus);
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.setValueAtTime(260, t); o.frequency.exponentialRampToValueAtTime(120, t + 0.06);
    env(g, t, 0.001, 0.35 * vol, 0.08); o.connect(g).connect(p); o.start(t); o.stop(t + 0.12);
  },
  whoosh(vol = 1) {
    const t = audio.currentTime, n = noise(), f = audio.createBiquadFilter(), g = audio.createGain();
    f.type = 'bandpass'; f.Q.value = 3; f.frequency.setValueAtTime(500, t); f.frequency.exponentialRampToValueAtTime(2200, t + 0.12); f.frequency.exponentialRampToValueAtTime(700, t + 0.25);
    env(g, t, 0.05, 0.22 * vol, 0.2); n.connect(f).connect(g).connect(sfxBus); n.start(t); n.stop(t + 0.3);
  },
  crowd(level = 1, dur = 2.2) {
    const t = audio.currentTime, n = noise(), f = audio.createBiquadFilter(), g = audio.createGain();
    n.loop = true; f.type = 'bandpass'; f.frequency.value = 900; f.Q.value = 0.4;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.32 * level, t + 0.25); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(f).connect(g).connect(sfxBus); n.start(t); n.stop(t + dur + 0.1);
    for (let i = 0; i < 40 * level; i++) {   // claps
      const tc = t + Math.random() * dur * 0.8, c = noise(), cf = audio.createBiquadFilter(), cg = audio.createGain();
      cf.type = 'bandpass'; cf.frequency.value = rand(1200, 2600); cf.Q.value = 2;
      env(cg, tc, 0.001, rand(0.05, 0.15) * level, 0.03); c.connect(cf).connect(cg).connect(sfxBus); c.start(tc); c.stop(tc + 0.05);
    }
  },
};
function say(text) {
  try {
    if (!window.speechSynthesis) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text); u.rate = 1.05; u.pitch = 0.95; u.volume = 0.85;
    speechSynthesis.speak(u);
  } catch { }
}

// ---------- the game ----------
export class TennisGame {
  constructor(app, opts = {}) {
    this.app = app;
    this.diffName = opts.diff in TENNIS_DIFFS ? opts.diff : 'Intermediate';
    this.D = TENNIS_DIFFS[this.diffName];
    this.time = 0;
    this.me = { x: 0.8, z: 12.6, tx: 0.8, tz: 12.6, racketSide: 1, swingAnim: 0, runPhase: 0 };
    this.ai = { x: -0.8, z: -12.6, tx: 0, tz: -12.6, swing: 0, runPhase: 0 };
    this.ball = { x: 0, y: 1, z: 12, vx: 0, vy: 0, vz: 0, spin: 0, live: false };
    this.hand = { L: this.newHand(), R: this.newHand() };
    this.swing = { active: 0, armed: true, speed: 0, vx: 0, vy: 0, side: 'R', t: -9 };
    this.points = [0, 0]; this.games = [0, 0]; this.server = 0; this.fault = false; // 0 = you, 1 = CPU
    this.stats = { pointsWon: 0, pointsLost: 0, aces: 0, winners: 0, rally: 0, longest: 0, fastest: 0, hits: 0 };
    this.message = null; this.prompt = ''; this.feedback = null; this.rallyCount = 0;
    this.trail = [];
    this.build();
  }
  newHand() { return { x: 0, y: 0, vx: 0, vy: 0, ok: false, last: null }; }

  build() {
    const r = this.app.renderer;
    this.prev = { tone: r.toneMapping, exp: r.toneMappingExposure, shadow: r.shadowMap.enabled, type: r.shadowMap.type };
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.0;
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    const scene = this.scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0b0c22, 70, 220);
    this.camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.1, 1200);
    scene.add(makeSky());
    this.glow = glowTexture();

    scene.add(new THREE.HemisphereLight(0xa8c4ff, 0x203020, 0.55));
    const key = new THREE.DirectionalLight(0xfff4e6, 2.6);
    key.position.set(-8, 30, 14); key.target.position.set(0, 0, 0);
    key.castShadow = true; key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -16, right: 16, top: 22, bottom: -22, near: 5, far: 70 });
    key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02;
    scene.add(key, key.target);
    const fill = new THREE.DirectionalLight(0xc8d8ff, 0.7); fill.position.set(10, 20, -16); scene.add(fill);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 100), new THREE.MeshStandardMaterial({ color: 0x1f4a37, roughness: 0.95 }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -0.01; ground.receiveShadow = true; scene.add(ground);
    scene.add(makeCourt(r.capabilities.getMaxAnisotropy()));
    scene.add(makeNet());
    this.buildStadium();

    // players
    this.meObj = makePlayer(0x2fa8ff, 0x1b1f2a, 0xe0b48f, 0x3a2416);
    this.aiObj = makePlayer(0xff3b5c, 0xf2f2f2, 0xc68a5e, 0x111111);
    this.aiObj.rotation.y = Math.PI;
    this.meRacket = makeRacket(0x2fa8ff); this.aiRacket = makeRacket(0xff3b5c);
    scene.add(this.meObj, this.aiObj, this.meRacket, this.aiRacket);

    // ball, its blob shadow and its trail
    const ballTex = canvasTex(256, 128, (g, w, h) => {
      g.fillStyle = '#d7f23a'; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#f7ffe0'; g.lineWidth = 7; g.beginPath();
      for (let x = 0; x <= w; x += 2) { const y = h / 2 + Math.sin(x / w * Math.PI * 4) * h * 0.28; x ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.stroke();
    });
    this.ballObj = new THREE.Mesh(new THREE.SphereGeometry(0.06, 24, 16),
      new THREE.MeshStandardMaterial({ map: ballTex, roughness: 0.75, emissive: 0x3a4a00, emissiveIntensity: 0.6 }));
    this.ballObj.castShadow = true; scene.add(this.ballObj);
    this.blob = new THREE.Mesh(new THREE.CircleGeometry(0.11, 20), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false }));
    this.blob.rotation.x = -Math.PI / 2; scene.add(this.blob);
    this.trailSprites = Array.from({ length: 14 }, (_, i) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: new THREE.Color(1.4, 2.0, 0.6), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }));
      s.scale.setScalar(0.22 * (1 - i / 16)); scene.add(s); return s;
    });
    // landing + contact guides for the easier levels
    const ringMat = (c) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.0, depthWrite: false, toneMapped: false });
    this.landRing = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.28, 32), ringMat(new THREE.Color(1.6, 1.8, 0.4)));
    this.hitRing = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 40), ringMat(new THREE.Color(0.4, 1.6, 2.2)));
    for (const m of [this.landRing, this.hitRing]) { m.rotation.x = -Math.PI / 2; m.position.y = 0.012; scene.add(m); }
    // swing streak behind your racket
    this.streak = [];

    this.composer = new EffectComposer(r);
    this.composer.addPass(new RenderPass(scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.5, 0.82);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  buildStadium() {
    const scene = this.scene;
    // perimeter walls with LED boards
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x0f1d3d, roughness: 0.8 });
    const adTex = adBoardTexture();
    const adMat = new THREE.MeshStandardMaterial({ map: adTex, emissiveMap: adTex, emissive: 0xffffff, emissiveIntensity: 1.3, roughness: 0.4 });
    this.adTex = adTex;
    const walls = [[0, -19, 22, 0], [0, 19, 22, Math.PI], [-11.5, 0, 38, Math.PI / 2], [11.5, 0, 38, -Math.PI / 2]];
    for (const [x, z, len, ry] of walls) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(len, 1.1, 0.3), wallMat);
      w.position.set(x, 0.55, z); w.rotation.y = ry; w.receiveShadow = true; scene.add(w);
      const ad = new THREE.Mesh(new THREE.PlaneGeometry(len - 0.4, 0.8), adMat);
      ad.position.set(x, 0.55, z); ad.rotation.y = ry;
      ad.translateZ(0.16); scene.add(ad);
    }
    // tiered stands on all four sides, filled with a crowd
    const tierMat = new THREE.MeshStandardMaterial({ color: 0x23263a, roughness: 0.9 });
    const seats = [];
    const ROWS = 9;
    const sides = [
      { len: 26, at: (d) => [0, -(20 + d)], ry: 0 }, { len: 26, at: (d) => [0, 20 + d], ry: Math.PI },
      { len: 42, at: (d) => [-(12.5 + d), 0], ry: Math.PI / 2 }, { len: 42, at: (d) => [12.5 + d, 0], ry: -Math.PI / 2 },
    ];
    for (const s of sides) {
      for (let row = 0; row < ROWS; row++) {
        const d = row * 0.95, h = 1.4 + row * 0.62;
        const [x, z] = s.at(d);
        const tier = new THREE.Mesh(new THREE.BoxGeometry(s.len + row * 2, h, 0.95), tierMat);
        tier.position.set(x, h / 2, z); tier.rotation.y = s.ry; scene.add(tier);
        const n = Math.floor((s.len + row * 2) / 0.62);
        for (let i = 0; i < n; i++) {
          if (Math.random() < 0.07) continue; // a few empty seats
          const along = -((s.len + row * 2) / 2) + (i + 0.5) * 0.62 + rand(-0.08, 0.08);
          const p = new THREE.Vector3(along, h, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), s.ry).add(new THREE.Vector3(x, 0, z));
          seats.push({ p, ry: s.ry, phase: Math.random() * Math.PI * 2, amp: rand(0.5, 1.2) });
        }
      }
    }
    const torsoGeo = new THREE.BoxGeometry(0.42, 0.5, 0.28), headGeo = new THREE.SphereGeometry(0.11, 10, 8);
    this.crowdBody = new THREE.InstancedMesh(torsoGeo, new THREE.MeshStandardMaterial({ roughness: 0.85 }), seats.length);
    this.crowdHead = new THREE.InstancedMesh(headGeo, new THREE.MeshStandardMaterial({ roughness: 0.7 }), seats.length);
    const shirts = [0xe63946, 0xf1faee, 0x457b9d, 0xffb703, 0x2a9d8f, 0xe76f51, 0x8338ec, 0xffffff, 0x1d3557, 0xff006e, 0x06d6a0, 0xfefae0];
    const skins = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac, 0x5c3a21];
    const c = new THREE.Color();
    seats.forEach((s, i) => {
      this.crowdBody.setColorAt(i, c.setHex(shirts[i % shirts.length]).offsetHSL(0, 0, rand(-0.08, 0.05)));
      this.crowdHead.setColorAt(i, c.setHex(skins[(i * 7) % skins.length]));
    });
    this.seats = seats;
    this.crowdExcite = 0;
    this.placeCrowd(0);
    scene.add(this.crowdBody, this.crowdHead);

    // floodlight towers: glowing lamp banks (they bloom) on tall masts
    const mastMat = new THREE.MeshStandardMaterial({ color: 0x3a3f55, metalness: 0.7, roughness: 0.4 });
    const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 4.8, 4.2), toneMapped: false });
    for (const [x, z, y] of [[-15, -31, 16], [15, -31, 16], [-17, 29, 24], [17, 29, 24]]) {
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.6, y, 10), mastMat);
      mast.position.set(x, y / 2, z); scene.add(mast);
      const head = new THREE.Group(); head.position.set(x, y + 0.5, z); head.lookAt(0, 0, 0); scene.add(head);
      const back = new THREE.Mesh(new THREE.BoxGeometry(5.4, 3.2, 0.4), mastMat); head.add(back);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
        const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.42, 16), lampMat);
        lamp.position.set(-1.95 + i * 1.3, -1 + j * 1.0, 0.21); head.add(lamp);
      }
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: 0xfff2d8, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
      halo.scale.setScalar(16); head.add(halo);
    }
    // umpire's chair
    const chairMat = new THREE.MeshStandardMaterial({ color: 0x1a4d36, roughness: 0.6 });
    const chair = new THREE.Group(); chair.position.set(-POST_X - 0.9, 0, 0);
    for (const [x, z] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.8, 6), chairMat); leg.position.set(x, 0.9, z); chair.add(leg);
    }
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.12, 0.8), chairMat); seat.position.y = 1.85; chair.add(seat);
    const ump = makePlayer(0x1d2b53, 0x1d2b53, 0xd9a066, 0x777777); ump.scale.setScalar(0.8); ump.position.y = 1.2; ump.rotation.y = Math.PI / 2;
    ump.arms.forEach((a, k) => { a.position.set(k ? 0.2 : -0.2, 1.05, 0.12); a.scale.set(1, 0.45, 1); a.rotation.x = 1.2; });
    ump.legs.forEach(l => l.rotation.x = -1.3);
    chair.add(ump); chair.traverse(o => { if (o.isMesh) o.castShadow = true; }); this.scene.add(chair);
  }

  placeCrowd(t) {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1), v = new THREE.Vector3();
    const ex = this.crowdExcite;
    this.seats.forEach((s, i) => {
      const jump = ex > 0 ? Math.max(0, Math.sin(t * 11 + s.phase)) * 0.22 * ex * s.amp : Math.sin(t * 1.3 + s.phase) * 0.012;
      q.setFromAxisAngle(up, s.ry);
      v.copy(s.p); v.y += 0.25 + jump; this.crowdBody.setMatrixAt(i, m.compose(v, q, one));
      v.y += 0.38; this.crowdHead.setMatrixAt(i, m.compose(v, q, one));
    });
    this.crowdBody.instanceMatrix.needsUpdate = true; this.crowdHead.instanceMatrix.needsUpdate = true;
  }

  start() {
    this.app.hud.el.classList.remove('on');
    this.resize();
    this.setupServe();
    snd.crowd(0.6, 2.5);
  }

  resize() {
    this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix();
    this.composer.setSize(innerWidth, innerHeight); this.bloom.setSize(innerWidth, innerHeight);
  }

  // ---------- input: wrist positions + swing detection ----------
  // Swings are read off the pose wrists (with the forearm extended a little),
  // not the hand tracker: it's on every frame, so speeds don't jump.
  readHands() {
    const body = this.app.body, out = {};
    for (const [side, w, e] of [['L', KP.leftWrist, KP.leftElbow], ['R', KP.rightWrist, KP.rightElbow]]) {
      const W = body.body(w), E = body.body(e), h = this.hand[side];
      h.ok = W.ok;
      if (W.ok) {
        const x = E.ok ? W.x + (W.x - E.x) * 0.35 : W.x, y = E.ok ? W.y + (W.y - E.y) * 0.35 : W.y;
        const seen = body.pts[w].seen;
        if (h.last && seen !== h.last.seen) {
          const dt = Math.max(0.012, seen - h.last.seen);
          const vx = (x - h.last.x) / dt, vy = (y - h.last.y) / dt;
          h.vx = h.vx * 0.35 + vx * 0.65; h.vy = h.vy * 0.35 + vy * 0.65;
        }
        if (!h.last || seen !== h.last.seen) h.last = { x, y, seen };
        h.x = x; h.y = y;
      } else { h.vx *= 0.8; h.vy *= 0.8; }
      out[side] = h;
    }
    return out;
  }

  updateSwing(dt) {
    const hands = this.readHands();
    const sw = this.swing, D = this.D;
    sw.active = Math.max(0, sw.active - dt);
    let best = null;
    for (const side of ['L', 'R']) {
      const h = hands[side]; if (!h.ok) continue;
      const sp = Math.hypot(h.vx, h.vy);
      if (!best || sp > best.speed) best = { side, speed: sp, vx: h.vx, vy: h.vy };
    }
    this.handSpeed = best ? best.speed : 0;
    if (!best) return;
    if (best.speed > D.swing && sw.armed) {
      Object.assign(sw, best, { active: D.hold, armed: false, t: this.time });
      this.me.racketSide = best.side === 'R' ? 1 : -1;
      this.me.swingAnim = 0.35;
      snd.whoosh(clamp(best.speed / (D.swing * 2), 0.4, 1.2));
      this.onSwing?.();
    } else if (sw.active > 0 && best.speed > sw.speed && best.side === sw.side) {
      sw.speed = best.speed; sw.vx = best.vx; sw.vy = best.vy;
    }
    if (!sw.armed && sw.active === 0 && best.speed < D.swing * 0.6) sw.armed = true;
  }

  // ---------- ball physics ----------
  stepBall(b, dt, events) {
    const g = G + b.spin;
    b.vy -= g * dt;
    const pz = b.z;
    b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
    if ((pz > 0) !== (b.z > 0) && !b.netted) {   // crossing the net plane
      if (Math.abs(b.x) < POST_X && b.y - BALL_R < netHeight(b.x)) {
        b.netted = true; b.z = pz > 0 ? 0.05 : -0.05; b.vz *= -0.12; b.vx *= 0.3; b.vy = Math.min(b.vy, 0) * 0.3;
        events?.push({ type: 'net' });
      }
    }
    if (b.y < BALL_R && b.vy < 0) {
      b.y = BALL_R; b.vy = -b.vy * 0.74; b.vx *= 0.86; b.vz *= 0.86 + Math.min(0.06, b.spin * 0.01); b.spin *= 0.4;
      if (b.vy < 0.4) b.vy = 0;
      events?.push({ type: 'bounce', x: b.x, z: b.z });
    }
  }

  // Where to meet the ball: after its bounce, as it drops back to about hip
  // height (or at the top of a low bounce), and no further back than 15.5 m.
  predictContact(dir) {
    const b = { ...this.ball }, ev = [];
    let bounce = null;
    for (let t = 0; t < 5; t += 1 / 120) {
      const vy0 = b.vy;
      this.stepBall(b, 1 / 120, ev);
      for (const e of ev) {
        if (e.type === 'net') return { net: true };
        if (e.type === 'bounce' && !bounce) bounce = { x: e.x, z: e.z, t };
      }
      ev.length = 0;
      if (!bounce || t - bounce.t < 0.05) continue;
      const here = { x: b.x, y: b.y, z: b.z, t, bounce }, depth = b.z * dir;
      if (depth >= 15.5) return here;                       // no further back than this
      if (depth >= 12.9 && b.y < 1.9) return here;          // take it around the baseline if it's at a hittable height
      if (vy0 > 0 && b.vy <= 0 && b.y < 1.6) return here;   // top of a low bounce
      if (b.vy < 0 && b.y <= 1.2) return here;              // dropping to hip height
    }
    return { bounce };
  }
  predictBounce() {
    const b = { ...this.ball }, events = [];
    for (let t = 0; t < 4; t += 1 / 120) {
      this.stepBall(b, 1 / 120, events);
      for (const e of events) if (e.type === 'bounce') return { x: e.x, z: e.z, t };
      events.length = 0;
    }
    return null;
  }

  launch(from, v, spin, hitter, speedKmh) {
    const b = this.ball;
    Object.assign(b, { x: from.x, y: from.y, z: from.z, vx: v.x, vy: v.y, vz: v.z, spin, live: true, netted: false });
    this.rally = { hitter, bounces: 0, serve: this.state === 'serve' };
    this.state = 'rally';
    this.stats.fastest = Math.max(this.stats.fastest, hitter === 0 ? speedKmh : 0);
    this.lastSpeed = { who: hitter, kmh: speedKmh, t: this.time };
    snd.pock(1, b.x / 6);
    this.spark(from);
    if (hitter === 0) {          // CPU decides where to go
      const bn = this.predictBounce(), at = this.predictContact(-1);
      const out = !bn || Math.abs(bn.x) > HW + 0.03 || bn.z < -HL - 0.03 || bn.z > 0;
      this.ai.plan = { zc: at.z ?? -12.5, out };
      this.ai.tz = this.ai.plan.zc - 0.5;
      this.ai.tx = at.x != null ? at.x - 0.6 : this.ai.x;  // CPU's racket is on its right = your +x
      this.ai.decided = false;
    } else {                     // auto-run you to the ball
      const bn = this.predictBounce(), at = this.predictContact(1);
      const zc = at.z ?? 12.4;
      this.me.contactZ = zc; this.me.tz = zc + 0.55;
      this.me.landing = bn; this.me.contact = at;
      if (at.x != null) {
        const side = this.hand.L.ok && this.hand.R.ok && this.hand.L.x < -1.2 && this.hand.R.x > -0.8 ? -1 : this.me.racketSide;
        this.me.tx = at.x - side * 0.75;
      }
      this.me.judged = false; this.me.swungEarly = false;
    }
  }

  // ---------- serving ----------
  setupServe() {
    const total = this.points[0] + this.points[1], deuce = total % 2 === 0;
    this.state = 'serve'; this.ball.live = false; this.rally = null; this.serveT = 0; this.tossing = false;
    this.ball.netted = false;
    if (this.server === 0) {
      const x = deuce ? 0.8 : -0.8;
      Object.assign(this.me, { x, tx: x, z: 12.3, tz: 12.3 });
      Object.assign(this.ai, { tx: deuce ? -2.6 : 2.6, tz: -12.6 });
      this.prompt = this.fault ? 'Second serve — swing!' : 'Your serve — swing when the ball is up!';
    } else {
      const x = deuce ? -0.8 : 0.8;
      Object.assign(this.ai, { x, tx: x, z: -12.3, tz: -12.3 });
      Object.assign(this.me, { tx: deuce ? 2.6 : -2.6, tz: 12.6 });
      this.prompt = '';
    }
    this.box = this.server === 0
      ? { x0: deuce ? -HW : 0, x1: deuce ? 0 : HW, z0: -SL, z1: 0 }
      : { x0: deuce ? 0 : -HW, x1: deuce ? HW : 0, z0: 0, z1: SL };  // the CPU's right is your left, so it serves to your right
  }

  updateServe(dt) {
    const b = this.ball;
    this.serveT += dt;
    if (this.server === 1) {               // CPU serve
      if (!this.tossing && this.serveT > 1.1) { this.toss(this.ai, -1); }
      if (this.tossing) {
        this.stepToss(dt);
        if (b.vy < 0 && b.y < 2.75) this.aiServe();
      }
      return;
    }
    if (!this.tossing && this.serveT > 0.7) this.toss(this.me, 1);
    if (this.tossing) {
      this.stepToss(dt);
      if (this.swing.active > 0 && b.y > 1.6) { this.playerServe(); return; }
      if (b.y < 0.9 && b.vy < 0) { this.tossing = false; this.serveT = 0.2; }
    }
  }
  toss(p, dir) {
    Object.assign(this.ball, { x: p.x + 0.25 * dir, y: 1.3, z: p.z - 0.35 * dir, vx: 0, vy: 5.6, vz: 0, spin: 0, live: true });
    this.tossing = true;
  }
  stepToss(dt) { const b = this.ball; b.vy -= G * dt; b.y += b.vy * dt; }

  playerServe() {
    const D = this.D, sw = this.swing, b = this.ball, box = this.box;
    sw.active = 0;
    const power = swingPower(sw.speed);
    const dirx = clamp(sw.vx / (sw.speed + 1e-6), -1, 1);
    let tx = lerp(box.x0 + 0.35, box.x1 - 0.35, 0.5 + dirx * 0.5);
    let tz = -SL + 0.7 + (1 - power) * 1.6;
    const err = (1 - D.assist) * (0.35 + Math.random() * 0.9);
    tx += rand(-1, 1) * err * 1.3; tz += rand(-0.6, 1) * err * 1.6;
    if (D.assist >= 0.75) { tx = clamp(tx, box.x0 + 0.25, box.x1 - 0.25); tz = clamp(tz, -SL + 0.3, -1.2); }
    const speed = 17 + power * 27;
    const v = plan(b, tx, tz, speed, 0, D.assist >= 0.75 ? 0.15 : lerp(-0.25, 0.2, Math.random()));
    this.stats.hits++;
    this.launch(b, v, 0, 0, Math.round(Math.hypot(v.x, v.y, v.z) * 3.6));
    this.prompt = '';
  }
  aiServe() {
    const D = this.D, b = this.ball, box = this.box;
    let tx = lerp(box.x0 + 0.3, box.x1 - 0.3, Math.random() < 0.5 ? rand(0, 0.25) : rand(0.75, 1));
    if (D.aim < 0.3) tx = (box.x0 + box.x1) / 2 + rand(-0.6, 0.6);
    let tz = SL - rand(0.4, 1.6);
    if (Math.random() < D.aiErr * 1.5 && !this.fault) tz = SL + rand(0.2, 0.8); // first-serve fault now and then
    const speed = D.pace * 1.25 * rand(0.9, 1.08);
    const v = plan(b, tx, tz, speed, 0, 0.12);
    this.ai.swing = 0.35;
    this.launch(b, v, 0, 1, Math.round(speed * 3.6));
  }

  // ---------- rally ----------
  playerHit(timing) {
    const D = this.D, sw = this.swing, b = this.ball;
    sw.active = 0;
    const speedN = swingPower(sw.speed);
    const ballSide = Math.sign(b.x - this.me.x) || 1;
    // sideways hand motion steers; an early hit pulls cross-court, a late one goes down the line
    const dirx = clamp(sw.vx / (sw.speed + 1e-6), -1, 1);
    let aim = clamp(dirx * 0.75 - ballSide * timing * 0.55, -1, 1);
    const lob = sw.vy / (sw.speed + 1e-6) > 0.8;
    let tx = aim * (HW - 0.55);
    let tz = lob ? -(HL - 1.2) : -(7.2 + speedN * 3.8);
    const err = (1 - D.assist) * (Math.abs(timing) * 1.1 + Math.random() * 0.45);
    tx += rand(-1, 1) * err * 2.2; tz += rand(-1, 1) * err * 2.6 - (Math.random() < 0.5 ? err * 1.2 : 0);
    if (D.assist >= 0.75) { tx = clamp(tx, -HW + 0.35, HW - 0.35); tz = clamp(tz, -HL + 0.4, -2.5); }
    const speed = lob ? 9 : 12 + speedN * 21;
    const spin = lob ? -1 : clamp(sw.vy / (sw.speed + 1e-6), -0.3, 1) * 5;
    const weak = speedN < 0.12 && D.assist < 0.6 && Math.random() < 0.4;
    const clear = weak ? -0.15 : lob ? 2.2 : lerp(0.12, 0.45, D.assist);
    const v = plan(b, tx, tz, speed, spin, clear);
    this.stats.hits++; this.rallyCount++;
    this.feedback = { text: Math.abs(timing) < 0.35 ? 'PERFECT' : timing > 0 ? 'EARLY' : 'LATE', color: Math.abs(timing) < 0.35 ? '#7dff9b' : '#ffd166', t: this.time };
    this.launch({ x: b.x, y: b.y, z: b.z }, v, spin, 0, Math.round(Math.hypot(v.x, v.y, v.z) * 3.6));
  }

  aiHit() {
    const D = this.D, b = this.ball;
    this.ai.swing = 0.35;
    let tx, tz, speed = D.pace * rand(0.85, 1.1), spin = rand(1, 4), clear = 0.25;
    const minSpeed = (z) => Math.hypot(tx - b.x, z - b.z) / 1.3;  // no moonballs: <= 1.3 s in the air
    const away = this.me.x > 0 ? -1 : 1;
    if (Math.random() < D.aim) tx = away * rand(HW * 0.45, HW - 0.35);        // to the open court
    else tx = clamp(this.me.x + rand(-1.2, 1.2), -HW + 0.6, HW - 0.6);         // back to you
    tz = rand(7.5, HL - 0.5 - (1 - D.aim) * 1.5);
    if (D.aim >= 0.7 && Math.random() < 0.12) { tz = rand(3.5, 5.5); tx = away * rand(HW * 0.6, HW - 0.4); speed *= 0.7; } // short angle
    if (Math.random() < D.aiErr) {                                           // unforced error
      const r = Math.random();
      if (r < 0.4) clear = -0.25; else if (r < 0.7) tz = HL + rand(0.3, 1.5); else tx = Math.sign(tx || 1) * (HW + rand(0.2, 1));
    }
    const v = plan({ x: b.x, y: b.y, z: b.z }, tx, tz, Math.max(speed, minSpeed(tz)), spin, clear);
    this.rallyCount++;
    this.launch({ x: b.x, y: b.y, z: b.z }, v, spin, 1, Math.round(Math.hypot(v.x, v.y, v.z) * 3.6));
  }

  updateRally(dt) {
    const b = this.ball, D = this.D, R = this.rally, events = [];
    const steps = 4;
    for (let i = 0; i < steps; i++) this.stepBall(b, dt / steps, events);
    for (const e of events) {
      if (e.type === 'net') { snd.bounce(0.5, b.x / 6); continue; }
      snd.bounce(0.8, e.x / 6);
      if (this.state !== 'rally') continue;
      const side = e.z > 0 ? 0 : 1;               // whose half it bounced in
      if (R.bounces === 0) {
        if (side === R.hitter) return R.serve ? this.faultCall() : this.pointTo(1 - R.hitter, b.netted ? 'NET' : 'OUT');
        if (R.serve) {
          const box = this.box, inBox = e.x >= box.x0 - 0.03 && e.x <= box.x1 + 0.03 && e.z >= Math.min(box.z0, box.z1) - 0.03 && e.z <= Math.max(box.z0, box.z1) + 0.03;
          if (!inBox) return this.faultCall();
        } else if (Math.abs(e.x) > HW + 0.03 || Math.abs(e.z) > HL + 0.03) return this.pointTo(1 - R.hitter, 'OUT');
        R.bounces = 1;
        if (this.D.marker && side === 0) this.flashLanding(e);
      } else {
        return this.pointTo(R.hitter, R.serve ? 'ACE!' : 'WINNER!');
      }
    }
    if (this.state !== 'rally') return;
    if (b.netted && R.bounces === 0 && Math.abs(b.z) < 0.3 && b.y < 0.1) return R.serve ? this.faultCall() : this.pointTo(1 - R.hitter, 'NET');

    if (R.hitter === 0) this.updateAiReturn();
    else this.updateMyReturn();

    // ball ran off into the stands
    if (Math.abs(b.z) > 19 || Math.abs(b.x) > 11.3) {
      if (R.bounces === 0) return R.serve ? this.faultCall() : this.pointTo(1 - R.hitter, 'OUT');
      return this.pointTo(R.hitter, R.serve ? 'ACE!' : 'WINNER!');
    }
  }

  updateAiReturn() {
    const b = this.ball, D = this.D, ai = this.ai, plan = ai.plan;
    if (!plan || b.vz > 0) return;
    if (!ai.decided) { ai.decided = true; ai.leave = plan.out && Math.random() < 0.5 + D.aim * 0.5; } // good players let out balls go
    if (ai.leave) { ai.tx = ai.x; return; }
    const reach = D.aiReach;
    if (this.rally.bounces >= 1 && b.z <= plan.zc + 0.25 && b.z > plan.zc - 1.5 && b.y < 2.8) {
      if (Math.abs(b.x - ai.x) <= reach) this.aiHit();
    }
  }

  updateMyReturn() {
    const b = this.ball, D = this.D, me = this.me;
    if (b.vz <= 0 || b.z < 0) return;
    const zc = me.contactZ ?? 12;
    // Seconds until the ideal contact point (+ = still coming). A swing reaches us
    // a little after you make it (camera + network + smoothing), so shift by that.
    const lag = Math.min(0.18, this.app.pose.stats.latency / 1000 * 0.8 + 0.03);
    const tTo = (zc - b.z) / b.vz + lag;
    const reach = Math.abs(b.x - me.x) <= D.reach && b.y < 2.9 && b.y > 0.1;
    if (this.swing.active > 0 && tTo > D.win + 0.25 && !me.swungEarly) { me.swungEarly = true; this.feedback = { text: 'TOO EARLY', color: '#ff9f6b', t: this.time }; }
    if (Math.abs(tTo) <= D.win && reach && this.swing.active > 0 && (this.rally.bounces >= 1 || b.z > 4)) {
      return this.playerHit(clamp(tTo / D.win, -1, 1));
    }
    if (tTo < -D.win && !me.judged) {
      me.judged = true;
      this.feedback = { text: reach ? 'SWING!' : 'TOO FAR', color: '#ff6b8b', t: this.time };
    }
  }

  faultCall() {
    if (this.fault) { this.fault = false; return this.pointTo(1 - this.rally.hitter, 'DOUBLE FAULT'); }
    this.fault = true;
    this.state = 'over'; this.overT = 1.4; this.after = () => this.setupServe();
    this.message = { text: 'FAULT', color: '#ffd166', t: this.time };
    say('Fault');
  }

  pointTo(who, why) {
    this.fault = false;
    this.points[who]++;
    if (who === 0) this.stats.pointsWon++; else this.stats.pointsLost++;
    if (who === 0 && why === 'ACE!') this.stats.aces++;
    if (who === 0 && why === 'WINNER!') this.stats.winners++;
    this.stats.longest = Math.max(this.stats.longest, this.rallyCount || 0);
    this.rallyCount = 0;
    this.state = 'over'; this.overT = 2.2;
    const [a, c] = this.points;
    let call, gameOver = false;
    if (a >= 4 && a - c >= 2 || c >= 4 && c - a >= 2) {
      gameOver = true;
      this.games[who]++;
      this.points = [0, 0];
      const won = this.games[who] >= this.D.games;
      call = won ? `Game, set and match, ${who === 0 ? 'you' : 'computer'}` : `Game, ${who === 0 ? 'you' : 'computer'}`;
      if (won) { this.matchOver = who; this.overT = 3.2; }
      else this.server = 1 - this.server;
    } else call = this.callScore();
    this.message = { text: why, sub: gameOver ? (this.matchOver != null ? (who === 0 ? 'MATCH WON' : 'MATCH LOST') : 'GAME ' + (who === 0 ? 'YOU' : 'CPU')) : null, color: who === 0 ? '#7dff9b' : '#ff6b8b', t: this.time };
    this.crowdExcite = who === 0 ? 1 : 0.45; this.exciteT = 2.2;
    snd.crowd(who === 0 ? 1 : 0.5, who === 0 ? 2.6 : 1.6);
    say(call);
    this.after = () => this.matchOver != null ? this.end() : this.setupServe();
  }

  callScore() {
    const [a, c] = this.points, srv = this.server === 0 ? [a, c] : [c, a];
    if (a >= 3 && c >= 3) return a === c ? 'Deuce' : `Advantage, ${a > c ? 'you' : 'computer'}`;
    if (srv[0] === srv[1]) return `${CALLS[srv[0]]} all`;
    return `${CALLS[srv[0]]}, ${CALLS[srv[1]]}`;
  }
  scoreText(i) {
    const [a, c] = this.points;
    if (a >= 3 && c >= 3) { if (a === c) return '40'; return (i === 0 ? a > c : c > a) ? 'AD' : '40'; }
    return ['0', '15', '30', '40'][this.points[i]] ?? '40';
  }

  flashLanding(e) { this.landFlash = { x: e.x, z: e.z, t: this.time }; }
  spark(p) { this.sparkAt = { x: p.x, y: p.y, z: p.z, t: this.time }; }

  // ---------- per-frame ----------
  update(dt) {
    this.time += dt;
    this.updateSwing(dt);
    if (this.state === 'serve') this.updateServe(dt);
    else if (this.state === 'rally') this.updateRally(dt);
    else if (this.state === 'over') {
      if (this.ball.live) { const ev = []; this.stepBall(this.ball, dt, ev); for (const e of ev) if (e.type === 'bounce') snd.bounce(0.5, e.x / 6); }
      this.overT -= dt;
      if (this.overT <= 0) { this.state = 'wait'; const f = this.after; this.after = null; f?.(); }
    }
    this.movePlayers(dt);
    if (this.exciteT > 0) { this.exciteT -= dt; if (this.exciteT <= 0) this.crowdExcite = 0; }
    this.placeCrowd(this.time);
    this.adTex.offset.x = (this.time * 0.03) % 1;
  }

  movePlayers(dt) {
    const me = this.me, ai = this.ai, D = this.D;
    // you: run to the ball while it's coming, drift back to the middle otherwise
    if (this.state === 'rally' && this.rally?.hitter === 0) { me.tx = 0.3 * me.x; me.tz = 12.6; }
    const mvx = clamp(me.tx - me.x, -D.run * dt, D.run * dt), mvz = clamp(me.tz - me.z, -D.run * dt, D.run * dt);
    me.x += mvx; me.z += mvz; me.runPhase += Math.hypot(mvx, mvz) * 4.2;
    if (this.state === 'rally' && this.rally?.hitter === 1) { ai.tx = clamp(-me.x * 0.3, -2, 2); ai.tz = -12.6; }
    const avx = clamp(ai.tx - ai.x, -D.aiSpeed * dt, D.aiSpeed * dt), avz = clamp(ai.tz - ai.z, -D.aiSpeed * dt, D.aiSpeed * dt);
    ai.x += avx; ai.z += avz; ai.runPhase += Math.hypot(avx, avz) * 4.2;
    ai.swing = Math.max(0, ai.swing - dt); me.swingAnim = Math.max(0, me.swingAnim - dt);
  }

  poseFigures() {
    const me = this.me, ai = this.ai, M = this.meObj, A = this.aiObj;
    M.position.set(me.x, 0, me.z); A.position.set(ai.x, 0, ai.z);
    for (const [F, p] of [[M, me], [A, ai]]) F.legs.forEach((l, k) => l.rotation.x = Math.sin(p.runPhase + k * Math.PI) * 0.6);
    // your arms follow your real hands (1 shoulder width ≈ 0.42 m)
    const tmp = new THREE.Vector3(), shoulderW = 0.42;
    const handWorld = {};
    for (const [k, side] of [[0, 'L'], [1, 'R']]) {
      const h = this.hand[side], sh = M.shoulders[k].clone().add(M.position);
      const hp = h.ok ? new THREE.Vector3(me.x + h.x * shoulderW * 1.25, 1.42 + h.y * shoulderW * 1.25, me.z - 0.32)
        : sh.clone().add(new THREE.Vector3(k ? 0.05 : -0.05, -0.55, -0.1));
      handWorld[side] = hp;
      this.stretch(M.arms[k], sh, hp);
    }
    const rs = me.racketSide > 0 ? 'R' : 'L', hp = handWorld[rs];
    const h = this.hand[rs];
    // racket points away from the shoulder, tilted along the swing
    const dir = tmp.copy(hp).sub(M.shoulders[me.racketSide > 0 ? 1 : 0].clone().add(M.position)).normalize();
    dir.z -= 0.6; dir.y += 0.5; dir.normalize();
    this.meRacket.position.copy(hp);
    this.meRacket.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    this.meRacket.rotateY(clamp(h.vx * 0.05, -0.8, 0.8));
    this.racketHead = this.meRacket.localToWorld(new THREE.Vector3(0, 0.42, 0));
    // CPU: racket arm at the side, with a swing when it hits
    const s = ai.swing / 0.35, ang = s > 0 ? lerp(-1.4, 1.6, 1 - s) : -0.6;
    const ash = A.shoulders[0].clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI).add(A.position);
    const ahand = ash.clone().add(new THREE.Vector3(-Math.cos(ang) * 0.55, -0.35 + Math.sin(Math.max(0, ang)) * 0.2, Math.sin(ang) * 0.55));
    this.stretch(A.arms[0], ash, ahand);
    const ash2 = A.shoulders[1].clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI).add(A.position);
    this.stretch(A.arms[1], ash2, ash2.clone().add(new THREE.Vector3(0.1, -0.55, 0.1)));
    const adir = ahand.clone().sub(ash).normalize(); adir.y += 0.6; adir.normalize();
    this.aiRacket.position.copy(ahand); this.aiRacket.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), adir);
  }
  stretch(mesh, a, b) {
    const d = b.clone().sub(a), len = Math.max(0.05, d.length());
    mesh.position.copy(a).addScaledVector(d, 0.5);
    mesh.scale.set(1, len / 1.11, 1);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  }

  render() {
    const b = this.ball, me = this.me;
    this.poseFigures();
    this.ballObj.visible = b.live;
    this.ballObj.position.set(b.x, b.y, b.z);
    this.ballObj.rotation.x += 0.3; this.ballObj.rotation.y += 0.2;
    this.blob.visible = b.live; this.blob.position.set(b.x, 0.011, b.z);
    const hgt = clamp(b.y / 3, 0, 1); this.blob.material.opacity = 0.45 * (1 - hgt * 0.7); this.blob.scale.setScalar(1 + hgt);
    // trail
    this.trail.unshift(new THREE.Vector3(b.x, b.y, b.z)); this.trail.length = Math.min(this.trail.length, this.trailSprites.length);
    const fast = this.state === 'rally' ? clamp(Math.hypot(b.vx, b.vz) / 30, 0.15, 1) : 0;
    this.trailSprites.forEach((s, i) => {
      const p = this.trail[i]; s.visible = !!p && b.live;
      if (p) { s.position.copy(p); s.material.opacity = fast * 0.5 * (1 - i / this.trailSprites.length); }
    });
    // guides (easier levels): where the ball will land and where to meet it
    const show = this.D.marker && this.state === 'rally' && this.rally?.hitter === 1 && b.vz > 0;
    this.landRing.material.opacity = show && me.landing && this.rally.bounces === 0 ? 0.9 : 0;
    if (me.landing) this.landRing.position.set(me.landing.x, 0.012, me.landing.z);
    this.hitRing.material.opacity = show && me.contact?.x != null ? 0.55 + 0.3 * Math.sin(this.time * 10) : 0;
    if (me.contact?.x != null) this.hitRing.position.set(me.contact.x, 0.012, me.contactZ);
    // camera: behind and above you, easing with your movement
    const cam = this.camera;
    const want = new THREE.Vector3(me.x * 0.55, 3.0, me.z + 5.4);
    cam.position.lerp(want, 0.08);
    const look = new THREE.Vector3(me.x * 0.3, 0.4, me.z - 15);
    this.look = this.look ? this.look.lerp(look, 0.08) : look;
    cam.lookAt(this.look);
    this.composer.render();
    this.drawHud();
  }

  drawHud() {
    const g = this.app.octx, W = innerWidth, H = innerHeight;
    g.clearRect(0, 0, W, H);
    // scoreboard
    const x0 = 20, y0 = 60, rowH = 34;
    g.fillStyle = 'rgba(8,12,34,.82)'; g.strokeStyle = 'rgba(127,227,255,.35)'; g.lineWidth = 1.5;
    g.beginPath(); g.roundRect(x0, y0, 300, rowH * 2 + 30, 10); g.fill(); g.stroke();
    g.font = '700 12px system-ui'; g.fillStyle = '#7fe3ff'; g.textAlign = 'left';
    g.fillText(`${this.diffName.toUpperCase()} · FIRST TO ${this.D.games} GAMES`, x0 + 12, y0 + 18);
    const rows = [['YOU', 0, '#2fa8ff'], ['CPU', 1, '#ff3b5c']];
    rows.forEach(([name, i, col], r) => {
      const y = y0 + 30 + r * rowH;
      g.fillStyle = col; g.fillRect(x0 + 12, y + 6, 5, rowH - 12);
      g.fillStyle = '#fff'; g.font = '800 20px system-ui'; g.fillText(name, x0 + 26, y + 24);
      if (this.server === i && this.state !== 'over') { g.fillStyle = '#d7f23a'; g.beginPath(); g.arc(x0 + 92, y + 17, 5, 0, Math.PI * 2); g.fill(); }
      g.fillStyle = '#c9d4ff'; g.font = '800 22px system-ui'; g.textAlign = 'center';
      g.fillText(this.games[i], x0 + 200, y + 25);
      g.fillStyle = 'rgba(127,227,255,.14)'; g.fillRect(x0 + 232, y + 3, 56, rowH - 6);
      g.fillStyle = '#fff'; g.fillText(this.scoreText(i), x0 + 260, y + 25);
      g.textAlign = 'left';
    });
    g.textAlign = 'center';
    // big call
    if (this.message && this.time - this.message.t < 2.0) {
      const a = clamp(2 - (this.time - this.message.t), 0, 1), s = 1 + Math.max(0, 0.25 - (this.time - this.message.t)) * 1.5;
      g.save(); g.globalAlpha = a; g.translate(W / 2, H * 0.36); g.scale(s, s);
      g.font = '900 64px system-ui'; g.fillStyle = this.message.color; g.shadowColor = 'rgba(0,0,0,.7)'; g.shadowBlur = 18;
      g.fillText(this.message.text, 0, 0);
      g.font = '800 22px system-ui'; g.fillStyle = '#fff';
      g.fillText(this.message.sub || (this.matchOver == null && this.state === 'over' ? this.callScore() : ''), 0, 40);
      g.restore();
    }
    // hit feedback near your racket
    if (this.feedback && this.time - this.feedback.t < 0.9) {
      g.save(); g.globalAlpha = clamp(1.2 - (this.time - this.feedback.t) * 1.4, 0, 1);
      g.font = '900 30px system-ui'; g.fillStyle = this.feedback.color; g.shadowColor = '#000'; g.shadowBlur = 10;
      g.fillText(this.feedback.text, W / 2, H * 0.6 - (this.time - this.feedback.t) * 40); g.restore();
    }
    // shot speed
    if (this.lastSpeed && this.time - this.lastSpeed.t < 1.6 && this.lastSpeed.kmh > 0) {
      g.font = '800 18px system-ui'; g.fillStyle = this.lastSpeed.who === 0 ? '#7fe3ff' : '#ff9fb3';
      g.textAlign = 'right'; g.fillText(`${this.lastSpeed.kmh} km/h`, W - 24, 90); g.textAlign = 'center';
    }
    // prompt
    if (this.prompt && this.state === 'serve') {
      g.font = '800 26px system-ui'; g.fillStyle = '#fff'; g.shadowColor = '#000'; g.shadowBlur = 8;
      g.fillText(this.prompt, W / 2, H * 0.82); g.shadowBlur = 0;
    }
    // swing meter: hand speed against the swing threshold
    const mx = 40, my = H - 64, mh = 170;
    const v = clamp((this.handSpeed || 0) / (this.D.swing * 2.2), 0, 1);
    g.fillStyle = 'rgba(8,12,34,.7)'; g.beginPath(); g.roundRect(mx - 14, my - mh - 8, 28, mh + 16, 8); g.fill();
    const grd = g.createLinearGradient(0, my, 0, my - mh); grd.addColorStop(0, '#2fa8ff'); grd.addColorStop(0.45, '#7dff9b'); grd.addColorStop(1, '#ff3b5c');
    g.fillStyle = grd; g.fillRect(mx - 8, my - mh * v, 16, mh * v);
    const ty = my - mh / 2.2;
    g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.moveTo(mx - 14, ty); g.lineTo(mx + 14, ty); g.stroke();
    g.font = '700 11px system-ui'; g.fillStyle = '#c9d4ff'; g.fillText('SWING', mx, my + 18);
    if (this.swing.active > 0) { g.strokeStyle = '#7dff9b'; g.lineWidth = 3; g.beginPath(); g.roundRect(mx - 16, my - mh - 10, 32, mh + 20, 9); g.stroke(); }
  }

  end() {
    if (this.ended) return; this.ended = true;
    const won = this.matchOver === 0, [a, c] = this.games;
    const rank = won ? (c === 0 ? 'S' : 'A') : a > 0 ? 'B' : this.stats.pointsWon >= 4 ? 'C' : 'D';
    this.app.finish({
      rank, failed: !won, title: won ? `Match won — ${this.diffName}!` : `Match lost — ${this.diffName}`,
      stats: {
        Score: `${a}–${c} games`, 'Points won': `${this.stats.pointsWon} / ${this.stats.pointsWon + this.stats.pointsLost}`,
        Aces: this.stats.aces, Winners: this.stats.winners, 'Longest rally': `${this.stats.longest} shots`,
        'Fastest shot': `${this.stats.fastest} km/h`,
      },
    });
  }

  dispose() {
    try { speechSynthesis?.cancel(); } catch { }
    this.composer.dispose();
    this.scene.traverse(o => { o.geometry?.dispose?.(); if (o.material) [].concat(o.material).forEach(m => { m.map?.dispose?.(); m.dispose?.(); }); });
    this.glow.dispose();
    const r = this.app.renderer;
    r.toneMapping = this.prev.tone; r.toneMappingExposure = this.prev.exp;
    r.shadowMap.enabled = this.prev.shadow; r.shadowMap.type = this.prev.type;
    r.setClearColor(0x000000, 0); r.clear();
    this.app.octx.clearRect(0, 0, innerWidth, innerHeight);
  }
}
