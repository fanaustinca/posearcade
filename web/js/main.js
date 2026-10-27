import * as THREE from 'three';
import { PoseClient, Body, KP, BONES } from './pose.js';
import { ctx as audio, sfx } from './audio.js';
import { SaberGame, SABER_DIFFS } from './games/saber.js';
import { ViewerGame } from './games/viewer.js';
import { WallGame } from './games/wall.js';
import { MoleGame } from './games/mole.js';
import { ShooterGame, ShooterDuel, SG_DIFFS } from './games/shooter.js';
import { TennisGame, TENNIS_DIFFS } from './games/tennis.js';
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
// Over the camera image it sits exactly on your hand; on the plain menus it
// is scaled around your body so every button is in easy reach.
function handCursor(side) {
  if (game && bgvideo.style.opacity === '1') {
    const s = body.handScreen(side);
    return s.ok ? videoToWindow(s.x, s.y) : null;
  }
  const h = body.handBody(side);
  if (!h.ok) return null;
  return { x: innerWidth / 2 + h.x * innerWidth / 5.2, y: innerHeight / 2 - (h.y - 0.15) * innerHeight / 3.6 };
}
function updateMenuHands(dt) {
  const inGame = game && !paused; // only the Exit / Pause button, and only shown near it
  const menuOn = !game || paused || screen === 'scrResult';
  const exitBtn = $('#btnExit');
  const targets = inGame ? [exitBtn] : menuOn ? [...document.querySelectorAll('.screen.on .card, .screen.on .btn')] : [];
  const need = inGame && !game.noAutoPause ? DWELL_MS * 1.4 : DWELL_MS;
  const hovered = new Set();
  for (const k of ['L', 'R']) {
    let c = (menuOn || inGame) && body.present && screen !== 'scrStart' ? handCursor(k) : null;
    if (c && inGame && !game.noAutoPause) { // in a game: cursor only appears near the Pause button
      const r = exitBtn.getBoundingClientRect(), m = 120;
      if (c.x < r.left - m || c.x > r.right + m || c.y < r.top - m || c.y > r.bottom + m) c = null;
    }
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
      if (fill) fill.style.width = Math.min(100, v / need * 100) + '%';
      if (v >= need) { dwell.clear(); clearFills(); activate(t); return; }
    } else if (dwell.has(t)) { dwell.delete(t); t.classList.remove('hot'); if (fill) fill.style.width = '0'; }
  }
}
function clearFills() { document.querySelectorAll('.fill').forEach(f => f.style.width = '0'); document.querySelectorAll('.hot').forEach(h => h.classList.remove('hot')); }

