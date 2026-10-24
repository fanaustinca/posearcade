import { ctx as audio, sfx } from '../audio.js';

// Holes in body space (shoulder-width units around the player); nothing
// in front of the body and nothing low.
const COLS = [-2.3, -1.35, 1.35, 2.3], ROWS = [-0.1, 0.9, 1.9];
const HOLES = ROWS.flatMap(y => COLS.map(x => ({ x, y })));
const DURATION = 60, HIT_R = 0.5, MOLE_R = 0.36;
const TYPES = {
  mole: { pts: 10, color: '#8b5a3c' },
  gold: { pts: 30, color: '#f5c542' },
  bomb: { pts: -20, color: '#222' },
};

export class MoleGame {
  constructor(app) {
    this.app = app;
    this.moles = []; this.fx = [];
    this.score = 0; this.combo = 0; this.bestCombo = 0;
    this.hits = 0; this.spawned = 0; this.bombsHit = 0; this.missed = 0;
    this.prevHand = { L: null, R: null };
  }

  start() {
    this.app.bgvideo.style.opacity = 1;
    this.app.hud.energy(null);
    this.app.hud.score(0, 0, 1);
    this.app.hud.toast('Whack the moles! Avoid bombs', '#ffd166', 1500);
    this.t0 = audio.currentTime; this.nextSpawn = 1.2; this.warned = false;
  }
  time() { return audio.currentTime - this.t0; }

  // body space -> window pixels, plus pixels per body unit
  toWin(x, y) {
    const b = this.app.body, a = this.app.pose.aspect;
    const sx = (b.center.x + x * b.scale) / a, sy = b.center.y - y * b.scale;
    const w = this.app.videoToWindow(sx, sy);
    return { x: w.x, y: w.y, u: b.scale * w.s };
  }

  spawn(t) {
    const prog = t / DURATION;
    const busy = new Set(this.moles.map(m => m.hole));
    const free = HOLES.map((_, i) => i).filter(i => !busy.has(i) && this.onScreen(HOLES[i]));
    if (!free.length) return;
    const hole = free[Math.floor(Math.random() * free.length)];
    const r = Math.random();
    const type = r < 0.12 + prog * 0.08 ? 'bomb' : r < 0.22 + prog * 0.08 ? 'gold' : 'mole';
    const stay = (type === 'gold' ? 0.8 : 1.5) - prog * 0.6;
    this.moles.push({ hole, type, born: t, stay, state: 'up', bonk: 0 });
    if (type !== 'bomb') this.spawned++;
  }

  onScreen(h) {
    const p = this.toWin(h.x, h.y), m = p.u * 0.5;
    return p.x > m && p.x < innerWidth - m && p.y > m + 60 && p.y < innerHeight - m;
  }

  update(dt) {
    const t = this.time(), b = this.app.body;
    if (!b.center) return;
    const prog = Math.min(1, t / DURATION);
    if (t >= this.nextSpawn && t < DURATION) {
      const maxUp = prog < 0.3 ? 1 : prog < 0.65 ? 2 : 3;
      if (this.moles.filter(m => m.state === 'up').length < maxUp) this.spawn(t);
      this.nextSpawn = t + 0.95 - prog * 0.5 + Math.random() * 0.3;
    }
    if (!this.warned && t > DURATION - 10) { this.warned = true; this.app.hud.toast('10 SECONDS!', '#ff5470', 900); }

    // hands are the mallets; a hit needs the hand to arrive, not just rest there
    for (const side of ['L', 'R']) {
      const h = b.handBody(side);
      const prev = this.prevHand[side]; this.prevHand[side] = h.ok ? h : null;
      if (!h.ok) continue;
      for (const m of this.moles) {
        if (m.state !== 'up' || t - m.born < 0.12) continue;
        const hole = HOLES[m.hole];
        const d = Math.hypot(h.x - hole.x, h.y - (hole.y + 0.1));
        const wasIn = prev && Math.hypot(prev.x - hole.x, prev.y - (hole.y + 0.1)) < HIT_R;
        if (d < HIT_R && !wasIn) this.whack(m, side, t);
      }
    }
    for (const m of this.moles) {
      if (m.state === 'up' && t - m.born > m.stay) {
        m.state = 'down'; m.downAt = t;
        if (m.type !== 'bomb') { this.missed++; this.combo = 0; this.app.hud.score(this.score, 0, 1); }
      }
    }
    this.moles = this.moles.filter(m => !(m.state !== 'up' && t - m.downAt > 0.25));
    for (const f of this.fx) f.life -= dt;
    this.fx = this.fx.filter(f => f.life > 0);
    this.app.hud.progress(prog);
    if (t > DURATION + 0.8) this.end();
  }

