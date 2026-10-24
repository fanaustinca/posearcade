import * as THREE from 'three';
import { KP } from '../pose.js';
import { ctx as audio, sfx } from '../audio.js';

// World units: 1 = the player's shoulder width. x right, y up, origin at the
// player's shoulder centre when the game started (so stepping sideways or
// crouching moves you in the world, unlike Beat Slicer's body-centred frame).
const WALL_W = 12, WALL_H = 8, WALL_TOP = 4.6, FLOOR_Y = WALL_TOP - WALL_H;
const TEX_W = 1024, TEX_H = Math.round(TEX_W * WALL_H / WALL_W);
const SPAWN_Z = -45, TOTAL_WALLS = 20, LIVES = 3;
const R = { head: 0.42, torso: 0.36, upper: 0.3, fore: 0.28, hand: 0.33, leg: 0.36 };
const TOL = 0.14; // how far outside the hole a joint may poke and still count
// Being inside the hole isn't enough (arms down fits every hole): elbows,
// wrists and shoulder centre must also be near the target pose's.
const MATCH_R = 0.45;

// Arm angles in degrees (0 = pointing right on screen, 90 = up): [upper, fore]
// for the arm on the screen-left side, then the screen-right side.
const POSES = [
  { name: 'ARMS UP', L: [100, 95], R: [80, 85], tier: 0 },
  { name: 'T-POSE', L: [180, 180], R: [0, 0], tier: 0 },
  { name: 'ARMS DOWN', L: [255, 265], R: [285, 275], tier: 0 },
  { name: 'Y', L: [135, 130], R: [45, 50], tier: 0 },
  { name: 'FLEX', L: [180, 90], R: [0, 90], tier: 1 },
  { name: 'LEFT HAND UP', L: [95, 92], R: [285, 275], tier: 1 },
  { name: 'RIGHT HAND UP', L: [255, 265], R: [85, 88], tier: 1 },
  { name: 'DISCO', L: [225, 225], R: [45, 45], tier: 1 },
  { name: 'DISCO', L: [135, 135], R: [315, 315], tier: 1 },
  { name: 'ROBOT', L: [180, 270], R: [0, 270], tier: 2 },
  { name: 'W', L: [225, 100], R: [315, 80], tier: 2 },
  { name: 'AIRPLANE', L: [200, 200], R: [20, 20], tier: 2 },
];

const rad = (d) => d * Math.PI / 180;
const dir = (d) => [Math.cos(rad(d)), Math.sin(rad(d))];

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const u = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
  return Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
}

// Hole = union of capsules [ax, ay, bx, by, r] (a == b for circles) + torso quad.
function buildHole(pose, ox, oy, bones) {
  const caps = [], ls = [ox - 0.5, oy], rs = [ox + 0.5, oy], targets = { sc: [ox, oy] };
  const lh = [ox - 0.42, oy - bones.torso], rh = [ox + 0.42, oy - bones.torso];
  const head = [ox, oy + bones.head];
  caps.push([...head, ...head, R.head]);
  caps.push([...ls, ...rs, R.torso], [...ls, ...lh, R.torso], [...rs, ...rh, R.torso], [...lh, ...rh, R.torso]);
  caps.push([ox, oy, ...head, 0.22]); // neck
  for (const [side, s] of [['L', ls], ['R', rs]]) {
    const [ua, fa] = pose[side], u = dir(ua), f = dir(fa);
    const e = [s[0] + u[0] * bones.upper, s[1] + u[1] * bones.upper];
    const w = [e[0] + f[0] * bones.fore, e[1] + f[1] * bones.fore];
    const h = [w[0] + f[0] * 0.18, w[1] + f[1] * 0.18];
    caps.push([...s, ...e, R.upper], [...e, ...w, R.fore], [...h, ...h, R.hand]);
    targets[side === 'L' ? 'le' : 're'] = e; targets[side === 'L' ? 'lw' : 'rw'] = w;
  }
  // legs run off the bottom of the wall
  caps.push([...lh, lh[0] - 0.15, FLOOR_Y - 1, R.leg], [...rh, rh[0] + 0.15, FLOOR_Y - 1, R.leg]);
  const quad = [ls, rs, rh, lh];
  return { caps, quad, targets };
}