// ---------- menus ----------
let chosenSong = SONGS[0], chosenDiff = 'Easy', chosenTennis = 'Novice', lastGame = null;
const chosenSg = { players: 1, diff: 'Easy' };
const songRow = $('#songRow'), diffRow = $('#diffRow');
for (const s of [...SONGS].sort((a, b) => a.level - b.level)) {
  const b = document.createElement('div'); b.className = 'btn song'; b.dataset.song = s.id;
  b.innerHTML = `${s.name}<div class="kbd">${'★'.repeat(s.level)}${'☆'.repeat(3 - s.level)}</div><div class="fill"></div>`;
  songRow.appendChild(b);
}
for (const d of Object.keys(SABER_DIFFS)) {
  const b = document.createElement('div'); b.className = 'btn opt'; b.dataset.diff = d;
  b.innerHTML = `${d}<div class="fill"></div>`; diffRow.appendChild(b);
}
const tennisRow = $('#tennisRow');
for (const d of Object.keys(TENNIS_DIFFS)) {
  const b = document.createElement('div'); b.className = 'btn opt'; b.dataset.tdiff = d;
  b.innerHTML = `${d}<div class="fill"></div>`; tennisRow.appendChild(b);
}
for (const [n, label] of [[1, '👤 1 Player'], [2, '👥 2 Players · 1v1']]) {
  const b = document.createElement('div'); b.className = 'btn'; b.dataset.sgplayers = n;
  b.innerHTML = `${label}<div class="fill"></div>`; $('#sgModeRow').appendChild(b);
}
for (const d of Object.keys(SG_DIFFS)) {
  const b = document.createElement('div'); b.className = 'btn opt'; b.dataset.sgdiff = d;
  b.innerHTML = `${d}<div class="fill"></div>`; $('#sgDiffRow').appendChild(b);
}
function refreshSel() {
  document.querySelectorAll('[data-sgplayers]').forEach(b => b.classList.toggle('sel', +b.dataset.sgplayers === chosenSg.players));
  document.querySelectorAll('[data-sgdiff]').forEach(b => b.classList.toggle('sel', b.dataset.sgdiff === chosenSg.diff));
  $('#sgHelp').innerHTML = chosenSg.players === 2
    ? 'Split screen: player 1 stands on the <b style="color:var(--red)">left</b>, player 2 on the <b style="color:var(--blue)">right</b>, both facing the camera.<br>Same waves for both — last ship flying (or the higher score after 3 minutes) wins.'
    : 'Hold your hands together to fire, move them to aim. Survive as many waves as you can.';
  tennisRow.querySelectorAll('.btn').forEach(b => b.classList.toggle('sel', b.dataset.tdiff === chosenTennis));
  songRow.querySelectorAll('.btn').forEach(b => b.classList.toggle('sel', b.dataset.song === chosenSong.id));
  diffRow.querySelectorAll('.btn').forEach(b => b.classList.toggle('sel', b.dataset.diff === chosenDiff));
}
refreshSel();
function activate(el) {
  sfx.ding(el.dataset.game ? 79 : 84);
  if (el.dataset.game === 'saber') { show('scrSongs'); return; }
  if (el.dataset.game === 'tennis') { show('scrTennis'); return; }
  if (el.dataset.tdiff) { chosenTennis = el.dataset.tdiff; refreshSel(); return; }
  if (el.dataset.game === 'shooter') { show('scrShooter'); return; }
  if (el.dataset.sgplayers) { chosenSg.players = +el.dataset.sgplayers; refreshSel(); return; }
  if (el.dataset.sgdiff) { chosenSg.diff = el.dataset.sgdiff; refreshSel(); return; }
  if (el.dataset.game === 'viewer') { lastGame = { kind: 'viewer' }; endGame(); launch(); return; }
  if (el.dataset.game) { lastGame = { kind: el.dataset.game }; startCalib(); return; }
  if (el.dataset.song) { chosenSong = SONGS.find(s => s.id === el.dataset.song); refreshSel(); return; }
  if (el.dataset.diff) { chosenDiff = el.dataset.diff; refreshSel(); return; }
  switch (el.dataset.act) {
    case 'menu': endGame(); show('scrMenu'); break;
    case 'play': lastGame = { kind: 'saber', song: chosenSong, diff: chosenDiff }; startCalib(); break;
    case 'playTennis': lastGame = { kind: 'tennis', diff: chosenTennis }; startCalib(); break;
    case 'playShooter': lastGame = { kind: 'shooter', diff: chosenSg.diff, players: chosenSg.players }; startCalib(); break;
    case 'pause': pause('Paused. Hover Resume to keep playing, or press Esc.'); break;
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
    mole: 'Moles pop up all over the camera view: move around to reach them. Raise both hands above your shoulders to start.',
    shooter: lastGame.players === 2
      ? 'Player 1 on the left, player 2 on the right, both fully in view. Hands together = fire; move them to aim. One of you: raise both hands to start.'
      : 'Sit or stand facing the camera. Hands together = fire; move them to aim. Raise both hands above your shoulders to start.',
    tennis: 'Stand in the middle with room to step left and right and swing. Step sideways to get to the ball, then swing! Raise both hands above your shoulders to start.',
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
  const Game = lastGame.kind === 'shooter' && lastGame.players === 2 ? ShooterDuel
    : { saber: SaberGame, wall: WallGame, mole: MoleGame, shooter: ShooterGame, tennis: TennisGame, viewer: ViewerGame }[lastGame.kind];
  game = new Game(app, opts);
  hud.el.classList.toggle('on', lastGame.kind !== 'viewer');
  const k = lastGame.kind;
  glCanvas.style.display = k === 'saber' || k === 'wall' || k === 'shooter' || k === 'tennis' ? '' : 'none';
  overlay.style.display = k === 'saber' || k === 'wall' ? 'none' : '';
  const ex = $('#btnExit'), isViewer = k === 'viewer';
  ex.classList.add('on'); ex.classList.toggle('ingame', !isViewer);
  ex.dataset.act = isViewer ? 'quit' : 'pause';
  ex.firstChild.nodeValue = isViewer ? '✕ Exit' : '⏸ Pause';
  pose.setHands(k !== 'saber' && k !== 'tennis'); // these read the pose wrists only
  hud.score(0, 0, 1); hud.progress(0);
  paused = false; absentFor = 0;
  game.start();
}
function endGame() {
  $('#btnExit').classList.remove('on');
  if (game) { game.dispose(); game = null; }
  if (audio.state === 'suspended') audio.resume();
  hud.el.classList.remove('on'); paused = false;
  renderer.clear(); octx.clearRect(0, 0, innerWidth, innerHeight);
  bgvideo.style.opacity = 0; glCanvas.style.display = 'none';
  $('#btnExit').classList.remove('on');
  pose.setHands(true); // menus use the hand cursors
}
function finishGame(res) {
  const g = game; game = null; g?.dispose();
  $('#btnExit').classList.remove('on');
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
  $('#btnExit').classList.remove('on');
}
function resume() {
  if (!game) return;
  show('none'); paused = false; absentFor = 0; audio.resume();
  $('#btnExit').classList.add('on');
}
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (game && game.noAutoPause) { endGame(); show('scrMenu'); }              // Joint Viewer: Esc leaves
  else if (game) { if (paused) resume(); else pause('Paused. Hover Resume or press Esc.'); }
  else if (['scrSongs', 'scrTennis', 'scrShooter', 'scrCalib', 'scrResult'].includes(screen)) { calib = null; show('scrMenu'); }
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
// pa.launch('saber', 'Easy', 'twinkle') · pa.launch('shooter', 'Easy', { players: 2 })
window.pa.launch = (kind, diff = 'Normal', song = 'twinkle') => { lastGame = kind === 'saber' ? { kind, song: SONGS.find(s => s.id === song), diff } : { kind, diff, ...(typeof song === 'object' ? song : {}) }; endGame(); launch(); };
Object.defineProperty(window.pa, 'game', { get: () => game });
