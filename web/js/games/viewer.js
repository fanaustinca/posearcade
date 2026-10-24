import { KP, BONES } from '../pose.js';

const NAMES = Object.keys(KP);
const LEFT = new Set([1, 3, 5, 7, 9, 11, 13, 15]);

// Not really a game: live camera + joint overlay, for checking tracking quality.
export class ViewerGame {
  constructor(app) { this.app = app; this.noAutoPause = true; this.labels = true; }

  start() {
    this.app.bgvideo.style.opacity = 1;
    this.app.hud.energy(null);
    this.app.msg('Joint Viewer — hover a hand on ✕ Exit (or press Esc) to leave · L toggles labels', 4000);
    this.onKey = (e) => { if (e.key === 'l' || e.key === 'L') this.labels = !this.labels; };
    addEventListener('keydown', this.onKey);
  }

  update() { }

  render() {
    const { octx: g, body, videoToWindow, pose } = this.app;
    g.clearRect(0, 0, innerWidth, innerHeight);
    if (!body.present) {
      g.fillStyle = 'rgba(0,0,0,.5)'; g.fillRect(innerWidth / 2 - 160, 70, 320, 44);
      g.fillStyle = '#fff'; g.font = 'bold 20px system-ui'; g.textAlign = 'center';
      g.fillText('No person detected', innerWidth / 2, 99);
      return;
    }
    const P = (i) => { const s = body.screen(i), w = videoToWindow(s.x, s.y); return { ...w, ok: s.ok, c: s.c }; };
    const scale = videoToWindow(0, 1).s;
    g.lineCap = 'round';
    for (const [a, b] of BONES) {
      const p = P(a), q = P(b); if (!p.ok || !q.ok) continue;
      g.strokeStyle = LEFT.has(a) && LEFT.has(b) ? '#ff3b5c' : (!LEFT.has(a) && !LEFT.has(b) && a > 0) ? '#2fa8ff' : '#ffffff';
      g.lineWidth = Math.max(4, scale * 0.012);
      g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke();
    }
    g.font = '13px system-ui'; g.textAlign = 'left';
    for (let i = 0; i < 17; i++) {
      const p = P(i); if (p.c < 0.1) continue;
      // confidence: red (low) -> green (high)
      g.fillStyle = `hsl(${Math.round(p.c * 120)}, 90%, 55%)`;
      g.beginPath(); g.arc(p.x, p.y, Math.max(5, scale * 0.011), 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#000'; g.lineWidth = 1.5; g.stroke();
      if (this.labels) {
        const txt = `${NAMES[i]} ${(p.c * 100).toFixed(0)}%`;
        g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(p.x + 9, p.y - 9, g.measureText(txt).width + 8, 18);
        g.fillStyle = '#fff'; g.fillText(txt, p.x + 13, p.y + 4);
      }
    }
    // hand tracker palms (solid) vs. wrist fallback (hollow)
    for (const side of ['L', 'R']) {
      const h = body.handScreen(side); if (!h.ok) continue;
      const w = videoToWindow(h.x, h.y), r = Math.max(14, scale * 0.04);
      g.strokeStyle = side === 'L' ? '#ff3b5c' : '#2fa8ff'; g.lineWidth = 4;
      g.fillStyle = h.src === 'hand' ? (side === 'L' ? 'rgba(255,59,92,.45)' : 'rgba(47,168,255,.45)') : 'transparent';
      g.beginPath(); g.arc(w.x, w.y, r, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = '#fff'; g.font = 'bold 14px system-ui'; g.textAlign = 'center';
      g.fillText(`${side === 'L' ? 'left' : 'right'} hand${h.src === 'hand' ? '' : ' (wrist)'}`, w.x, w.y - r - 6); g.textAlign = 'left';
    }
    const s = pose.stats;
    const lines = [`round trip ${s.latency.toFixed(0)} ms`, `GPU inference ${s.infer.toFixed(1)} ms`, `pose rate ${s.fps.toFixed(0)} fps`,
      `shoulder width ${body.scale ? (body.scale * 100).toFixed(1) : '–'}% of frame`];
    g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(12, 50, 250, lines.length * 22 + 12);
    g.fillStyle = '#fff'; g.font = '15px system-ui';
    lines.forEach((l, i) => g.fillText(l, 22, 72 + i * 22));
  }

  end() { }
  dispose() {
    removeEventListener('keydown', this.onKey);
    this.app.bgvideo.style.opacity = 0;
    this.app.octx.clearRect(0, 0, innerWidth, innerHeight);
  }
}
