import * as THREE from 'three';
import { PoseClient, Body, KP, BONES } from './pose.js';
import { ctx as audio, sfx } from './audio.js';
import { SaberGame, SABER_DIFFS } from './games/saber.js';
import { ViewerGame } from './games/viewer.js';
import { WallGame } from './games/wall.js';
import { MoleGame } from './games/mole.js';
import { SONGS } from './songs.js';

const $ = (s) => document.querySelector(s);
const pose = new PoseClient();
const body = new Body(pose);
window.pa = { pose, body }; // debugging (games hooked in below)

// ---------- rendering surfaces ----------
const glCanvas = $('#gl'), overlay = $('#overlay'), octx = overlay.getContext('2d');
const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
const bgvideo = $('#bgvideo');
function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  overlay.width = innerWidth * devicePixelRatio; overlay.height = innerHeight * devicePixelRatio;
  octx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  game?.resize?.();
}
addEventListener('resize', resize);

// Mirrored camera image (object-fit: cover) -> window pixels.
function videoToWindow(x, y) {
  const va = pose.aspect, wa = innerWidth / innerHeight;
  let w, h;
  if (va > wa) { h = innerHeight; w = h * va; } else { w = innerWidth; h = w / va; }
  return { x: (innerWidth - w) / 2 + x * w, y: (innerHeight - h) / 2 + y * h, s: h };
}

// ---------- screens ----------
let screen = 'scrStart';
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('on', s.id === id));
  screen = id;
  dwell.clear();
}
function msg(text, ms = 0) {
  const el = $('#msg'); el.textContent = text; el.style.display = text ? 'block' : 'none';
  clearTimeout(msg._t); if (ms) msg._t = setTimeout(() => el.style.display = 'none', ms);
}

// ---------- hand cursors + dwell selection ----------
const cursors = { L: $('#curL'), R: $('#curR') };
const dwell = new Map(); // element -> ms hovered
const DWELL_MS = 1100;
// Cursor follows the hand tracker's palm position (falls back to the wrist
// estimate), so it works even when the forearm is hidden behind the hand.
function handCursor(side) {
  const h = body.handBody(side);
  if (!h.ok) return null;
  return { x: innerWidth / 2 + h.x * innerWidth / 5.2, y: innerHeight / 2 - (h.y - 0.15) * innerHeight / 3.6 };
}
function updateMenuHands(dt) {
  const menuOn = !game || paused || screen === 'scrResult';
  const targets = menuOn ? [...document.querySelectorAll('.screen.on .card, .screen.on .btn')] : [];
  const hovered = new Set();
  for (const k of ['L', 'R']) {
    const c = menuOn && body.present && screen !== 'scrStart' ? handCursor(k) : null;
    const cur = cursors[k];
    if (!c) { cur.style.display = 'none'; continue; }
    cur.style.display = 'block'; cur.style.left = c.x + 'px'; cur.style.top = c.y + 'px';
    for (const t of targets) {
      const r = t.getBoundingClientRect();
      if (c.x >= r.left && c.x <= r.right && c.y >= r.top && c.y <= r.bottom) hovered.add(t);
    }
  }
  for (const t of targets) {
    const fill = t.querySelector('.fill');
    if (hovered.has(t)) {
      const v = (dwell.get(t) || 0) + dt * 1000;
      dwell.set(t, v); t.classList.add('hot');
      if (fill) fill.style.width = Math.min(100, v / DWELL_MS * 100) + '%';
      if (v >= DWELL_MS) { dwell.clear(); clearFills(); activate(t); return; }
    } else if (dwell.has(t)) { dwell.delete(t); t.classList.remove('hot'); if (fill) fill.style.width = '0'; }
  }
}
function clearFills() { document.querySelectorAll('.fill').forEach(f => f.style.width = '0'); document.querySelectorAll('.hot').forEach(h => h.classList.remove('hot')); }

