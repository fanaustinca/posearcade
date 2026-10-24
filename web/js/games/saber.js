import * as THREE from 'three';
import { KP, BONES } from '../pose.js';
import { ctx as audio, sfx, Sequencer, BufferPlayer, songTimeline } from '../audio.js';

export const SABER_DIFFS = {
  Test:   { speed: 8,  density: 0.3,  half: 0,    doubles: 0,    bombs: 0,    diag: false, horiz: 0,    any: 0.6,  minGap: 1.1,  fail: false },
  Easy:   { speed: 11, density: 0.45, half: 0,    doubles: 0,    bombs: 0,    diag: false, horiz: 0,    any: 0.35, minGap: 0.75, fail: false },
  Normal: { speed: 14, density: 0.7,  half: 0,    doubles: 0.08, bombs: 0.03, diag: false, horiz: 0.1,  any: 0.12, minGap: 0.5,  fail: true },
  Hard:   { speed: 17, density: 0.9,  half: 0.25, doubles: 0.15, bombs: 0.05, diag: true,  horiz: 0.12, any: 0.05, minGap: 0.36, fail: true },
  Expert: { speed: 20, density: 1.0,  half: 0.55, doubles: 0.22, bombs: 0.07, diag: true,  horiz: 0.15, any: 0,    minGap: 0.27, fail: true },
};

const LANES = [-1.65, -0.55, 0.55, 1.65];
const ROWS = [-0.85, 0.25, 1.35];
const DIRS = {
  U: [0, 1], D: [0, -1], L: [-1, 0], R: [1, 0],
  UL: [-Math.SQRT1_2, Math.SQRT1_2], UR: [Math.SQRT1_2, Math.SQRT1_2],
  DL: [-Math.SQRT1_2, -Math.SQRT1_2], DR: [Math.SQRT1_2, -Math.SQRT1_2], ANY: null,
};
const SABER_LEN = 1.5, HIT_R = 0.52, MIN_SPEED = 2.4;
const EARLY = 0.26, LATE = 0.14; // seconds around the hit time a cut can land
const COLORS = { L: 0xff3b5c, R: 0x2fa8ff };

function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function hashStr(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }

// ---------- map generation ----------
// candidates: [{t, lvl (0..3), strong}] -> notes [{t, hand, lane, row, dir, bomb}]
function buildMap(cands, diff, seed) {
  const R = rng(seed), notes = [];
  const last = { L: -9, R: -9 }, parity = { L: 'D', R: 'D' };
  const pickRow = (down) => { const r = R(); return down ? (r < 0.4 ? 0 : r < 0.8 ? 1 : 2) : (r < 0.5 ? 0 : r < 0.9 ? 1 : 2); };
  const dirFor = (hand) => {
    const down = parity[hand] === 'D';
    if (R() < diff.any) return 'ANY';
    if (R() < diff.horiz) return hand === 'L' ? (down ? 'L' : 'R') : (down ? 'R' : 'L');
    if (diff.diag && R() < 0.35) return (down ? 'D' : 'U') + (R() < 0.5 ? 'L' : 'R');
    return down ? 'D' : 'U';
  };
  const place = (t, hand, laneSet) => {
    const dir = dirFor(hand), down = parity[hand] === 'D';
    // Up/down rows follow the swing so the next swing flows from where the hand ends.
    let row = pickRow(down);
    if (dir === 'L' || dir === 'R') row = 1;
    const lane = laneSet[Math.floor(R() * laneSet.length)];
    notes.push({ t, hand, lane, row, dir });
    parity[hand] = down ? 'U' : 'D'; last[hand] = t;
    return { lane, row };
  };
  for (const c of cands) {
    const gap = diff.minGap * (c.lvl >= 3 ? 0.85 : 1);
    const freeL = c.t - last.L >= gap, freeR = c.t - last.R >= gap;
    if (!freeL && !freeR) continue;
    const wantDouble = c.strong && c.lvl >= 2 && R() < diff.doubles * (c.sectionStart ? 4 : 1);
    if (wantDouble && freeL && freeR) {
      parity.R = parity.L;
      if (R() < 0.5) { place(c.t, 'L', [0]); place(c.t, 'R', [3]); } else { place(c.t, 'L', [1]); place(c.t, 'R', [2]); }
      continue;
    }
    let hand = freeL && freeR ? (last.L <= last.R ? 'L' : 'R') : (freeL ? 'L' : 'R');
    const lanes = hand === 'L' ? (R() < 0.85 ? [0, 1] : [2]) : (R() < 0.85 ? [2, 3] : [1]);
    const p = place(c.t, hand, lanes);
    if (R() < diff.bombs && c.lvl >= 1) {
      // bomb on the opposite side from where the swing ends up
      const lane = hand === 'L' ? 2 + Math.floor(R() * 2) : Math.floor(R() * 2);
      if (Math.abs(lane - p.lane) > 0) notes.push({ t: c.t, bomb: true, lane, row: Math.floor(R() * 3) });
    }
  }
  return notes;
}