  whack(m, side, t) {
    m.state = 'bonked'; m.downAt = t;
    const hole = HOLES[m.hole], T = TYPES[m.type];
    if (m.type === 'bomb') {
      this.bombsHit++; this.combo = 0; sfx.boom();
      this.app.hud.toast('BOOM!', '#ff5470', 600);
    } else {
      this.hits++; this.combo++; this.bestCombo = Math.max(this.bestCombo, this.combo);
      sfx.ding(m.type === 'gold' ? 96 : 84 + Math.min(12, this.combo));
      if (this.combo % 10 === 0) this.app.hud.toast(`${this.combo} IN A ROW!`, '#ffd166', 700);
    }
    const pts = T.pts * (m.type === 'bomb' ? 1 : 1 + Math.floor(this.combo / 5));
    this.score = Math.max(0, this.score + pts);
    this.app.hud.score(this.score, this.combo, 1 + Math.floor(this.combo / 5));
    this.fx.push({ x: hole.x, y: hole.y + 0.4, text: (pts > 0 ? '+' : '') + pts, color: m.type === 'bomb' ? '#ff5470' : '#ffd166', life: 0.8, side });
    for (let k = 0; k < 10; k++) {
      const a = Math.random() * Math.PI * 2;
      this.fx.push({ x: hole.x, y: hole.y + 0.1, star: true, vx: Math.cos(a) * 2.5, vy: Math.sin(a) * 2.5 + 1, life: 0.5, color: m.type === 'bomb' ? '#ff9a3c' : '#fff6a8' });
    }
  }