// ---------- menus ----------
let chosenSong = SONGS[0], chosenDiff = 'Easy', lastGame = null;
const songRow = $('#songRow'), diffRow = $('#diffRow');
for (const s of [...SONGS].sort((a, b) => a.level - b.level)) {
  const b = document.createElement('div'); b.className = 'btn song'; b.dataset.song = s.id;
  b.innerHTML = `${s.name}<div class="kbd">${'★'.repeat(s.level)}${'☆'.repeat(3 - s.level)}</div><div class="fill"></div>`;
  songRow.appendChild(b);
}
for (const d of Object.keys(SABER_DIFFS)) {
  const b = document.createElement('div'); b.className = 'btn'; b.dataset.diff = d;
  b.innerHTML = `${d}<div class="fill"></div>`; diffRow.appendChild(b);
}
function refreshSel() {
  songRow.querySelectorAll('.btn').forEach(b => b.classList.toggle('sel', b.dataset.song === chosenSong.id));
  diffRow.querySelectorAll('.btn').forEach(b => b.classList.toggle('sel', b.dataset.diff === chosenDiff));
}
refreshSel();
function activate(el) {
  sfx.ding(el.dataset.game ? 79 : 84);
  if (el.dataset.game === 'saber') { show('scrSongs'); return; }
  if (el.dataset.game === 'viewer') { lastGame = { kind: 'viewer' }; endGame(); launch(); return; }
  if (el.dataset.game) { lastGame = { kind: el.dataset.game }; startCalib(); return; }
  if (el.dataset.song) { chosenSong = SONGS.find(s => s.id === el.dataset.song); refreshSel(); return; }
  if (el.dataset.diff) { chosenDiff = el.dataset.diff; refreshSel(); return; }
  switch (el.dataset.act) {
    case 'menu': endGame(); show('scrMenu'); break;
    case 'play': lastGame = { kind: 'saber', song: chosenSong, diff: chosenDiff }; startCalib(); break;
    case 'retry': startCalib(); break;
    case 'resume': resume(); break;
    case 'quit': endGame(); show('scrMenu'); break;
  }
}
document.addEventListener('click', (e) => {
  const t = e.target.closest('.card, .btn');
  if (t && t.id !== 'btnStart') activate(t);
});

// ---------- start ----------
PoseClient.listCameras().then(cams => {
  for (const c of cams) if (c.deviceId) {
    const o = document.createElement('option'); o.value = c.deviceId; o.textContent = c.label || 'Camera'; $('#camSel').appendChild(o);
  }
}).catch(() => { });
$('#btnStart').addEventListener('click', async () => {
  try {
    if (!window.isSecureContext) throw new Error('Camera needs HTTPS — open this page via https://');
    await audio.resume();
    await pose.startCamera($('#camSel').value || undefined);
    bgvideo.srcObject = pose.stream; bgvideo.play();
    pose.connect();
    resize();
    show('scrMenu');
  } catch (err) { $('#startErr').textContent = '⚠ ' + err.message; }
});

// ---------- game lifecycle ----------
let game = null, paused = false, calib = null, absentFor = 0;
const hud = {
  el: $('#hud'),
  score(s, combo, mult) {
    $('#score .s').textContent = Math.round(s).toLocaleString();
    $('#score .c').textContent = combo > 1 ? `${combo} combo` : '';
    $('#score .m').textContent = mult > 1 ? `×${mult}` : '';
  },
  energy(v) { $('#energy').style.display = v == null ? 'none' : ''; if (v != null) $('#energy div').style.width = (v * 100) + '%'; },
  progress(f) { $('#progress').style.width = (f * 100) + '%'; },
  toast(text, color = '#fff', ms = 700) {
    const t = $('#toast'); t.textContent = text; t.style.color = color; t.style.opacity = 1;
    clearTimeout(hud._t); hud._t = setTimeout(() => t.style.opacity = 0, ms);
  },
};
const app = { THREE, renderer, octx, body, pose, hud, videoToWindow, msg, bgvideo,
  finish: (res) => finishGame(res) };