function builtinCandidates(song, diff) {
  const tl = songTimeline(song), R = rng(hashStr(song.id) ^ 77), out = [];
  const pLvl = [0.3, 0.6, 0.85, 1.0];
  for (const b of tl.beats) {
    if (b.bar < 1) continue; // one bar of breathing room
    if (b.q % 2 === 1 && b.intensity === 0) continue;
    if (R() < pLvl[b.intensity] * diff.density)
      out.push({ t: b.t, lvl: b.intensity, strong: b.q === 0, sectionStart: b.sectionStart });
    if (b.intensity >= 2 && R() < diff.half * (b.intensity - 1) / 2)
      out.push({ t: b.t + tl.spb / 2, lvl: b.intensity, strong: false });
  }
  return { cands: out, duration: tl.duration, spb: tl.spb };
}

function customCandidates(analysis, diff) {
  const { onsets, loud, duration } = analysis;
  const sorted = [...loud].sort((a, b) => a - b);
  const q = (v) => { let i = 0; while (i < sorted.length && sorted[i] < v) i++; return i / sorted.length; };
  const strengths = onsets.map(o => o.s).sort((a, b) => a - b);
  const cut = strengths[Math.floor(strengths.length * (1 - Math.min(0.98, diff.density * 0.85)))] || 0;
  const out = [];
  for (const o of onsets) {
    if (o.t < 1.0 || o.s < cut) continue;
    const lv = q(loud[Math.min(loud.length - 1, Math.floor(o.t))]);
    out.push({ t: o.t, lvl: lv > 0.75 ? 3 : lv > 0.45 ? 2 : lv > 0.2 ? 1 : 0, strong: o.s > cut * 1.6 });
  }
  return { cands: out, duration: duration + 0.5, spb: 0.5 };
}

// ---------- visuals helpers ----------
function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.3, 'rgba(255,255,255,.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

class Particles {
  constructor(scene, tex, cap = 900) {
    this.cap = cap; this.n = 0;
    this.pos = new Float32Array(cap * 3); this.col = new Float32Array(cap * 3);
    this.vel = new Float32Array(cap * 3); this.life = new Float32Array(cap); this.maxLife = new Float32Array(cap); this.base = new Float32Array(cap * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.16, map: tex, vertexColors: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false }));
    this.points.frustumCulled = false;
    scene.add(this.points);
  }
  burst(x, y, z, color, count, speed, life = 0.6, dir = null) {
    const c = new THREE.Color(color);
    for (let k = 0; k < count; k++) {
      const i = this.n < this.cap ? this.n++ : Math.floor(Math.random() * this.cap);
      this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
      let vx = (Math.random() - 0.5) * 2, vy = (Math.random() - 0.5) * 2, vz = (Math.random() - 0.5) * 2;
      if (dir) { vx += dir[0] * 1.5; vy += dir[1] * 1.5; }
      const s = speed * (0.4 + Math.random() * 0.8);
      this.vel[i * 3] = vx * s; this.vel[i * 3 + 1] = vy * s; this.vel[i * 3 + 2] = vz * s;
      this.life[i] = this.maxLife[i] = life * (0.5 + Math.random() * 0.7);
      const w = Math.random() < 0.3 ? 1 : 0;
      this.base[i * 3] = c.r + w; this.base[i * 3 + 1] = c.g + w; this.base[i * 3 + 2] = c.b + w;
    }
  }
  update(dt) {
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const f = Math.max(0, this.life[i] / this.maxLife[i]);
      this.vel[i * 3 + 1] -= 6 * dt;
      for (let a = 0; a < 3; a++) { this.pos[i * 3 + a] += this.vel[i * 3 + a] * dt; this.col[i * 3 + a] = this.base[i * 3 + a] * f; }
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }
}

