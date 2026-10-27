import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ctx as audio, sfx, sfxBus } from '../audio.js';
import { Body } from '../pose.js';

// Star Gunner: you sit in a ship's gun seat. Hands held together are the gun;
// where they are relative to your chest sets yaw/pitch. Hands together = fire.
const YAW_MAX = 50, PITCH_MAX = 32, GAIN = 42; // degrees; GAIN = degrees per shoulder-width of hand travel
const FIRE_EVERY = 0.11, BOLT_SPEED = 650;      // seconds, units/s
const D2R = Math.PI / 180;

// together = hands closer than this (shoulder widths) count as joined; assist =
// degrees of aim forgiveness; speed/plasma scale enemy speeds; dmg scales hull
// damage; spawn scales the gap between spawns; count scales enemies per wave;
// regen = hull back after each wave.
export const SG_DIFFS = {
  Easy:   { together: 1.2, assist: 5.0, speed: 0.55, plasma: 0.55, dmg: 0.45, spawn: 1.5, count: 0.7, regen: 30 },
  Normal: { together: 1.0, assist: 3.2, speed: 0.75, plasma: 0.75, dmg: 0.7,  spawn: 1.2, count: 0.85, regen: 20 },
  Hard:   { together: 0.8, assist: 1.6, speed: 1.0,  plasma: 1.0,  dmg: 1.0,  spawn: 1.0, count: 1.0, regen: 10 },
};

function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const rand = (a, b) => a + Math.random() * (b - a);