function insidePoly(px, py, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function holeDist(hole, x, y) {
  if (insidePoly(x, y, hole.quad)) return -1;
  let d = Infinity;
  for (const [ax, ay, bx, by, r] of hole.caps) d = Math.min(d, segDist(x, y, ax, ay, bx, by) - r);
  return d;
}

const toPx = (x, y) => [(x + WALL_W / 2) / WALL_W * TEX_W, (WALL_TOP - y) / WALL_H * TEX_H];
const pxPerUnit = TEX_W / WALL_W;

function traceHole(g, hole, grow) {
  g.lineCap = 'round';
  for (const [ax, ay, bx, by, r] of hole.caps) {
    const [x1, y1] = toPx(ax, ay), [x2, y2] = toPx(bx, by);
    g.lineWidth = (r * 2) * pxPerUnit + grow * 2;
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2 + 0.01, y2); g.stroke();
  }
  g.beginPath(); hole.quad.forEach(([x, y], i) => { const [px, py] = toPx(x, y); i ? g.lineTo(px, py) : g.moveTo(px, py); });
  g.closePath(); g.fill();
  if (grow) { g.lineWidth = grow * 2; g.stroke(); }
}

function wallTexture(hole, hue) {
  const c = document.createElement('canvas'); c.width = TEX_W; c.height = TEX_H;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, TEX_H);
  grad.addColorStop(0, `hsl(${hue}, 70%, 32%)`); grad.addColorStop(1, `hsl(${hue + 30}, 70%, 18%)`);
  g.fillStyle = grad; g.fillRect(0, 0, TEX_W, TEX_H);
  g.strokeStyle = `hsla(${hue}, 90%, 70%, .25)`; g.lineWidth = 2;
  for (let x = 0; x < TEX_W; x += 64) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, TEX_H); g.stroke(); }
  for (let y = 0; y < TEX_H; y += 64) { g.beginPath(); g.moveTo(0, y); g.lineTo(TEX_W, y); g.stroke(); }
  g.strokeStyle = g.fillStyle = '#9ff7ff';
  traceHole(g, hole, 7); // glowing rim
  g.globalCompositeOperation = 'destination-out';
  g.strokeStyle = g.fillStyle = '#000';
  traceHole(g, hole, 0);
  g.globalCompositeOperation = 'source-over';
  g.strokeStyle = `hsl(${hue}, 100%, 75%)`; g.lineWidth = 10; g.strokeRect(5, 5, TEX_W - 10, TEX_H - 10);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Outline only, shown around the player as the wall gets close.
function guideTexture(hole) {
  const c = document.createElement('canvas'); c.width = TEX_W; c.height = TEX_H;
  const g = c.getContext('2d');
  g.strokeStyle = g.fillStyle = '#9ff7ff';
  traceHole(g, hole, 5);
  g.globalCompositeOperation = 'destination-out';
  traceHole(g, hole, 0);
  return new THREE.CanvasTexture(c);
}

export class WallGame {
  constructor(app) {
    this.app = app;
    this.bones = { upper: 0.78, fore: 0.72, torso: 1.35, head: 0.62 };
    this.walls = []; this.wallIdx = 0; this.next = 0;
    this.score = 0; this.streak = 0; this.bestStreak = 0; this.lives = LIVES;
    this.perfect = 0; this.good = 0; this.crashes = 0;
    this.shake = 0;
    this.buildScene();
  }