class Trail {
  constructor(scene, color, n = 14) {
    this.n = n; this.hist = [];
    this.pos = new Float32Array(n * 2 * 3); this.col = new Float32Array(n * 2 * 3);
    const idx = [];
    for (let i = 0; i < n - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    g.setIndex(idx);
    this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false }));
    this.mesh.frustumCulled = false; this.color = new THREE.Color(color);
    scene.add(this.mesh);
  }
  push(base, tip) {
    this.hist.unshift([base.clone(), tip.clone()]);
    if (this.hist.length > this.n) this.hist.pop();
    for (let i = 0; i < this.n; i++) {
      const h = this.hist[Math.min(i, this.hist.length - 1)];
      // trail hugs the outer 60% of the blade
      const b = h[0].clone().lerp(h[1], 0.4);
      this.pos.set([b.x, b.y, b.z, h[1].x, h[1].y, h[1].z], i * 6);
      const f = Math.pow(1 - i / this.n, 2) * 0.55;
      this.col.set([this.color.r * f * 0.3, this.color.g * f * 0.3, this.color.b * f * 0.3, this.color.r * f, this.color.g * f, this.color.b * f], i * 6);
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.color.needsUpdate = true;
  }
}

function makeSaber(color) {
  const g = new THREE.Group();
  const core = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, SABER_LEN, 10), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  core.position.y = SABER_LEN / 2;
  const glow = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, SABER_LEN + 0.1, 14, 1, true),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
  glow.position.y = SABER_LEN / 2;
  const glow2 = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, SABER_LEN + 0.2, 14, 1, true),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false }));
  glow2.position.y = SABER_LEN / 2;
  const hilt = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.38, 10), new THREE.MeshStandardMaterial({ color: 0x333344, metalness: 0.9, roughness: 0.3 }));
  hilt.position.y = -0.19;
  g.add(core, glow, glow2, hilt);
  return g;
}

function arrowShape() {
  const s = new THREE.Shape();
  s.moveTo(-0.26, -0.02); s.lineTo(0.26, -0.02); s.lineTo(0, 0.22); s.closePath();
  return new THREE.ShapeGeometry(s);
}

// ---------- the game ----------
export class SaberGame {
  constructor(app, opts) {
    this.app = app; this.opts = opts;
    this.diff = SABER_DIFFS[opts.diff] || SABER_DIFFS.Normal;
    const song = opts.song;
    const isCustom = !!song.buffer;
    const { cands, duration, spb } = isCustom ? customCandidates(song.analysis, this.diff) : builtinCandidates(song, this.diff);
    this.notes = buildMap(cands, this.diff, hashStr((song.id || song.name) + opts.diff)).sort((a, b) => a.t - b.t);
    this.duration = duration; this.spb = spb;
    this.player = isCustom ? new BufferPlayer(song.buffer) : new Sequencer(song);
    this.songName = song.name;
    this.score = 0; this.combo = 0; this.maxCombo = 0; this.mult = 1; this.multProg = 0;
    this.energy = 0.5; this.hits = 0; this.misses = 0; this.badCuts = 0; this.bombsHit = 0;
    this.maxScore = 0;
    // Max score with the multiplier ramp (1x for 1, 2x for 4, 4x for 8, then 8x).
    this.maxScore = 0; { let c = 0; for (const n of this.notes) if (!n.bomb) { c++; this.maxScore += 115 * (c < 2 ? 1 : c < 6 ? 2 : c < 14 ? 4 : 8); } }
    this.next = 0; this.live = []; this.debris = [];
    this.buildScene();
  }