function glowTexture(inner = 'rgba(255,255,255,1)') {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, inner); gr.addColorStop(0.25, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

// ---------- procedural sky + planet shaders ----------
const NOISE_GLSL = `
float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z); }
float fbm(vec3 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 6; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }`;

function makeSky() {
  return new THREE.Mesh(new THREE.SphereGeometry(900, 64, 32), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, uniforms: { uTime: { value: 0 } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform float uTime; varying vec3 vDir; ${NOISE_GLSL}
      void main(){
        vec3 d = normalize(vDir);
        float n = fbm(d * 2.2 + vec3(0.0, 0.0, uTime * 0.004));
        float n2 = fbm(d * 4.5 + 7.3);
        float band = exp(-pow((d.y + 0.25 * d.x) * 2.2, 2.0)); // nebula lane across the sky
        vec3 col = vec3(0.004, 0.006, 0.02);
        col += vec3(0.32, 0.06, 0.42) * smoothstep(0.42, 0.85, n) * (0.4 + band);
        col += vec3(0.03, 0.22, 0.45) * smoothstep(0.48, 0.9, n2) * (0.3 + band);
        col += vec3(0.95, 0.35, 0.55) * pow(smoothstep(0.55, 0.95, n * n2 * 1.7), 2.0) * band * 0.9;
        vec3 q = d * 700.0, cell = floor(q);
        float s = hash(cell), r = length(fract(q) - 0.5);
        col += vec3(0.8, 0.85, 1.0) * step(0.996, s) * smoothstep(0.35, 0.0, r) * (0.5 + 1.5 * hash(cell + 3.1));
        gl_FragColor = vec4(col, 1.0);
      }`,
  }));
}

function makePlanet(sunDir) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(150, 96, 64), new THREE.ShaderMaterial({
    uniforms: { uSun: { value: sunDir } },
    vertexShader: `varying vec3 vN; varying vec3 vP; varying vec3 vW;
      void main(){ vN = normalize(mat3(modelMatrix) * normal); vP = position; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform vec3 uSun; varying vec3 vN; varying vec3 vP; varying vec3 vW; ${NOISE_GLSL}
      void main(){
        vec3 p = normalize(vP);
        float bands = sin(p.y * 22.0 + fbm(p * 3.0) * 6.0) * 0.5 + 0.5;
        float storms = fbm(p * 7.0 + vec3(bands));
        vec3 base = mix(vec3(0.55, 0.28, 0.18), vec3(0.95, 0.72, 0.48), bands);
        base = mix(base, vec3(0.35, 0.12, 0.25), smoothstep(0.55, 0.8, storms) * 0.6);
        float light = clamp(dot(vN, uSun), 0.0, 1.0);
        vec3 V = normalize(cameraPosition - vW);
        float rim = pow(1.0 - max(dot(vN, V), 0.0), 3.0);
        vec3 col = base * (0.04 + 1.1 * light) + vec3(0.35, 0.55, 1.0) * rim * (0.2 + light);
        gl_FragColor = vec4(col, 1.0);
      }`,
  }));
  const atmo = new THREE.Mesh(new THREE.SphereGeometry(162, 64, 48), new THREE.ShaderMaterial({
    transparent: true, blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false, uniforms: { uSun: { value: sunDir } },
    vertexShader: `varying vec3 vN; varying vec3 vW; void main(){ vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform vec3 uSun; varying vec3 vN; varying vec3 vW;
      void main(){ vec3 V = normalize(cameraPosition - vW); float f = pow(1.0 - abs(dot(vN, V)), 2.5);
        float lit = 0.25 + 0.75 * clamp(dot(-vN, uSun) * 0.5 + 0.5, 0.0, 1.0);
        gl_FragColor = vec4(vec3(0.3, 0.55, 1.0) * f * lit * 0.8, 1.0); }`,
  }));
  g.add(body, atmo);
  return g;
}

// Lumpy rock: icosphere pushed around by a few big bumps + per-vertex jitter.
function makeRockGeo(seed) {
  const R = rng(seed), g = new THREE.IcosahedronGeometry(1, 3), pos = g.attributes.position, v = new THREE.Vector3();
  const bumps = Array.from({ length: 8 }, () => ({ d: new THREE.Vector3(R() * 2 - 1, R() * 2 - 1, R() * 2 - 1).normalize(), a: (R() - 0.45) * 0.55, w: 2 + R() * 5 }));
  const jitter = (x, y, z) => { const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed) * 43758.5453; return h - Math.floor(h); };
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    let r = 1;
    for (const b of bumps) r += b.a * Math.pow(Math.max(0, v.dot(b.d)), b.w);
    r += (jitter(+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)) - 0.5) * 0.14;
    pos.setXYZ(i, v.x * r, v.y * r * 0.82, v.z * r);
  }
  g.computeVertexNormals();
  return g;
}

export class ShooterGame {
  // opts: diff, and for split screen: duel, body, view = [x0, x1] (fractions of the window), seed, label, color
  constructor(app, opts = {}) {
    this.app = app;
    this.D = SG_DIFFS[opts.diff] || SG_DIFFS.Easy;
    this.body = opts.body || app.body;
    this.view = opts.view || [0, 1];
    this.duel = !!opts.duel; this.label = opts.label; this.color = opts.color || '#9ff7ff';
    const R = rng(opts.seed || (Math.random() * 1e9)); // enemy spawns: same seed = same waves for both players
    this.rr = (a, b) => a + R() * (b - a); this.R = R;
    this.hudState = { score: 0, hull: 1, toast: null };
    this.enemies = []; this.bolts = []; this.plasma = []; this.fx = []; this.debris = [];
    this.score = 0; this.hull = 100; this.wave = 0; this.queue = []; this.spawnT = 0; this.waveGap = 2.5;
    this.shots = 0; this.hitsLanded = 0; this.kills = { rock: 0, alien: 0, ship: 0, plasma: 0 };
    this.yaw = 0; this.pitch = 0; this.firing = false; this.fireT = 0; this.barrel = 0;
    this.neutral = { x: 0, y: -0.55 }; this.calib = 3.5; this.apartFor = 0;
    this.shake = 0; this.damageFlash = 0; this.hitMark = 0; this.onTarget = false; this.time = 0;
    this.build();
  }

  vx() { return Math.round(innerWidth * this.view[0]); }
  vw() { return Math.round(innerWidth * (this.view[1] - this.view[0])); }

  // HUD: the shared DOM HUD for one player, drawn into our half for split screen
  hudScore() { if (this.duel) this.hudState.score = this.score; else this.app.hud.score(this.score, 0, 1); }
  hudHull() { if (this.duel) this.hudState.hull = this.hull / 100; else this.app.hud.energy(this.hull / 100); }
  toast(text, color, ms) {
    if (this.duel) this.hudState.toast = { text, color, until: this.time + ms / 1000 };
    else this.app.hud.toast(text, color, ms);
  }

  build() {
    const r = this.app.renderer;
    this.prevTone = r.toneMapping; this.prevExposure = r.toneMappingExposure;
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.05;
    const scene = this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, this.vw() / innerHeight, 0.05, 2000);
    scene.add(this.camera);
    this.sunDir = new THREE.Vector3(0.55, 0.35, -0.75).normalize();
    this.sky = makeSky(); scene.add(this.sky);
    const planet = makePlanet(this.sunDir); planet.position.set(-300, -150, -620); scene.add(planet); this.planet = planet;
    this.glow = glowTexture();
    const sun = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: 0xfff1d0, blending: THREE.AdditiveBlending, depthWrite: false }));
    sun.position.copy(this.sunDir).multiplyScalar(800); sun.scale.setScalar(160); scene.add(sun);
    scene.add(new THREE.AmbientLight(0x404a70, 0.6));
    const key = new THREE.DirectionalLight(0xfff0dd, 2.4); key.position.set(40, 50, 60); scene.add(key);
    const rim = new THREE.DirectionalLight(0xffd6a0, 2.0); rim.position.copy(this.sunDir).multiplyScalar(100); scene.add(rim);
    const fill = new THREE.DirectionalLight(0x6a4cff, 0.7); fill.position.set(-1, -0.5, 0.5); scene.add(fill);
    this.flash = new THREE.PointLight(0xffa040, 0, 120, 1.5); scene.add(this.flash);

    // stars streaming past = we're flying forward
    const N = 2600, sp = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) { sp[i * 3] = rand(-260, 260); sp[i * 3 + 1] = rand(-180, 180); sp[i * 3 + 2] = rand(-700, 20); }
    this.stars = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(sp, 3)),
      new THREE.PointsMaterial({ size: 1.3, color: 0xcfe0ff, map: this.glow, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.stars.frustumCulled = false; scene.add(this.stars);

    // shared resources
    this.rockGeos = Array.from({ length: 6 }, (_, i) => makeRockGeo(i * 977 + 13));
    this.rockMats = [0x6e6158, 0x5b5149, 0x7f6d5c, 0x4d4a52].map(c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.92, metalness: 0.08, flatShading: true }));
    this.boltGeo = new THREE.CylinderGeometry(0.06, 0.06, 1, 6); this.boltGeo.rotateX(Math.PI / 2);
    this.boltMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 2.2, 3.2), toneMapped: false });
    this.plasmaMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 3.0, 0.8), toneMapped: false });
    this.sphereGeo = new THREE.SphereGeometry(1, 20, 14);
    this.buildCockpit();
    this.buildParticles();

    this.composer = new EffectComposer(r);
    this.composer.addPass(new RenderPass(scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(this.vw(), innerHeight), 0.85, 0.45, 0.25);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  buildCockpit() {
    const ck = this.cockpit = new THREE.Group(); this.camera.add(ck);
    const metal = new THREE.MeshStandardMaterial({ color: 0x3a3f52, metalness: 0.8, roughness: 0.35 });
    const trimC = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.15, 1.1, 1.6), toneMapped: false });
    const trimM = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.45, 0.08, 0.4), toneMapped: false });
    this.ckParts = {
      dash: new THREE.Mesh(new THREE.BoxGeometry(1, 0.3, 0.7), new THREE.MeshStandardMaterial({ color: 0x0d0f16, metalness: 0.6, roughness: 0.55 })),
      dashTrim: new THREE.Mesh(new THREE.BoxGeometry(1, 0.012, 0.012), trimC),
      left: new THREE.Mesh(new THREE.BoxGeometry(0.14, 1, 0.14), metal),
      right: new THREE.Mesh(new THREE.BoxGeometry(0.14, 1, 0.14), metal),
      leftTrim: new THREE.Mesh(new THREE.BoxGeometry(0.006, 1, 0.006), trimM),
      rightTrim: new THREE.Mesh(new THREE.BoxGeometry(0.006, 1, 0.006), trimM),
      top: new THREE.Mesh(new THREE.BoxGeometry(1, 0.1, 0.14), metal),
      topTrim: new THREE.Mesh(new THREE.BoxGeometry(1, 0.01, 0.012), trimC),
    };
    Object.values(this.ckParts).forEach(m => ck.add(m));
    // little blinking dashboard lights
    this.dashLights = [];
    for (let i = 0; i < 14; i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.012, 0.02), new THREE.MeshBasicMaterial({ color: new THREE.Color(...[[2, 0.4, 0.3], [0.3, 2, 0.6], [0.3, 1.2, 2.4]][i % 3]), toneMapped: false }));
      ck.add(m); this.dashLights.push(m);
    }
    // twin-barrel turret
    const tur = this.turret = new THREE.Group(); ck.add(tur);
    const base = new THREE.Mesh(new THREE.SphereGeometry(0.14, 24, 16), metal); tur.add(base);
    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.34), metal); housing.position.z = -0.12; tur.add(housing);
    this.muzzles = [];
    for (const sx of [-0.08, 0.08]) {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.03, 0.62, 12), metal);
      barrel.rotation.x = Math.PI / 2; barrel.position.set(sx, 0.01, -0.5); tur.add(barrel);
      for (const z of [-0.35, -0.55, -0.75]) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.006, 6, 16), trimC);
        ring.position.set(sx, 0.01, z); tur.add(ring);
      }
      const muzzle = new THREE.Object3D(); muzzle.position.set(sx, 0.01, -0.82); tur.add(muzzle);
      const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: 0x9ff7ff, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
      flash.scale.setScalar(0.001); muzzle.add(flash);
      this.muzzles.push({ obj: muzzle, flash, heat: 0 });
    }
    this.layoutCockpit();
  }

  // Fit the canopy frame to the screen's aspect ratio.
  layoutCockpit() {
    const z = -1, hh = Math.tan(35 * D2R), hw = hh * this.camera.aspect, P = this.ckParts;
    P.dash.scale.x = hw * 2 + 0.4; P.dash.position.set(0, -hh - 0.02, z - 0.1); P.dash.rotation.x = -0.45;
    P.dashTrim.scale.x = hw * 2 + 0.4; P.dashTrim.position.set(0, -hh + 0.12, z + 0.08);
    for (const [m, t, s] of [[P.left, P.leftTrim, -1], [P.right, P.rightTrim, 1]]) {
      m.scale.y = t.scale.y = hh * 2 + 0.5;
      m.position.set(s * (hw + 0.01), 0, z); m.rotation.z = s * 0.16;
      t.position.set(s * (hw - 0.065), 0, z + 0.075); t.rotation.z = s * 0.16;
    }
    P.top.scale.x = P.topTrim.scale.x = hw * 2 + 0.2; P.top.position.set(0, hh + 0.02, z); P.topTrim.position.set(0, hh - 0.03, z + 0.075);
    this.dashLights.forEach((m, i) => m.position.set(-hw * 0.75 + (i % 7) * 0.09 + (i >= 7 ? hw * 1.5 - 0.54 : 0), -hh + 0.07, z + 0.05));
    this.turret.position.set(0, -hh * 0.78, -1.1); this.turret.scale.setScalar(0.62);
  }

  buildParticles() {
    const N = this.pN = 2400;
    this.pPos = new Float32Array(N * 3); this.pCol = new Float32Array(N * 3); this.pVel = new Float32Array(N * 3);
    this.pLife = new Float32Array(N); this.pMax = new Float32Array(N); this.pBase = new Float32Array(N * 3); this.pNext = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3)); g.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    this.particles = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.1, map: this.glow, vertexColors: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.particles.frustumCulled = false; this.scene.add(this.particles);
    this.ringGeo = new THREE.RingGeometry(0.8, 1, 48);
  }

  burst(p, color, n, speed, life, size = 1) {
    const c = new THREE.Color(color);
    for (let k = 0; k < n; k++) {
      const i = this.pNext = (this.pNext + 1) % this.pN;
      this.pPos[i * 3] = p.x; this.pPos[i * 3 + 1] = p.y; this.pPos[i * 3 + 2] = p.z;
      const v = new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize().multiplyScalar(speed * rand(0.2, 1));
      this.pVel[i * 3] = v.x; this.pVel[i * 3 + 1] = v.y; this.pVel[i * 3 + 2] = v.z;
      this.pLife[i] = this.pMax[i] = life * rand(0.5, 1.2);
      const hot = Math.random() < 0.35 ? 1.6 : 1;
      this.pBase[i * 3] = c.r * hot * size; this.pBase[i * 3 + 1] = c.g * hot * size; this.pBase[i * 3 + 2] = c.b * hot * size;
    }
  }

  explode(p, scale, kind) {
    const pal = kind === 'rock' ? [0xffa040, 0xff5a20, 0xffe0a0] : kind === 'plasma' ? [0x60ff90, 0xc0ffd0, 0x40ff60] : [0x60f0ff, 0xff60e0, 0xffffff];
    this.burst(p, pal[0], 70 * scale, 22 * scale, 0.9, 2.2);
    this.burst(p, pal[1], 50 * scale, 12 * scale, 1.3, 1.6);
    this.burst(p, pal[2], 30 * scale, 34 * scale, 0.45, 2.8);
    // fireball + shockwave
    const ball = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: pal[0], blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    ball.position.copy(p); this.scene.add(ball);
    this.fx.push({ obj: ball, life: 0.5, max: 0.5, grow: 9 * scale, kind: 'ball' });
    const ring = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: pal[2], transparent: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    ring.position.copy(p); ring.lookAt(this.camera.position); this.scene.add(ring);
    this.fx.push({ obj: ring, life: 0.6, max: 0.6, grow: 14 * scale, kind: 'ring' });
    if (kind === 'rock') for (let k = 0; k < 6 * scale; k++) {
      const m = new THREE.Mesh(this.rockGeos[k % 6], this.rockMats[k % 4]);
      m.position.copy(p); m.scale.setScalar(rand(0.2, 0.5) * scale); this.scene.add(m);
      this.debris.push({ m, v: new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(14 * scale), s: new THREE.Vector3(rand(-4, 4), rand(-4, 4), 0), life: 1.6 });
    }
    this.flash.position.copy(p); this.flash.intensity = 900 * scale;
    this.shake = Math.min(1, this.shake + 0.12 * scale * (60 / Math.max(20, p.length())));
    sfx.boom();
  }

  // ---------- enemies ----------
  spawnPoint(minD, maxD, coneYaw = 40, conePitch = 22) {
    const rand = this.rr, yaw = rand(-coneYaw, coneYaw) * D2R, pitch = rand(-conePitch, conePitch) * D2R, d = rand(minD, maxD);
    return new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch) * d, Math.sin(pitch) * d, -Math.cos(yaw) * Math.cos(pitch) * d);
  }

  addRock(pos, size, vel) {
    const m = new THREE.Mesh(this.rockGeos[Math.floor(Math.random() * 6)], this.rockMats[Math.floor(Math.random() * 4)]);
    m.scale.setScalar(size); m.position.copy(pos); m.rotation.set(rand(0, 6), rand(0, 6), rand(0, 6));
    this.scene.add(m);
    const rr = this.rr, target = new THREE.Vector3(rr(-10, 10), rr(-7, 7), 0);
    this.enemies.push({ type: 'rock', obj: m, r: size * 1.05, hp: Math.ceil(size * 0.9), maxHp: Math.ceil(size * 0.9),
      vel: vel || target.sub(pos).normalize().multiplyScalar((rr(11, 17) + this.wave * 0.8) * this.D.speed), spin: new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)), size });
  }

  addAlien() {
    const g = new THREE.Group();
    const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(1.1, 1), new THREE.MeshStandardMaterial({ color: 0x2a1240, metalness: 0.6, roughness: 0.3, flatShading: true }));
    const eye = new THREE.Mesh(this.sphereGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.4, 0.2), toneMapped: false }));
    eye.scale.setScalar(0.42); eye.position.z = 0.85;
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: 0xff4020, blending: THREE.AdditiveBlending, depthWrite: false }));
    halo.scale.setScalar(2.4); halo.position.z = 0.9;
    g.add(shell, eye, halo);
    const spikeM = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 2.4, 0.5), toneMapped: false });
    for (let k = 0; k < 6; k++) {
      const s = new THREE.Mesh(new THREE.ConeGeometry(0.16, 1.1, 8), spikeM);
      const a = k / 6 * Math.PI * 2; s.position.set(Math.cos(a) * 1.15, Math.sin(a) * 1.15, -0.2); s.rotation.z = a - Math.PI / 2; g.add(s);
    }
    g.scale.setScalar(1.5); g.position.copy(this.spawnPoint(95, 115)); this.scene.add(g);
    const rr = this.rr;
    this.enemies.push({ type: 'alien', obj: g, r: 2.4, hp: 2, maxHp: 2, phase: rr(0, 6), speed: (rr(16, 22) + this.wave * 0.8) * this.D.speed, wob: rr(5, 9) });
  }

  addShip() {
    const g = new THREE.Group();
    const hullM = new THREE.MeshStandardMaterial({ color: 0xb8c0d0, metalness: 0.95, roughness: 0.22 });
    const disc = new THREE.Mesh(new THREE.SphereGeometry(3.2, 48, 24), hullM); disc.scale.set(1, 0.24, 1);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1.35, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x40ffd0, emissive: 0x20a090, emissiveIntensity: 1.2, transparent: true, opacity: 0.75, metalness: 0.2, roughness: 0.1 }));
    dome.position.y = 0.45;
    const under = new THREE.Mesh(new THREE.TorusGeometry(1.7, 0.18, 12, 48), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 0.4, 2.6), toneMapped: false }));
    under.rotation.x = Math.PI / 2; under.position.y = -0.5;
    g.add(disc, dome, under);
    const lights = [];
    for (let k = 0; k < 12; k++) {
      const l = new THREE.Mesh(this.sphereGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 2, 0.4), toneMapped: false }));
      const a = k / 12 * Math.PI * 2; l.scale.setScalar(0.16); l.position.set(Math.cos(a) * 3.05, 0, Math.sin(a) * 3.05); g.add(l); lights.push(l);
    }
    g.scale.setScalar(1.6); g.position.copy(this.spawnPoint(200, 230, 35, 15)); this.scene.add(g);
    const station = this.spawnPoint(45, 65, 28, 14);
    const hp = Math.round(10 * Math.max(0.6, this.D.speed));
    this.enemies.push({ type: 'ship', obj: g, r: 5.4, hp, maxHp: hp, station, lights, phase: this.rr(0, 6), shootT: this.rr(2, 3.5) / this.D.plasma, arrived: false });
  }

  firePlasma(from) {
    const m = new THREE.Mesh(this.sphereGeo, this.plasmaMat); m.scale.setScalar(0.45);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: 0x40ff70, blending: THREE.AdditiveBlending, depthWrite: false }));
    halo.scale.setScalar(5); m.add(halo);
    m.position.copy(from); this.scene.add(m);
    const target = new THREE.Vector3(this.rr(-1.5, 1.5), this.rr(-1, 1), 0);
    this.enemies.push({ type: 'plasma', obj: m, r: 1.3, hp: 1, maxHp: 1, vel: target.sub(from).normalize().multiplyScalar((32 + this.wave * 2) * this.D.plasma) });
  }

  startWave() {
    this.wave++;
    const n = this.wave, q = [], c = this.D.count;
    for (let i = 0; i < Math.round((5 + n * 2) * c); i++) q.push('rock');
    for (let i = 0; i < Math.round((n >= 2 ? (n - 1) * 2 : 0) * c); i++) q.push('alien');
    for (let i = 0; i < (n >= 3 ? Math.floor((n - 1) / 2) : 0); i++) q.push('ship');
    for (let i = q.length - 1; i > 0; i--) { const j = Math.floor(this.R() * (i + 1)); [q[i], q[j]] = [q[j], q[i]]; }
    this.queue = q;
    this.spawnEvery = Math.max(0.55, 2.0 - n * 0.15) * this.D.spawn;
    this.spawnT = 0.5;
    this.toast(`WAVE ${n}`, '#9ff7ff', 1400);
    sfx.chord(60 + n);
  }

  // ---------- frame ----------
  start() {
    this.resize();
    this.hudHull(); this.hudScore();
    this.toast('STAR GUNNER', '#9ff7ff', 1500);
    // engine drone
    const t = audio.currentTime;
    this.drone = [];
    const lp = audio.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 180;
    const g = audio.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.18, t + 2);
    lp.connect(g).connect(sfxBus);
    for (const f of [41, 41.6, 82.3]) { const o = audio.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.connect(lp); o.start(t); this.drone.push(o); }
    this.droneGain = g;
  }

  resize() {
    this.camera.aspect = this.vw() / innerHeight; this.camera.updateProjectionMatrix();
    this.composer.setSize(this.vw(), innerHeight);
    this.bloom.setSize(this.vw(), innerHeight);
    this.layoutCockpit();
  }

  aimInput(dt) {
    const b = this.body, L = b.handBody('L'), R = b.handBody('R');
    const both = L.ok && R.ok && b.present;
    const together = both && Math.hypot(L.x - R.x, L.y - R.y) < this.D.together;
    if (both) {
      const mx = (L.x + R.x) / 2, my = (L.y + R.y) / 2;
      // first seconds: wherever joined hands rest becomes "straight ahead"
      if (this.calib > 0 && together) { this.neutral.x += (mx - this.neutral.x) * Math.min(1, dt * 3); this.neutral.y += (my - this.neutral.y) * Math.min(1, dt * 3); }
      const ty = Math.max(-YAW_MAX, Math.min(YAW_MAX, (mx - this.neutral.x) * GAIN));
      const tp = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, (my - this.neutral.y) * GAIN));
      const k = Math.min(1, dt * 14);
      this.yaw += (ty - this.yaw) * k; this.pitch += (tp - this.pitch) * k;
    }
    this.firing = together && this.calib <= 0;
    this.apartFor = together ? 0 : this.apartFor + dt;
    this.calib -= dt;
  }

  aimDir() {
    const y = this.yaw * D2R, p = this.pitch * D2R;
    return new THREE.Vector3(Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p));
  }

  // nearest enemy along the aim ray, with a little angular forgiveness
  pick(dir) {
    let best = null, bestT = Infinity;
    for (const e of this.enemies) {
      if (e.dead) continue;
      const c = e.obj.position, t = c.dot(dir);
      if (t <= 0) continue;
      const miss = c.clone().sub(dir.clone().multiplyScalar(t)).length();
      if (miss < e.r + t * Math.tan(this.D.assist * D2R) && t < bestT) { best = e; bestT = t; }
    }
    return best ? { e: best, t: bestT } : null;
  }

  shoot(dir) {
    const mz = this.muzzles[this.barrel = 1 - this.barrel];
    const from = mz.obj.getWorldPosition(new THREE.Vector3());
    const hit = this.pick(dir);
    const to = hit ? hit.e.obj.position.clone() : dir.clone().multiplyScalar(400);
    const m = new THREE.Mesh(this.boltGeo, this.boltMat); m.scale.set(1, 1, 7);
    m.position.copy(from); m.lookAt(to); this.scene.add(m);
    const len = from.distanceTo(to);
    this.bolts.push({ m, from, to, len, d: 0, target: hit && hit.e });
    mz.heat = 1; this.shots++;
    sfx.laser(this.barrel ? 0.25 : -0.25);
  }

  damage(e, n, at) {
    if (e.dead) return;
    e.hp -= n; this.hitsLanded++; this.hitMark = 0.15;
    this.burst(at, 0x9ff7ff, 10, 10, 0.3, 2);
    if (e.hp > 0) { sfx.hit(); if (e.type === 'ship') e.flashT = 0.1; return; }
    e.dead = true; this.scene.remove(e.obj);
    const pts = { rock: 100, alien: 150, ship: 500, plasma: 25 }[e.type];
    this.score += pts * Math.max(1, this.wave); this.kills[e.type]++;
    this.hudScore();
    this.explode(e.obj.position.clone(), e.type === 'ship' ? 2.2 : e.type === 'rock' ? Math.min(2, e.size / 2.5) : e.type === 'plasma' ? 0.4 : 0.9, e.type === 'rock' ? 'rock' : e.type === 'plasma' ? 'plasma' : 'alien');
    if (e.type === 'rock' && e.size > 4) {
      for (let k = 0; k < 3; k++) {
        const v = e.vel.clone().add(new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-0.5, 0.5)).multiplyScalar(9));
        this.addRock(e.obj.position.clone().add(new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(e.size * 0.5)), e.size * 0.45, v);
      }
    }
  }

  hurt(n, e) {
    this.hull = Math.max(0, this.hull - Math.round(n * this.D.dmg)); this.damageFlash = 1; this.shake = Math.min(1.4, this.shake + 0.7);
    this.hudHull();
    sfx.boom(); sfx.alarm();
    if (e) { e.dead = true; this.scene.remove(e.obj); }
  }

  update(dt) {
    this.time += dt;
    const t = this.time;
    this.aimInput(dt);
    const dir = this.aimDir();

    // waves
    if (this.wave === 0 && this.calib <= 0) this.startWave();
    if (this.wave > 0) {
      this.spawnT -= dt;
      if (this.queue.length && this.spawnT <= 0) {
        const k = this.queue.pop();
        if (k === 'rock') this.addRock(this.spawnPoint(100, 130), this.rr(2.2, 6.5));
        else if (k === 'alien') this.addAlien(); else this.addShip();
        this.spawnT = this.spawnEvery * this.rr(0.6, 1.3);
      }
      if (!this.queue.length && !this.enemies.some(e => !e.dead && e.type !== 'plasma')) {
        this.waveGap -= dt;
        if (this.waveGap <= 0) {
          this.hull = Math.min(100, this.hull + this.D.regen); this.hudHull();
          this.waveGap = 3; this.startWave();
        } else if (this.waveGap > 2.9 && this.wave > 0 && !this.clearedShown) { this.clearedShown = true; this.toast(`WAVE ${this.wave} CLEARED  +${this.D.regen} HULL`, '#3ee08f', 1500); }
      } else this.clearedShown = false;
    }

    // weapon
    this.fireT -= dt;
    if (this.firing && this.fireT <= 0) { this.shoot(dir); this.fireT = FIRE_EVERY; }
    this.onTarget = !!this.pick(dir);
    this.turret.rotation.set(this.pitch * D2R, -this.yaw * D2R, 0, 'YXZ');
    for (const mz of this.muzzles) { mz.heat = Math.max(0, mz.heat - dt * 9); mz.flash.scale.setScalar(0.001 + mz.heat * 0.35); }

    // bolts
    for (const b of this.bolts) {
      b.d += BOLT_SPEED * dt;
      const f = Math.min(1, b.d / b.len);
      b.m.position.lerpVectors(b.from, b.to, f);
      if (f >= 1) {
        b.done = true; this.scene.remove(b.m);
        if (b.target && !b.target.dead) this.damage(b.target, 1, b.to);
      }
    }
    this.bolts = this.bolts.filter(b => !b.done);

    // enemies
    for (const e of this.enemies) {
      if (e.dead) continue;
      const o = e.obj;
      if (e.type === 'rock') {
        o.position.addScaledVector(e.vel, dt);
        o.rotation.x += e.spin.x * dt; o.rotation.y += e.spin.y * dt; o.rotation.z += e.spin.z * dt;
        if (o.position.z > -e.r - 2) { if (Math.abs(o.position.x) < 14 && Math.abs(o.position.y) < 10) this.hurt(Math.round(6 + e.size * 3), e); else { e.dead = true; this.scene.remove(o); } }
      } else if (e.type === 'alien') {
        const to = o.position.clone().negate(), d = to.length();
        to.normalize();
        const side = new THREE.Vector3(-to.z, 0, to.x).multiplyScalar(Math.sin(t * 2 + e.phase) * e.wob);
        const up = new THREE.Vector3(0, Math.cos(t * 1.7 + e.phase) * e.wob * 0.6, 0);
        o.position.addScaledVector(to, e.speed * dt).addScaledVector(side.add(up), dt);
        o.lookAt(0, 0, 0); o.children[0].rotation.z += dt * 2;
        if (d < 11) this.hurt(10, e);
      } else if (e.type === 'ship') {
        if (!e.arrived) {
          o.position.lerp(e.station, Math.min(1, dt * 0.7));
          if (o.position.distanceTo(e.station) < 3) e.arrived = true;
        } else {
          o.position.x = e.station.x + Math.sin(t * 0.6 + e.phase) * 14;
          o.position.y = e.station.y + Math.sin(t * 0.9 + e.phase) * 5;
          e.shootT -= dt;
          if (e.shootT <= 0) { this.firePlasma(o.position.clone()); e.shootT = (this.rr(2.2, 3.6) - Math.min(1, this.wave * 0.08)) / this.D.plasma; }
        }
        o.rotation.y += dt * 1.2; o.rotation.z = Math.sin(t * 0.6 + e.phase) * 0.25;
        e.lights.forEach((l, i) => l.material.color.setScalar(((Math.floor(t * 8) + i) % 4 === 0) ? 3 : 0.4));
        if (e.flashT > 0) { e.flashT -= dt; }
      } else if (e.type === 'plasma') {
        o.position.addScaledVector(e.vel, dt);
        o.scale.setScalar(0.45 + Math.sin(t * 30) * 0.06);
        if (o.position.length() < 2.5) this.hurt(12, e);
      }
    }
    this.enemies = this.enemies.filter(e => !e.dead);

    // particles / fx / debris
    for (let i = 0; i < this.pN; i++) {
      if (this.pLife[i] <= 0) continue;
      this.pLife[i] -= dt;
      const f = Math.max(0, this.pLife[i] / this.pMax[i]), drag = 1 - dt * 1.5;
      for (let a = 0; a < 3; a++) { this.pVel[i * 3 + a] *= drag; this.pPos[i * 3 + a] += this.pVel[i * 3 + a] * dt; this.pCol[i * 3 + a] = this.pBase[i * 3 + a] * f * f; }
    }
    this.particles.geometry.attributes.position.needsUpdate = true; this.particles.geometry.attributes.color.needsUpdate = true;
    for (const f of this.fx) {
      f.life -= dt; const k = 1 - f.life / f.max;
      f.obj.scale.setScalar(0.1 + f.grow * (f.kind === 'ring' ? k : Math.sqrt(k)));
      f.obj.material.opacity = Math.max(0, f.life / f.max);
      if (f.life <= 0) { this.scene.remove(f.obj); f.obj.material.dispose(); }
    }
    this.fx = this.fx.filter(f => f.life > 0);
    for (const d of this.debris) {
      d.life -= dt; d.m.position.addScaledVector(d.v, dt); d.m.rotation.x += d.s.x * dt; d.m.rotation.y += d.s.y * dt;
      if (d.life <= 0) this.scene.remove(d.m);
    }
    this.debris = this.debris.filter(d => d.life > 0);
    this.flash.intensity *= Math.exp(-dt * 8);

    // space flies past
    const sp = this.stars.geometry.attributes.position.array;
    for (let i = 2; i < sp.length; i += 3) { sp[i] += dt * 90; if (sp[i] > 20) sp[i] -= 720; }
    this.stars.geometry.attributes.position.needsUpdate = true;
    this.sky.material.uniforms.uTime.value = t;
    this.planet.rotation.y += dt * 0.01;
    this.dashLights.forEach((m, i) => { m.visible = Math.sin(t * (1.3 + i * 0.37) + i) > -0.3; });

    // camera shake
    this.shake = Math.max(0, this.shake - dt * 1.8);
    const s = this.shake * this.shake * 0.05;
    this.camera.rotation.set(rand(-s, s), rand(-s, s), rand(-s, s) * 0.5);
    this.damageFlash = Math.max(0, this.damageFlash - dt * 2.5);
    this.hitMark = Math.max(0, this.hitMark - dt);

    if (this.hull <= 0 && !this.endAt) { this.endAt = t + 1.5; this.explode(new THREE.Vector3(0, -2, -6), 1.5, 'alien'); }
    if (this.endAt && t > this.endAt) this.end();
  }

  render() {
    if (this.duel) {
      const r = this.app.renderer, x = this.vx(), w = this.vw();
      r.setViewport(x, 0, w, innerHeight); r.setScissor(x, 0, w, innerHeight); r.setScissorTest(true);
      this.composer.render();
      r.setScissorTest(false); r.setViewport(0, 0, innerWidth, innerHeight);
    } else this.composer.render();
    const g = this.app.octx;
    g.save();
    if (this.duel) { g.beginPath(); g.rect(this.vx(), 0, this.vw(), innerHeight); g.clip(); g.translate(this.vx(), 0); }
    this.drawHud();
    g.restore();
  }

  drawHud() {
    const g = this.app.octx, W = this.vw(), H = innerHeight;
    g.clearRect(0, 0, W, H);
    if (this.duel) this.drawDuelHud(g, W, H);
    // reticle where the aim ray meets the screen
    const p = this.aimDir().multiplyScalar(100).project(this.camera);
    const x = (p.x * 0.5 + 0.5) * W, y = (-p.y * 0.5 + 0.5) * H;
    const col = !this.firing ? 'rgba(200,210,230,.55)' : this.onTarget ? '#ff4d6d' : '#7ff6ff';
    g.save(); g.translate(x, y);
    g.strokeStyle = col; g.lineWidth = 3; g.shadowColor = col; g.shadowBlur = 14;
    g.beginPath(); g.arc(0, 0, 26, 0, Math.PI * 2); g.stroke();
    g.rotate(this.time * (this.firing ? 3 : 0.6));
    for (let k = 0; k < 4; k++) { g.rotate(Math.PI / 2); g.beginPath(); g.moveTo(34, 0); g.lineTo(48, 0); g.stroke(); }
    g.restore();
    g.fillStyle = col; g.beginPath(); g.arc(x, y, 3.5, 0, Math.PI * 2); g.fill();
    if (this.hitMark > 0) {
      g.strokeStyle = `rgba(255,255,255,${this.hitMark / 0.15})`; g.lineWidth = 3;
      for (const [a, b] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) { g.beginPath(); g.moveTo(x + a * 10, y + b * 10); g.lineTo(x + a * 18, y + b * 18); g.stroke(); }
    }
    // ship health bars
    for (const e of this.enemies) if (e.type === 'ship') {
      const q = e.obj.position.clone().add(new THREE.Vector3(0, 7, 0)).project(this.camera);
      if (q.z > 1) continue;
      const sx = (q.x * 0.5 + 0.5) * W, sy = (-q.y * 0.5 + 0.5) * H;
      g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(sx - 40, sy, 80, 8);
      g.fillStyle = '#ff4dd2'; g.fillRect(sx - 40, sy, 80 * e.hp / e.maxHp, 8);
    }
    // wave + prompts
    g.font = '800 20px system-ui'; g.textAlign = 'left'; g.fillStyle = '#9ff7ff'; g.shadowColor = '#000'; g.shadowBlur = 6;
    if (!this.duel) g.fillText(`WAVE ${Math.max(1, this.wave)}`, 24, 110);
    g.textAlign = 'center';
    if (this.calib > 0) {
      g.font = '800 28px system-ui'; g.fillStyle = '#fff';
      g.fillText('Put your hands together and point at the screen', W / 2, H * 0.72);
      g.font = '600 20px system-ui'; g.fillStyle = '#9ff7ff';
      g.fillText(`calibrating aim… ${Math.ceil(this.calib)}`, W / 2, H * 0.72 + 34);
    } else if (this.apartFor > 0.6) {
      g.font = '800 24px system-ui'; g.fillStyle = '#ffd166';
      g.fillText('HANDS TOGETHER TO FIRE', W / 2, H * 0.72);
    }
    g.shadowBlur = 0;
    if (this.damageFlash > 0) {
      const gr = g.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.85);
      gr.addColorStop(0, 'rgba(255,0,40,0)'); gr.addColorStop(1, `rgba(255,0,40,${0.55 * this.damageFlash})`);
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
    }
  }

  // Split screen: each half carries its own score, hull bar and wave toasts.
  drawDuelHud(g, W, H) {
    const hs = this.hudState;
    g.save();
    g.shadowColor = '#000'; g.shadowBlur = 8; g.textBaseline = 'alphabetic';
    g.font = '900 34px system-ui'; g.fillStyle = this.color; g.textAlign = 'left';
    g.fillText(this.label, 24, H - 60);
    g.font = '900 44px system-ui'; g.fillStyle = '#fff'; g.textAlign = 'right';
    g.fillText(Math.round(hs.score).toLocaleString(), W - 24, 110);
    g.font = '800 20px system-ui'; g.fillStyle = '#9ff7ff'; g.fillText(`WAVE ${Math.max(1, this.wave)}`, W - 24, 138);
    g.shadowBlur = 0;
    const bw = Math.min(360, W * 0.6), bx = (W - bw) / 2, by = 96;
    g.fillStyle = 'rgba(255,255,255,.15)'; g.fillRect(bx, by, bw, 14);
    const gr = g.createLinearGradient(bx, 0, bx + bw, 0);
    gr.addColorStop(0, '#ff3b5c'); gr.addColorStop(0.5, '#ffd166'); gr.addColorStop(1, '#3ee08f');
    g.fillStyle = gr; g.fillRect(bx, by, bw * hs.hull, 14);
    g.strokeStyle = 'rgba(255,255,255,.4)'; g.lineWidth = 1; g.strokeRect(bx, by, bw, 14);
    if (hs.toast && this.time < hs.toast.until) {
      g.font = '900 48px system-ui'; g.textAlign = 'center'; g.fillStyle = hs.toast.color; g.shadowColor = '#000'; g.shadowBlur = 20;
      g.fillText(hs.toast.text, W / 2, H * 0.38);
    }
    if (this.ended) {
      g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, 0, W, H);
      g.font = '900 56px system-ui'; g.textAlign = 'center'; g.fillStyle = '#ff6b8b'; g.shadowBlur = 20;
      g.fillText('SHIP DESTROYED', W / 2, H / 2);
    }
    g.restore();
  }

  end() {
    if (this.ended) return; this.ended = true;
    if (this.duel) return; // the duel decides the winner
    const acc = this.shots ? this.hitsLanded / this.shots : 0;
    const rank = this.wave >= 8 ? 'S' : this.wave >= 6 ? 'A' : this.wave >= 4 ? 'B' : this.wave >= 2 ? 'C' : 'D';
    this.app.finish({
      rank, failed: true, title: 'Ship destroyed!',
      stats: {
        Score: this.score.toLocaleString(), 'Wave reached': this.wave, Accuracy: `${(acc * 100).toFixed(0)}%`,
        Asteroids: this.kills.rock, Aliens: this.kills.alien, 'Alien ships': this.kills.ship, 'Plasma shot down': this.kills.plasma,
      },
    });
  }

  dispose() {
    this.composer.renderTarget1?.dispose(); this.composer.renderTarget2?.dispose();
    const t = audio.currentTime;
    if (this.droneGain) { this.droneGain.gain.cancelScheduledValues(t); this.droneGain.gain.setValueAtTime(this.droneGain.gain.value, t); this.droneGain.gain.linearRampToValueAtTime(0, t + 0.3); }
    for (const o of this.drone || []) o.stop(t + 0.35);
    this.composer.dispose();
    this.scene.traverse(o => { o.geometry?.dispose?.(); });
    this.glow.dispose();
    const r = this.app.renderer;
    r.toneMapping = this.prevTone; r.toneMappingExposure = this.prevExposure;
    r.setClearColor(0x000000, 0); r.clear();
    this.app.octx.clearRect(0, 0, innerWidth, innerHeight);
  }
}

// 1v1 split screen: two gunners, one per half, fed by the two players in view
// (player 1 on the left of the mirror). Same seed, so both face the same waves.
// Last ship flying wins; if both survive TIME_LIMIT, the higher score wins.
const TIME_LIMIT = 180;
export class ShooterDuel {
  constructor(app, opts = {}) {
    this.app = app;
    const seed = Math.floor(Math.random() * 1e9);
    this.bodies = [new Body(app.pose, Body.side('left')), new Body(app.pose, Body.side('right'))];
    this.bodies.forEach(b => { b.frameLocked = true; });
    this.games = [
      new ShooterGame(app, { ...opts, duel: true, body: this.bodies[0], view: [0, 0.5], seed, label: 'P1', color: '#ff6b8b' }),
      new ShooterGame(app, { ...opts, duel: true, body: this.bodies[1], view: [0.5, 1], seed, label: 'P2', color: '#6bc4ff' }),
    ];
    this.time = 0;
  }
  start() {
    this.app.hud.el.classList.remove('on');
    this.games.forEach(g => g.start());
  }
  resize() { this.games.forEach(g => g.resize()); }
  update(dt, now) {
    this.time += dt;
    for (const g of this.games) if (!g.ended) g.update(dt, now);
    if (this.over) { this.overT -= dt; if (this.overT <= 0) this.finish(); return; }
    const [a, b] = this.games;
    if (a.ended || b.ended || this.time >= TIME_LIMIT) {
      this.over = true; this.overT = a.ended && b.ended ? 0.5 : 2.5;
      this.winner = a.ended && !b.ended ? 1 : b.ended && !a.ended ? 0 : a.score === b.score ? -1 : a.score > b.score ? 0 : 1;
      this.why = a.ended || b.ended ? 'last ship flying' : 'higher score';
    }
  }
  render() {
    const g = this.app.octx;
    g.clearRect(0, 0, innerWidth, innerHeight);
    this.games.forEach(x => x.render());
    g.save();
    g.fillStyle = 'rgba(255,255,255,.85)'; g.fillRect(innerWidth / 2 - 2, 0, 4, innerHeight);
    const left = Math.max(0, TIME_LIMIT - this.time), m = Math.floor(left / 60), s = Math.floor(left % 60);
    g.font = '900 30px system-ui'; g.textAlign = 'center'; g.fillStyle = '#fff'; g.shadowColor = '#000'; g.shadowBlur = 10;
    g.fillText(`${m}:${String(s).padStart(2, '0')}`, innerWidth / 2, 84);
    this.bodies.forEach((b, i) => {
      if (b.present) return;
      g.font = '800 28px system-ui'; g.fillStyle = '#ffd166';
      g.fillText(`P${i + 1}: step into view on the ${i ? 'right' : 'left'}`, innerWidth * (i ? 0.75 : 0.25), innerHeight * 0.6);
    });
    if (this.over && this.winner != null) {
      g.font = '900 64px system-ui'; g.fillStyle = this.winner < 0 ? '#fff' : this.games[this.winner].color; g.shadowBlur = 24;
      g.fillText(this.winner < 0 ? 'DRAW!' : `P${this.winner + 1} WINS!`, innerWidth / 2, innerHeight * 0.3);
    }
    g.restore();
  }
  finish() {
    if (this.done) return; this.done = true;
    const [a, b] = this.games;
    const acc = (x) => `${(x.shots ? x.hitsLanded / x.shots * 100 : 0).toFixed(0)}%`;
    this.app.finish({
      rank: this.winner < 0 ? '=' : `P${this.winner + 1}`, failed: false,
      title: this.winner < 0 ? 'Draw!' : `Player ${this.winner + 1} wins — ${this.why}!`,
      stats: {
        'P1 score': a.score.toLocaleString(), 'P2 score': b.score.toLocaleString(),
        'P1 wave': a.wave, 'P2 wave': b.wave, 'P1 accuracy': acc(a), 'P2 accuracy': acc(b),
      },
    });
  }
  dispose() {
    this.games[1].dispose(); this.games[0].dispose(); // restore renderer settings in reverse order
    this.bodies.forEach(b => b.dispose());
  }
}