  render() {
    const g = this.app.octx, b = this.app.body, t = this.time();
    g.clearRect(0, 0, innerWidth, innerHeight);
    if (!b.center) return;
    // dim the camera slightly so the moles pop
    g.fillStyle = 'rgba(10, 6, 25, .25)'; g.fillRect(0, 0, innerWidth, innerHeight);
    HOLES.forEach((h, i) => { if (this.onScreen(h)) this.drawHole(g, h); });
    for (const m of this.moles) this.drawMole(g, m, t);
    for (const f of this.fx) {
      if (f.star) {
        const age = 0.5 - f.life, p = this.toWin(f.x + f.vx * age, f.y + f.vy * age);
        g.fillStyle = f.color; g.globalAlpha = f.life * 2;
        g.beginPath(); g.arc(p.x, p.y, p.u * 0.06, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;
      } else {
        const p = this.toWin(f.x, f.y + (0.8 - f.life) * 0.8);
        g.globalAlpha = Math.min(1, f.life * 2); g.fillStyle = f.color; g.textAlign = 'center';
        g.font = `900 ${Math.round(p.u * 0.35)}px system-ui`; g.fillText(f.text, p.x, p.y); g.globalAlpha = 1;
      }
    }
    for (const side of ['L', 'R']) this.drawMallet(g, side);
    // too close to the camera and the outer holes fall off-screen
    if (HOLES.filter(h => this.onScreen(h)).length < 8) {
      g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(innerWidth / 2 - 230, innerHeight - 140, 460, 54);
      g.fillStyle = '#ffd166'; g.font = '800 26px system-ui'; g.textAlign = 'center';
      g.fillText('Step back so all the holes fit!', innerWidth / 2, innerHeight - 104);
    }
    // timer
    const left = Math.max(0, Math.ceil(DURATION - t));
    g.fillStyle = left <= 10 ? '#ff5470' : '#fff'; g.font = '900 44px system-ui'; g.textAlign = 'center';
    g.fillText(`${left}`, innerWidth / 2, 110);
  }

  drawHole(g, h) {
    const p = this.toWin(h.x, h.y), r = MOLE_R * p.u;
    g.fillStyle = '#1a0f08';
    g.beginPath(); g.ellipse(p.x, p.y + r * 0.55, r * 1.25, r * 0.4, 0, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#6b4a2a'; g.lineWidth = r * 0.15; g.stroke();
  }

  drawMole(g, m, t) {
    const h = HOLES[m.hole], p = this.toWin(h.x, h.y), r = MOLE_R * p.u;
    // pop-up / drop-down animation
    let rise = Math.min(1, (t - m.born) / 0.12);
    if (m.state !== 'up') rise = Math.max(0, 1 - (t - m.downAt) / 0.2);
    const squash = m.state === 'bonked' ? 0.6 : 1;
    const cy = p.y + r * 0.55 - r * 1.3 * rise;
    g.save();
    g.beginPath(); g.rect(p.x - r * 2, p.y - r * 3, r * 4, r * 3.55); g.clip(); // hide below the hole rim
    if (m.type === 'bomb') {
      g.fillStyle = '#1b1b22'; g.beginPath(); g.arc(p.x, cy, r, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,255,255,.25)'; g.beginPath(); g.arc(p.x - r * 0.35, cy - r * 0.35, r * 0.25, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#a07040'; g.lineWidth = r * 0.12; g.beginPath(); g.moveTo(p.x, cy - r); g.quadraticCurveTo(p.x + r * 0.3, cy - r * 1.5, p.x + r * 0.5, cy - r * 1.4); g.stroke();
      g.fillStyle = Math.sin(t * 30) > 0 ? '#ffd166' : '#ff5a2a'; g.beginPath(); g.arc(p.x + r * 0.5, cy - r * 1.4, r * 0.16, 0, Math.PI * 2); g.fill();
    } else {
      const col = TYPES[m.type].color;
      g.translate(p.x, cy); g.scale(1, squash);
      g.fillStyle = col; g.beginPath(); g.ellipse(0, 0, r, r * 1.1, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = m.type === 'gold' ? '#ffe9a0' : '#c99a78'; g.beginPath(); g.ellipse(0, r * 0.35, r * 0.6, r * 0.5, 0, 0, Math.PI * 2); g.fill();
      const dead = m.state === 'bonked';
      g.fillStyle = '#111'; g.strokeStyle = '#111'; g.lineWidth = r * 0.08;
      for (const s of [-1, 1]) {
        if (dead) { g.beginPath(); g.moveTo(s * r * 0.45, -r * 0.4); g.lineTo(s * r * 0.2, -r * 0.15); g.moveTo(s * r * 0.2, -r * 0.4); g.lineTo(s * r * 0.45, -r * 0.15); g.stroke(); }
        else { g.beginPath(); g.arc(s * r * 0.32, -r * 0.28, r * 0.11, 0, Math.PI * 2); g.fill(); }
      }
      g.fillStyle = '#ff7aa2'; g.beginPath(); g.ellipse(0, r * 0.05, r * 0.16, r * 0.12, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff'; g.fillRect(-r * 0.12, r * 0.28, r * 0.11, r * 0.16); g.fillRect(r * 0.01, r * 0.28, r * 0.11, r * 0.16);
      if (m.type === 'gold') {
        g.fillStyle = '#ffd700'; g.beginPath();
        g.moveTo(-r * 0.45, -r * 0.95); g.lineTo(-r * 0.45, -r * 1.35); g.lineTo(-r * 0.2, -r * 1.15); g.lineTo(0, -r * 1.45);
        g.lineTo(r * 0.2, -r * 1.15); g.lineTo(r * 0.45, -r * 1.35); g.lineTo(r * 0.45, -r * 0.95); g.closePath(); g.fill();
      }
    }
    g.restore();
  }

  drawMallet(g, side) {
    const h = this.app.body.handBody(side); if (!h.ok) return;
    const p = this.toWin(h.x, h.y), u = p.u;
    const tilt = side === 'L' ? -0.5 : 0.5;
    g.save(); g.translate(p.x, p.y); g.rotate(tilt);
    g.fillStyle = '#c8a070'; g.fillRect(-u * 0.05, 0, u * 0.1, u * 0.55);
    g.fillStyle = side === 'L' ? '#ff3b5c' : '#2fa8ff';
    g.beginPath(); g.roundRect(-u * 0.28, -u * 0.18, u * 0.56, u * 0.3, u * 0.08); g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 3; g.stroke();
    g.restore();
    // hit zone ring so you can see where the mallet counts
    g.strokeStyle = h.src === 'hand' ? 'rgba(255,255,255,.6)' : 'rgba(255,255,255,.25)';
    g.setLineDash([6, 6]); g.lineWidth = 2;
    g.beginPath(); g.arc(p.x, p.y, u * 0.18, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
  }

  end() {
    if (this.ended) return; this.ended = true;
    const acc = this.spawned ? this.hits / this.spawned : 0;
    const rank = acc >= 0.9 ? 'S' : acc >= 0.75 ? 'A' : acc >= 0.55 ? 'B' : acc >= 0.35 ? 'C' : 'D';
    this.app.finish({
      rank, failed: false, title: "Time's up!",
      stats: {
        Score: this.score.toLocaleString(), 'Moles whacked': `${this.hits} / ${this.spawned}`,
        Accuracy: `${(acc * 100).toFixed(0)}%`, 'Best combo': this.bestCombo, 'Bombs hit': this.bombsHit,
      },
    });
  }

  dispose() {
    this.app.bgvideo.style.opacity = 0;
    this.app.octx.clearRect(0, 0, innerWidth, innerHeight);
  }
}