  buildScene() {
    const { THREE: T, renderer } = this.app;
    const scene = this.scene = new THREE.Scene();
    scene.background = new THREE.Color(0x07060f);
    scene.fog = new THREE.Fog(0x07060f, 18, 70);
    this.camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 200);
    this.camera.position.set(0, 0.45, 7.2); this.camera.lookAt(0, 0.1, -20);
    scene.add(new THREE.HemisphereLight(0xb0a8ff, 0x201030, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(2, 4, 6); scene.add(key);
    this.tex = glowTexture();

    // floor: side rails + scrolling cross lines
    const floorY = -2.3, lines = [];
    for (const x of [-3.2, -2.2, 2.2, 3.2]) lines.push(x, floorY, 5, x, floorY, -80);
    const rails = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(lines, 3)),
      new THREE.LineBasicMaterial({ color: 0x6a4cff, transparent: true, opacity: 0.8 }));
    scene.add(rails);
    const cross = [];
    for (let z = 0; z > -84; z -= 4) cross.push(-3.2, floorY, z, 3.2, floorY, z);
    this.cross = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(cross, 3)),
      new THREE.LineBasicMaterial({ color: 0x3b2a8f, transparent: true, opacity: 0.7 }));
    scene.add(this.cross);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 90), new THREE.MeshStandardMaterial({ color: 0x0c0a1c, roughness: 0.35, metalness: 0.6 }));
    floor.rotation.x = -Math.PI / 2; floor.position.set(0, floorY - 0.01, -40); scene.add(floor);

    // rings that pulse on the beat
    this.rings = [];
    for (let i = 0; i < 12; i++) {
      const ring = new THREE.Group(), mat = new THREE.MeshBasicMaterial({ color: i % 2 ? COLORS.L : COLORS.R, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false });
      const W = 9, H = 7, th = 0.08;
      for (const [w, h, x, y] of [[W, th, 0, H / 2], [W, th, 0, -H / 2], [th, H, W / 2, 0], [th, H, -W / 2, 0]]) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, th), mat); m.position.set(x, y, 0); ring.add(m);
      }
      ring.position.set(0, 0.6, -10 - i * 6); ring.userData.mat = mat;
      scene.add(ring); this.rings.push(ring);
    }
    // sweeping lasers
    this.lasers = [];
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 90), new THREE.MeshBasicMaterial({ color: i % 2 ? COLORS.L : COLORS.R,
        transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
      m.position.set(i < 3 ? -7 : 7, -1 + (i % 3) * 2.5, -50); scene.add(m); this.lasers.push(m);
    }

    // shared block resources
    this.blockGeo = new THREE.BoxGeometry(0.78, 0.78, 0.78);
    this.halfGeo = new THREE.BoxGeometry(0.78, 0.39, 0.78);
    this.blockMat = { L: new THREE.MeshStandardMaterial({ color: COLORS.L, emissive: COLORS.L, emissiveIntensity: 0.35, roughness: 0.35, metalness: 0.2 }),
                      R: new THREE.MeshStandardMaterial({ color: COLORS.R, emissive: COLORS.R, emissiveIntensity: 0.35, roughness: 0.35, metalness: 0.2 }) };
    this.arrowGeo = arrowShape();
    this.dotGeo = new THREE.CircleGeometry(0.12, 20);
    this.arrowMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.bombGeo = new THREE.IcosahedronGeometry(0.36, 0);
    this.bombMat = new THREE.MeshStandardMaterial({ color: 0x1a1a22, roughness: 0.4, metalness: 0.8, emissive: 0x220000 });

    // sabers, trails, ghost skeleton, particles
    this.sabers = { L: makeSaber(COLORS.L), R: makeSaber(COLORS.R) };
    scene.add(this.sabers.L, this.sabers.R);
    this.trails = { L: new Trail(scene, COLORS.L), R: new Trail(scene, COLORS.R) };
    this.saberState = { L: null, R: null };
    this.lastDir = { L: new THREE.Vector2(0, 1), R: new THREE.Vector2(0, 1) };
    const skelPos = new Float32Array(BONES.length * 6);
    this.skel = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(skelPos, 3)),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22 }));
    this.skel.frustumCulled = false; scene.add(this.skel);
    this.particles = new Particles(scene, this.tex);
    renderer.setClearColor(0x07060f, 1);
  }

  resize() { this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix(); }

  start() {
    this.resize();
    this.leadIn = 2.8;
    this.t0 = audio.currentTime + this.leadIn;
    this.player.start(this.t0);
    this.app.hud.energy(this.diff.fail ? this.energy : null);
    this.app.hud.toast(this.songName, '#fff', 1800);
  }

  time() { return audio.currentTime - this.t0; }

  spawn(n) {
    let mesh;
    if (n.bomb) {
      mesh = new THREE.Mesh(this.bombGeo, this.bombMat);
    } else {
      mesh = new THREE.Group();
      mesh.add(new THREE.Mesh(this.blockGeo, this.blockMat[n.hand]));
      const mark = new THREE.Mesh(n.dir === 'ANY' ? this.dotGeo : this.arrowGeo, this.arrowMat);
      mark.position.z = 0.4; mesh.add(mark);
      if (n.dir !== 'ANY') { const [dx, dy] = DIRS[n.dir]; mesh.rotation.z = Math.atan2(dy, dx) - Math.PI / 2; }
    }
    mesh.position.set(LANES[n.lane], ROWS[n.row], -60);
    this.scene.add(mesh);
    this.live.push({ ...n, mesh, done: false });
  }

  // Saber segment for one hand from wrist/elbow keypoints, in world (= body) units.
  saberFor(hand) {
    const b = this.app.body;
    const w = b.body(hand === 'L' ? KP.leftWrist : KP.rightWrist), e = b.body(hand === 'L' ? KP.leftElbow : KP.rightElbow);
    if (!w.ok) return null;
    if (e.ok) {
      const d = new THREE.Vector2(w.x - e.x, w.y - e.y);
      if (d.length() > 0.15) this.lastDir[hand].lerp(d.normalize(), 0.7).normalize();
    }
    const d = this.lastDir[hand];
    const base = new THREE.Vector3(w.x + d.x * 0.12, w.y + d.y * 0.12, 0.3);
    const tip = new THREE.Vector3(base.x + d.x * SABER_LEN, base.y + d.y * SABER_LEN, -0.25);
    return { base, tip };
  }

  update(dt) {
    const t = this.time(), diff = this.diff;
    // spawn
    const travel = 60 / diff.speed;
    while (this.next < this.notes.length && this.notes[this.next].t - travel <= t) this.spawn(this.notes[this.next++]);

    // sabers
    for (const hand of ['L', 'R']) {
      const cur = this.saberFor(hand), sab = this.sabers[hand];
      const prev = this.saberState[hand];
      sab.visible = !!cur;
      if (!cur) { this.saberState[hand] = null; continue; }
      sab.position.copy(cur.base);
      sab.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), cur.tip.clone().sub(cur.base).normalize());
      this.trails[hand].push(cur.base, cur.tip);
      if (prev && dt > 0) this.checkHits(hand, prev, cur, dt, t);
      this.saberState[hand] = cur;
    }

    // blocks
    for (const n of this.live) {
      if (n.done) continue;
      const z = (t - n.t) * diff.speed;
      n.mesh.position.z = z;
      if (n.bomb) n.mesh.rotation.x += dt * 2, n.mesh.rotation.y += dt * 1.5;
      if (t - n.t > LATE) {
        n.done = true; this.scene.remove(n.mesh);
        if (!n.bomb) this.onMiss('MISS');
      }
    }
    this.live = this.live.filter(n => !n.done);

    // debris
    for (const d of this.debris) {
      d.life -= dt;
      d.mesh.position.addScaledVector(d.vel, dt); d.vel.y -= 9 * dt;
      d.mesh.rotation.x += d.spin.x * dt; d.mesh.rotation.y += d.spin.y * dt;
      const s = Math.max(0.01, d.life / 0.7); d.mesh.scale.setScalar(s);
      if (d.life <= 0) this.scene.remove(d.mesh);
    }
    this.debris = this.debris.filter(d => d.life > 0);
    this.particles.update(dt);
    this.updateEnv(t, dt);
    this.updateSkeleton();

    this.app.hud.progress(Math.max(0, Math.min(1, t / this.duration)));
    if (t > this.duration && this.live.length === 0) this.end(false);
  }

  checkHits(hand, prev, cur, dt, t) {
    const mid = (s) => s.base.clone().lerp(s.tip, 0.6);
    const v = mid(cur).sub(mid(prev)).divideScalar(dt);
    const speed = Math.hypot(v.x, v.y);
    for (const n of this.live) {
      if (n.done) continue;
      const dtHit = t - n.t;
      if (dtHit < -EARLY || dtHit > LATE) continue;
      const bx = LANES[n.lane], by = ROWS[n.row];
      // sweep between last frame's blade and this frame's
      let hitK = -1, bestDist = 9;
      for (let k = 0; k <= 6; k++) {
        const f = k / 6;
        const ax = prev.base.x + (cur.base.x - prev.base.x) * f, ay = prev.base.y + (cur.base.y - prev.base.y) * f;
        const bx2 = prev.tip.x + (cur.tip.x - prev.tip.x) * f, by2 = prev.tip.y + (cur.tip.y - prev.tip.y) * f;
        const d = segDist(bx, by, ax, ay, bx2, by2);
        if (d < bestDist) bestDist = d;
        if (d < (n.bomb ? 0.38 : HIT_R) && hitK < 0) hitK = k;
      }
      if (hitK < 0) continue;
      if (n.bomb) { this.onBomb(n); continue; }
      if (speed < MIN_SPEED) continue; // resting in a block doesn't cut it
      const dir = DIRS[n.dir];
      const dot = dir ? (v.x * dir[0] + v.y * dir[1]) / speed : 1;
      if (n.hand !== hand) this.onBadCut(n, 'WRONG SABER', v);
      else if (dot < 0.42) this.onBadCut(n, 'WRONG WAY', v);
      else this.onCut(n, v, speed, bestDist, dot);
    }
  }

  onCut(n, v, speed, dist, dot) {
    n.done = true;
    const acc = Math.max(0, 1 - dist / HIT_R);
    const pts = Math.round(70 + 30 * acc + Math.min(15, (speed - MIN_SPEED) * 3) * Math.max(0, dot));
    this.combo++; this.maxCombo = Math.max(this.maxCombo, this.combo); this.hits++;
    this.multProg++;
    const need = this.mult === 1 ? 2 : this.mult === 2 ? 4 : this.mult === 4 ? 8 : Infinity;
    if (this.multProg >= need) { this.mult *= 2; this.multProg = 0; }
    this.score += pts * this.mult;
    this.energy = Math.min(1, this.energy + 0.015);
    this.app.hud.score(this.score, this.combo, this.mult);
    this.app.hud.energy(this.diff.fail ? this.energy : null);
    if (pts >= 110) this.app.hud.toast('PERFECT', '#ffd166', 350);
    sfx.slice(n.hand === 'L' ? 0.9 : 1.1);
    this.sliceFx(n, v);
  }

  sliceFx(n, v) {
    const p = n.mesh.position.clone(), color = COLORS[n.hand];
    this.scene.remove(n.mesh);
    const ang = Math.atan2(v.y, v.x);
    const perp = new THREE.Vector3(-Math.sin(ang), Math.cos(ang), 0);
    for (const s of [-1, 1]) {
      const m = new THREE.Mesh(this.halfGeo, this.blockMat[n.hand]);
      m.position.copy(p).addScaledVector(perp, 0.2 * s);
      m.rotation.z = ang;
      const vel = perp.clone().multiplyScalar(2.6 * s).add(new THREE.Vector3(v.x * 0.12, v.y * 0.12, -3));
      this.scene.add(m);
      this.debris.push({ mesh: m, vel, spin: new THREE.Vector3(Math.random() * 8 - 4, Math.random() * 8 - 4, 0), life: 0.7 });
    }
    const dl = Math.hypot(v.x, v.y) || 1;
    this.particles.burst(p.x, p.y, p.z, color, 40, 4.5, 0.55, [v.x / dl, v.y / dl]);
  }

  onBadCut(n, label, v) {
    n.done = true; this.badCuts++;
    this.scene.remove(n.mesh);
    this.particles.burst(n.mesh.position.x, n.mesh.position.y, n.mesh.position.z, 0x888888, 18, 2.5, 0.4);
    this.breakCombo(label, 0.1);
  }
  onMiss(label) { this.misses++; this.breakCombo(label, 0.15); }
  onBomb(n) {
    n.done = true; this.bombsHit++;
    this.scene.remove(n.mesh);
    this.particles.burst(n.mesh.position.x, n.mesh.position.y, n.mesh.position.z, 0xffaa33, 70, 6, 0.8);
    sfx.boom();
    this.breakCombo('BOOM', 0.15);
  }
  breakCombo(label, cost) {
    this.combo = 0; this.multProg = 0; this.mult = Math.max(1, this.mult / 2);
    this.energy -= cost;
    this.app.hud.score(this.score, 0, this.mult);
    this.app.hud.energy(this.diff.fail ? Math.max(0, this.energy) : null);
    this.app.hud.toast(label, '#ff5470', 450);
    if (label !== 'BOOM') sfx.miss();
    if (this.diff.fail && this.energy <= 0) this.end(true);
    this.energy = Math.max(0, this.energy);
  }

  updateEnv(t, dt) {
    const beatPhase = t > 0 ? (t / this.spb) % 1 : 0;
    const pulse = Math.pow(1 - beatPhase, 3);
    this.cross.position.z = (Math.max(0, t) * this.diff.speed) % 4;
    for (const r of this.rings) {
      r.position.z += this.diff.speed * 0.35 * dt;
      if (r.position.z > 6) r.position.z -= 72;
      r.userData.mat.opacity = 0.18 + 0.6 * pulse;
      r.rotation.z = Math.sin(t * 0.3 + r.position.z * 0.05) * 0.15;
    }
    this.lasers.forEach((l, i) => {
      l.rotation.y = Math.sin(t * 0.7 + i) * 0.25 * (i < 3 ? 1 : -1);
      l.rotation.x = Math.cos(t * 0.5 + i * 2) * 0.08;
      l.material.opacity = 0.15 + 0.35 * pulse;
    });
  }

  updateSkeleton() {
    const b = this.app.body, arr = this.skel.geometry.attributes.position.array;
    BONES.forEach(([i, j], k) => {
      const p = b.body(i), q = b.body(j), ok = p.ok && q.ok;
      arr.set(ok ? [p.x, p.y, 0.5, q.x, q.y, 0.5] : [0, 0, 0, 0, 0, 0], k * 6);
    });
    this.skel.geometry.attributes.position.needsUpdate = true;
  }

  render() { this.app.renderer.render(this.scene, this.camera); }

  end(failed) {
    if (this.ended) return; this.ended = true;
    this.player.stop();
    const total = this.notes.filter(n => !n.bomb).length;
    const pct = this.maxScore ? this.score / this.maxScore : 0;
    const rank = failed ? 'F' : pct >= 0.9 ? 'SS' : pct >= 0.8 ? 'S' : pct >= 0.65 ? 'A' : pct >= 0.5 ? 'B' : pct >= 0.35 ? 'C' : 'D';
    this.app.finish({
      rank, failed, title: failed ? 'Level failed' : 'Level cleared!',
      stats: {
        Song: `${this.songName} (${this.opts.diff})`, Score: Math.round(this.score).toLocaleString(),
        Accuracy: `${(pct * 100).toFixed(1)}%`, 'Blocks cut': `${this.hits} / ${total}`,
        'Max combo': this.maxCombo, 'Misses / bad cuts': `${this.misses} / ${this.badCuts}`, Bombs: this.bombsHit,
      },
    });
  }

  dispose() {
    this.player.stop();
    this.scene.traverse(o => { o.geometry?.dispose?.(); });
    this.tex.dispose();
    this.app.renderer.setClearColor(0x000000, 0);
    this.app.renderer.clear();
  }
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const u = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
  return Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
}