function startCalib() {
  endGame();
  body.frameLocked = false;
  show('scrCalib');
  calib = { held: 0, count: -1 };
  $('#calibCount').textContent = '';
  $('#calibText').textContent = {
    saber: 'Stand so your head, shoulders, and both arms are visible. Raise both hands above your shoulders to start.',
    wall: 'Stand in the middle of the frame with room to step left and right. Raise both hands above your shoulders to start.',
    mole: 'Stand back so you can reach out to the sides and overhead. Raise both hands above your shoulders to start.',
  }[lastGame.kind] || 'Raise both hands above your shoulders to start.';
}
function updateCalib(dt) {
  const lw = body.body(KP.leftWrist), rw = body.body(KP.rightWrist);
  const up = body.present && lw.ok && rw.ok && lw.y > 0.35 && rw.y > 0.35;
  if (calib.count < 0) {
    calib.held = up ? calib.held + dt : 0;
    $('#calibCount').textContent = up ? '✋✋' : '';
    if (calib.held > 0.6) { calib.count = 3; calib.next = 0; }
  } else {
    calib.next -= dt;
    if (calib.next <= 0) {
      if (calib.count === 0) { calib = null; launch(); return; }
      $('#calibCount').textContent = calib.count; sfx.tick(); calib.count--; calib.next = 0.8;
    }
  }
}
function launch() {
  show('none');
  body.frameLocked = true;
  const opts = { ...lastGame };
  const Game = { saber: SaberGame, wall: WallGame, mole: MoleGame, viewer: ViewerGame }[lastGame.kind];
  game = new Game(app, opts);
  hud.el.classList.toggle('on', lastGame.kind !== 'viewer');
  const is3d = lastGame.kind === 'saber' || lastGame.kind === 'wall';
  glCanvas.style.display = is3d ? '' : 'none';
  overlay.style.display = is3d ? 'none' : '';
  pose.setHands(lastGame.kind !== 'saber'); hud.score(0, 0, 1); hud.progress(0);
  paused = false; absentFor = 0;
  game.start();
}
function endGame() {
  if (game) { game.dispose(); game = null; }
  if (audio.state === 'suspended') audio.resume();
  hud.el.classList.remove('on'); paused = false;
  renderer.clear(); octx.clearRect(0, 0, innerWidth, innerHeight);
  bgvideo.style.opacity = 0; glCanvas.style.display = 'none';
  pose.setHands(true); // menus use the hand cursors
}
function finishGame(res) {
  const g = game; game = null; g?.dispose();
  pose.setHands(true);
  hud.el.classList.remove('on');
  octx.clearRect(0, 0, innerWidth, innerHeight); renderer.clear();
  bgvideo.style.opacity = 0;
  $('#resRank').textContent = res.rank; $('#resTitle').textContent = res.title;
  $('#resStats').innerHTML = Object.entries(res.stats).map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('');
  show('scrResult');
  sfx.chord(res.failed ? 60 : 72);
}
function pause(why) {
  if (!game || paused) return;
  paused = true; audio.suspend(); $('#pauseWhy').textContent = why; show('scrPause');
}
function resume() {
  if (!game) return;
  show('none'); paused = false; absentFor = 0; audio.resume();
}
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (paused) resume(); else pause('Paused. Hover Resume or press Esc.'); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) pause('Paused (tab hidden).'); });

// ---------- status + PiP ----------
const pip = $('#pip'), pctx = pip.getContext('2d');
function drawPip() {
  const v = pose.video; if (!v.videoWidth) return;
  const w = pip.width, h = Math.round(w / pose.aspect);
  if (pip.height !== h) pip.height = h;
  pctx.save(); pctx.scale(-1, 1); pctx.drawImage(v, -w, 0, w, h); pctx.restore();
  pctx.fillStyle = 'rgba(0,0,0,.35)'; pctx.fillRect(0, 0, w, h);
  if (!body.present) return;
  pctx.lineWidth = 3; pctx.lineCap = 'round';
  for (const [a, b] of BONES) {
    const p = body.screen(a), q = body.screen(b); if (!p.ok || !q.ok) continue;
    pctx.strokeStyle = (a % 2 === 1 && b % 2 === 1) ? '#ff3b5c' : (a % 2 === 0 && b % 2 === 0 && a > 0) ? '#2fa8ff' : '#fff';
    pctx.beginPath(); pctx.moveTo(p.x * w, p.y * h); pctx.lineTo(q.x * w, q.y * h); pctx.stroke();
  }
}
// COCO "left_*" is the player's own left, which shows up on the left in a mirror.
let stT = 0;
function updateStatus(now) {
  if (now - stT < 250) return; stT = now;
  const s = pose.stats;
  const set = (id, val, cls) => { const el = $(id); el.querySelector('b').textContent = val; el.className = 'pill ' + (cls || ''); };
  set('#stCam', s.camera ? `${pose.video.videoWidth}×${pose.video.videoHeight}` : 'off', s.camera ? 'good' : 'bad');
  set('#stNet', s.connected ? 'connected' : 'offline', s.connected ? 'good' : 'bad');
  set('#stLat', s.connected ? `${s.latency.toFixed(0)} ms (gpu ${s.infer.toFixed(1)})` : '–', s.latency > 120 ? 'bad' : 'good');
  set('#stFps', s.connected ? `${s.fps.toFixed(0)} fps` : '–', s.fps < 15 ? 'bad' : 'good');
  set('#stBody', body.present ? 'tracked' : 'not seen', body.present ? 'good' : 'bad');
}

// ---------- main loop ----------
let lastT = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
  updateStatus(now);
  if (pose.stats.camera) drawPip();
  if (screen === 'scrCalib' && calib) updateCalib(dt);
  if (game && !paused) {
    absentFor = body.present || game.noAutoPause ? 0 : absentFor + dt;
    if (absentFor > 1.5) pause('Lost you! Step back into view, then hover Resume.');
    else game.update(dt, now);
  }
  if (game) game.render();
  updateMenuHands(dt);
}
resize();
requestAnimationFrame(frame);
// Test hook: start a game without the hands-up calibration.
window.pa.launch = (kind, diff = 'Normal', song = 'twinkle') => { lastGame = kind === 'saber' ? { kind, song: SONGS.find(s => s.id === song), diff } : { kind }; endGame(); launch(); };
Object.defineProperty(window.pa, 'game', { get: () => game });