  buildScene() {
    const scene = this.scene = new THREE.Scene();
    scene.background = new THREE.Color(0x07060f);
    scene.fog = new THREE.Fog(0x07060f, 20, 60);
    this.camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 200);
    this.camera.position.set(0, 0.6, 7); this.camera.lookAt(0, 0.2, -10);
    scene.add(new THREE.HemisphereLight(0xc0b8ff, 0x201030, 1.2));
    // floor grid
    const lines = [];
    for (let x = -6; x <= 6; x += 1.5) lines.push(x, FLOOR_Y, 6, x, FLOOR_Y, -60);
    for (let z = 6; z >= -60; z -= 3) lines.push(-6, FLOOR_Y, z, 6, FLOOR_Y, z);
    scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(lines, 3)),
      new THREE.LineBasicMaterial({ color: 0x4a35b0, transparent: true, opacity: 0.6 })));
    // side pillars
    for (const x of [-6.2, 6.2]) for (let z = 0; z > -60; z -= 10) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.15, WALL_H, 0.15), new THREE.MeshBasicMaterial({ color: 0x6a4cff }));
      m.position.set(x, FLOOR_Y + WALL_H / 2, z); scene.add(m);
    }
    // player silhouette: capsules made of a cylinder + spheres
    this.bodyMat = new THREE.MeshBasicMaterial({ color: 0x9ff7ff, transparent: true, opacity: 0.85 });
    this.limbs = {};
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 12), sph = new THREE.SphereGeometry(1, 14, 10);
    for (const k of ['ls_rs', 'ls_le', 'le_lw', 'rs_re', 're_rw', 'ls_lh', 'rs_rh', 'lh_rh', 'neck']) {
      const m = new THREE.Mesh(cyl, this.bodyMat.clone()); m.visible = false; scene.add(m); this.limbs[k] = m;
    }
    for (const k of ['head', 'lhand', 'rhand']) {
      const m = new THREE.Mesh(sph, this.bodyMat.clone()); m.visible = false; scene.add(m); this.limbs[k] = m;
    }
    this.wallGeo = new THREE.PlaneGeometry(WALL_W, WALL_H);
    this.particles = [];
    this.app.renderer.setClearColor(0x07060f, 1);
  }

  resize() {
    const a = innerWidth / innerHeight;
    this.camera.aspect = a;
    this.camera.position.z = Math.max(7, 5.2 / (Math.tan(rad(27.5)) * a));
    this.camera.updateProjectionMatrix();
  }

  start() {
    this.resize();
    const b = this.app.body;
    this.ref = { ...b.center };
    this.app.hud.energy(null);
    this.app.hud.score(0, 0, 1);
    this.app.hud.toast('Fit through the holes!', '#9ff7ff', 1600);
    this.t0 = audio.currentTime;
    this.next = 2.5;
  }

  time() { return audio.currentTime - this.t0; }

  // Player joint in world units (see top of file).
  W(i) {
    const s = this.app.body.screen(i), a = this.app.pose.aspect, sc = this.app.body.scale;
    return { x: (s.x * a - this.ref.x) / sc, y: (this.ref.y - s.y) / sc, ok: s.ok };
  }
  H(side) {
    const s = this.app.body.handScreen(side), a = this.app.pose.aspect, sc = this.app.body.scale;
    return { x: (s.x * a - this.ref.x) / sc, y: (this.ref.y - s.y) / sc, ok: s.ok };
  }

  measureBones() {
    const d = (a, b) => (a.ok && b.ok) ? Math.hypot(a.x - b.x, a.y - b.y) : null;
    const j = (i) => this.W(i);
    const ls = j(KP.leftShoulder), rs = j(KP.rightShoulder), mid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2, ok: ls.ok && rs.ok };
    const lh = j(KP.leftHip), rh = j(KP.rightHip), hip = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2, ok: lh.ok && rh.ok };
    const obs = {
      upper: [d(ls, j(KP.leftElbow)), d(rs, j(KP.rightElbow))],
      fore: [d(j(KP.leftElbow), j(KP.leftWrist)), d(j(KP.rightElbow), j(KP.rightWrist))],
      torso: [d(mid, hip)], head: [d(mid, j(KP.nose))],
    };
    const lim = { upper: [0.5, 1.1], fore: [0.45, 1.0], torso: [0.9, 1.9], head: [0.35, 0.9] };
    // creep up toward the longest (least foreshortened) observation
    for (const k in obs) for (const v of obs[k]) {
      if (v == null || v < lim[k][0] || v > lim[k][1]) continue;
      this.bones[k] += (v - this.bones[k]) * (v > this.bones[k] ? 0.15 : 0.003);
    }
  }

  makeWall() {
    const i = this.wallIdx++, tier = i < 4 ? 0 : i < 9 ? 1 : 2;
    const pool = POSES.filter(p => p.tier <= tier);
    const pose = pool[Math.floor(Math.random() * pool.length)];
    let ox = 0, oy = 0, label = pose.name;
    if (i >= 3 && Math.random() < 0.6) { ox = Math.random() < 0.5 ? -1.7 : 1.7; label += ox < 0 ? ' · STEP LEFT' : ' · STEP RIGHT'; }
    if (i >= 7 && Math.random() < 0.3 && pose.name !== 'ARMS DOWN') { oy = -0.85; label += ' · CROUCH'; }
    const hole = buildHole(pose, ox, oy, this.bones);
    const hue = 250 + (i * 37) % 110;
    const mesh = new THREE.Mesh(this.wallGeo, new THREE.MeshBasicMaterial({ map: wallTexture(hole, hue), transparent: true, side: THREE.DoubleSide, alphaTest: 0.05 }));
    mesh.position.set(0, WALL_TOP - WALL_H / 2, SPAWN_Z);
    const guide = new THREE.Mesh(this.wallGeo, new THREE.MeshBasicMaterial({ map: guideTexture(hole), transparent: true, opacity: 0, depthWrite: false }));
    guide.position.set(0, WALL_TOP - WALL_H / 2, 0.05);
    this.scene.add(mesh, guide);
    const approach = Math.max(2.3, 4.4 - i * 0.12);
    const w = { hole, mesh, guide, t: this.time() + approach, approach, judged: false, label };
    this.walls.push(w);
    this.app.hud.toast(label, '#9ff7ff', 1300);
    this.next = w.t + 0.9;
  }

  fit(hole) {
    const pts = [KP.nose, KP.leftShoulder, KP.rightShoulder, KP.leftElbow, KP.rightElbow, KP.leftWrist, KP.rightWrist, KP.leftHip, KP.rightHip]
      .map(i => this.W(i)).concat([this.H('L'), this.H('R')]);
    const mids = [[KP.leftShoulder, KP.leftElbow], [KP.leftElbow, KP.leftWrist], [KP.rightShoulder, KP.rightElbow], [KP.rightElbow, KP.rightWrist]]
      .map(([a, b]) => { const p = this.W(a), q = this.W(b); return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, ok: p.ok && q.ok }; });
    const all = pts.concat(mids).filter(p => p.ok);
    if (all.length < 5) return 0;
    const inside = all.filter(p => holeDist(hole, p.x, p.y) < TOL).length / all.length;
    return Math.min(inside, this.match(hole));
  }

  // Fraction of target joints (elbows, wrists, shoulder centre) the player hits.
  match(hole) {
    const T = hole.targets, ls = this.W(KP.leftShoulder), rs = this.W(KP.rightShoulder);
    const have = {
      sc: { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2, ok: ls.ok && rs.ok },
      le: this.W(KP.leftElbow), lw: this.W(KP.leftWrist), re: this.W(KP.rightElbow), rw: this.W(KP.rightWrist),
    };
    let n = 0, hit = 0;
    for (const k in T) {
      n++;
      const p = have[k];
      if (p.ok && Math.hypot(p.x - T[k][0], p.y - T[k][1]) < MATCH_R) hit++;
    }
    return hit / n;
  }

  update(dt) {
    const t = this.time();
    this.measureBones();
    if (t >= this.next && this.wallIdx < TOTAL_WALLS && this.lives > 0) this.makeWall();

    const near = this.walls.find(w => !w.judged);
    for (const w of this.walls) {
      const z = SPAWN_Z * (w.t - t) / w.approach;
      w.mesh.position.z = Math.min(z, 8);
      const left = w.t - t;
      w.guide.material.opacity = w.judged ? Math.max(0, w.guide.material.opacity - dt * 3) : Math.max(0, Math.min(0.9, 1 - left / 1.6));
      if (!w.judged && t >= w.t) this.judge(w);
      if (w.mesh.position.z >= 7.9) { this.scene.remove(w.mesh, w.guide); w.dead = true; }
    }
    this.walls = this.walls.filter(w => !w.dead);
    this.updateBody(near && near.t - t < 1.6 ? near.hole : null);
    this.updateParticles(dt);
    this.shake = Math.max(0, this.shake - dt * 2);
    this.camera.position.x = (Math.random() - 0.5) * this.shake * 0.4;
    this.app.hud.progress(Math.min(1, this.wallIdx / TOTAL_WALLS));
    const done = (this.wallIdx >= TOTAL_WALLS || this.lives <= 0) && this.walls.every(w => w.judged);
    if (done && !this.endAt) this.endAt = t + 1.2;
    if (this.endAt && t > this.endAt) this.end();
  }

  judge(w) {
    w.judged = true;
    const f = this.fit(w.hole);
    if (f >= 0.8) {
      const perfect = f >= 0.95;
      this.streak++; this.bestStreak = Math.max(this.bestStreak, this.streak);
      perfect ? this.perfect++ : this.good++;
      this.score += (perfect ? 300 : 150) + 50 * Math.min(this.streak - 1, 6);
      this.app.hud.toast(perfect ? 'PERFECT FIT!' : 'SQUEEZED THROUGH', perfect ? '#ffd166' : '#3ee08f', 800);
      perfect ? sfx.chord(72) : sfx.ding(79);
    } else {
      this.streak = 0; this.crashes++; this.lives--;
      this.app.hud.toast(`CRASH! ${'♥'.repeat(Math.max(0, this.lives))}`, '#ff5470', 900);
      sfx.boom(); this.shake = 1;
      this.burst(w);
      w.mesh.visible = false;
    }
    this.app.hud.score(this.score, this.streak, 1);
  }

  burst(w) {
    const g = new THREE.BoxGeometry(0.4, 0.4, 0.15);
    const mat = new THREE.MeshBasicMaterial({ color: w.mesh.material.map ? 0x8a6cff : 0xffffff });
    for (let k = 0; k < 60; k++) {
      const m = new THREE.Mesh(g, mat);
      m.position.set((Math.random() - 0.5) * WALL_W, FLOOR_Y + Math.random() * WALL_H, 0);
      this.scene.add(m);
      this.particles.push({ m, v: new THREE.Vector3((Math.random() - 0.5) * 8, Math.random() * 6, 3 + Math.random() * 6), s: new THREE.Vector3(Math.random() * 6, Math.random() * 6, 0), life: 1.4 });
    }
  }
  updateParticles(dt) {
    for (const p of this.particles) {
      p.life -= dt; p.v.y -= 12 * dt;
      p.m.position.addScaledVector(p.v, dt);
      p.m.rotation.x += p.s.x * dt; p.m.rotation.y += p.s.y * dt;
      if (p.life <= 0) this.scene.remove(p.m);
    }
    this.particles = this.particles.filter(p => p.life > 0);
  }

  // Glowing silhouette of the player; parts turn green/red against the
  // incoming hole once it's close.
  updateBody(hole) {
    const J = {
      ls: this.W(KP.leftShoulder), rs: this.W(KP.rightShoulder), le: this.W(KP.leftElbow), re: this.W(KP.rightElbow),
      lw: this.W(KP.leftWrist), rw: this.W(KP.rightWrist), lh: this.W(KP.leftHip), rh: this.W(KP.rightHip), n: this.W(KP.nose),
    };
    const neckBase = { x: (J.ls.x + J.rs.x) / 2, y: (J.ls.y + J.rs.y) / 2, ok: J.ls.ok && J.rs.ok };
    const near = (p, k) => !k || (hole.targets[k] && Math.hypot(p.x - hole.targets[k][0], p.y - hole.targets[k][1]) < MATCH_R);
    const color = (pts, keys = []) => {
      if (!hole) return 0x9ff7ff;
      const ok = pts.every(p => holeDist(hole, p.x, p.y) < TOL) && keys.every(([p, k]) => near(p, k));
      return ok ? 0x3ee08f : 0xff4060;
    };
    const seg = (key, a, b, r, keys) => {
      const m = this.limbs[key];
      if (!a.ok || !b.ok) { m.visible = false; return; }
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      m.visible = true;
      m.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, 0);
      m.scale.set(r, Math.max(0.01, len), r);
      m.rotation.set(0, 0, Math.atan2(b.y - a.y, b.x - a.x) - Math.PI / 2);
      m.material.color.setHex(color([a, b, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }], keys));
    };
    const ball = (key, p, r) => {
      const m = this.limbs[key];
      if (!p.ok) { m.visible = false; return; }
      m.visible = true; m.position.set(p.x, p.y, 0); m.scale.setScalar(r);
      m.material.color.setHex(color([p]));
    };
    seg('ls_rs', J.ls, J.rs, 0.14, [[neckBase, 'sc']]);
    seg('ls_le', J.ls, J.le, 0.12, [[J.le, 'le']]); seg('le_lw', J.le, J.lw, 0.11, [[J.le, 'le'], [J.lw, 'lw']]);
    seg('rs_re', J.rs, J.re, 0.12, [[J.re, 're']]); seg('re_rw', J.re, J.rw, 0.11, [[J.re, 're'], [J.rw, 'rw']]);
    seg('ls_lh', J.ls, J.lh, 0.14); seg('rs_rh', J.rs, J.rh, 0.14); seg('lh_rh', J.lh, J.rh, 0.14);
    seg('neck', neckBase, J.n, 0.09);
    ball('head', J.n, 0.3); ball('lhand', this.H('L'), 0.17); ball('rhand', this.H('R'), 0.17);
  }

  render() { this.app.renderer.render(this.scene, this.camera); }

  end() {
    if (this.ended) return; this.ended = true;
    const walls = this.perfect + this.good + this.crashes;
    const pct = walls ? (this.perfect + this.good * 0.6) / walls : 0;
    const failed = this.lives <= 0;
    const rank = failed ? (pct >= 0.5 ? 'C' : 'D') : pct >= 0.9 ? 'S' : pct >= 0.75 ? 'A' : pct >= 0.55 ? 'B' : 'C';
    this.app.finish({
      rank, failed, title: failed ? 'Out of lives!' : 'Wall run complete!',
      stats: {
        Score: this.score.toLocaleString(), 'Walls passed': `${this.perfect + this.good} / ${walls}`,
        'Perfect fits': this.perfect, 'Best streak': this.bestStreak, Crashes: this.crashes,
      },
    });
  }

  dispose() {
    this.scene.traverse(o => { o.geometry?.dispose?.(); o.material?.map?.dispose?.(); });
    this.app.renderer.setClearColor(0x000000, 0);
    this.app.renderer.clear();
  }
}

// exported for tests
export { POSES, buildHole, holeDist, TOL, MATCH_R };
