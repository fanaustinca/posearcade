// WebAudio: a small procedural synth band for built-in songs, sound effects,
// and onset detection for user-loaded songs.

export const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
const master = ctx.createGain(); master.gain.value = 0.8;
const comp = ctx.createDynamicsCompressor();
comp.threshold.value = -14; comp.ratio.value = 4;
master.connect(comp).connect(ctx.destination);
export const musicBus = ctx.createGain(); musicBus.gain.value = 0.7; musicBus.connect(master);
export const sfxBus = ctx.createGain(); sfxBus.gain.value = 0.6; sfxBus.connect(master);

const noise = (() => {
  const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
})();
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

function env(g, t, a, peak, d, sus = 0.0001) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(sus, t + a + d);
}

const inst = {
  kick(t, out, v = 1) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    env(g, t, 0.002, v, 0.35); o.connect(g).connect(out); o.start(t); o.stop(t + 0.4);
  },
  snare(t, out, v = 1) {
    const n = ctx.createBufferSource(); n.buffer = noise;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1900; f.Q.value = 0.7;
    const g = ctx.createGain(); env(g, t, 0.002, 0.7 * v, 0.2);
    n.connect(f).connect(g).connect(out); n.start(t); n.stop(t + 0.25);
    const o = ctx.createOscillator(), g2 = ctx.createGain(); o.frequency.value = 185;
    env(g2, t, 0.002, 0.4 * v, 0.1); o.connect(g2).connect(out); o.start(t); o.stop(t + 0.15);
  },
  clap(t, out, v = 1) {
    for (let k = 0; k < 3; k++) {
      const n = ctx.createBufferSource(); n.buffer = noise;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1200; f.Q.value = 1.2;
      const g = ctx.createGain(); env(g, t + k * 0.012, 0.001, 0.45 * v, k === 2 ? 0.18 : 0.02);
      n.connect(f).connect(g).connect(out); n.start(t + k * 0.012); n.stop(t + 0.3);
    }
  },
  hat(t, out, v = 1, open = false) {
    const n = ctx.createBufferSource(); n.buffer = noise;
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7500;
    const g = ctx.createGain(); env(g, t, 0.001, 0.22 * v, open ? 0.22 : 0.045);
    n.connect(f).connect(g).connect(out); n.start(t); n.stop(t + 0.3);
  },
  bass(t, out, midi, dur, v = 1) {
    const o = ctx.createOscillator(), o2 = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = 'sawtooth'; o2.type = 'square'; o.frequency.value = mtof(midi); o2.frequency.value = mtof(midi - 12);
    f.type = 'lowpass'; f.Q.value = 6;
    f.frequency.setValueAtTime(1400, t); f.frequency.exponentialRampToValueAtTime(220, t + dur * 0.9);
    env(g, t, 0.005, 0.32 * v, dur);
    o.connect(f); o2.connect(f); f.connect(g).connect(out);
    o.start(t); o2.start(t); o.stop(t + dur + 0.05); o2.stop(t + dur + 0.05);
  },
  pluck(t, out, midi, v = 1, type = 'square') {
    const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = type; o.frequency.value = mtof(midi);
    f.type = 'lowpass'; f.frequency.setValueAtTime(5000, t); f.frequency.exponentialRampToValueAtTime(600, t + 0.2);
    env(g, t, 0.003, 0.13 * v, 0.22);
    o.connect(f).connect(g).connect(out); o.start(t); o.stop(t + 0.3);
  },
  pad(t, out, notes, dur, v = 1) {
    const f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'lowpass'; f.frequency.value = 1600;
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.05 * v, t + 0.3);
    g.gain.setValueAtTime(0.05 * v, t + dur - 0.2); g.gain.linearRampToValueAtTime(0.0001, t + dur);
    f.connect(g).connect(out);
    for (const m of notes) for (const det of [-8, 7]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = det;
      o.connect(f); o.start(t); o.stop(t + dur + 0.05);
    }
  },
};

// Built-in originals. Sections: [bars, intensity 0..3]. Progression = semitone
// offsets of chord roots from the key, one chord per bar; minor/major per song.
export const SONGS = [
  { id: 'neon', name: 'Neon Runner', bpm: 118, key: 45, minor: true, prog: [0, -4, -7, -2],
    sections: [[4, 0], [8, 1], [8, 2], [4, 1], [8, 3], [8, 2], [4, 0]], lead: 'square', diff: 'Easy-friendly' },
  { id: 'pulse', name: 'Pulse Drive', bpm: 128, key: 50, minor: true, prog: [0, -2, -4, -5],
    sections: [[4, 1], [8, 2], [8, 3], [4, 1], [8, 2], [8, 3], [4, 1]], lead: 'sawtooth', diff: 'Steady' },
  { id: 'sky', name: 'Sky Circuit', bpm: 140, key: 52, minor: false, prog: [0, 7, 9, 5],
    sections: [[4, 1], [8, 2], [8, 3], [4, 2], [8, 3], [8, 3], [4, 1]], lead: 'triangle', diff: 'Fast' },
  { id: 'storm', name: 'Overclock Storm', bpm: 160, key: 47, minor: true, prog: [0, -4, -2, -5],
    sections: [[4, 2], [8, 3], [8, 3], [4, 2], [8, 3], [8, 3], [2, 1]], lead: 'sawtooth', diff: 'Brutal' },
];

// Beat timeline used by both the sequencer and the map generator.
export function songTimeline(song) {
  const spb = 60 / song.bpm, beats = [];
  let bar = 0;
  for (const [bars, intensity] of song.sections) {
    for (let b = 0; b < bars; b++, bar++) for (let q = 0; q < 4; q++)
      beats.push({ t: (bar * 4 + q) * spb, bar, q, intensity, sectionStart: b === 0 && q === 0 });
  }
  return { beats, duration: bar * 4 * spb + 1.5, spb, bars: bar };
}

export class Sequencer {
  constructor(song) { this.song = song; this.tl = songTimeline(song); this.timer = null; }
  start(when) {
    this.t0 = when; this.step = 0; this.stopped = false;
    const s = this.song, spb = this.tl.spb, s16 = spb / 4, minor = s.minor;
    const chordTones = (root) => [root, root + (minor ? 3 : 4), root + 7];
    const arp = [0, 2, 1, 2, 0, 2, 1, 3];
    const tick = () => {
      if (this.stopped) return;
      const horizon = ctx.currentTime + 0.2;
      while (true) {
        const t = this.t0 + this.step * s16;
        if (t > horizon) break;
        const beatIdx = Math.floor(this.step / 4), sub = this.step % 4;
        const beat = this.tl.beats[beatIdx];
        if (!beat) { this.stopped = true; break; }
        const lvl = beat.intensity, q = beat.q;
        const root = s.key + s.prog[beat.bar % s.prog.length];
        const out = musicBus;
        if (sub === 0) {
          if (lvl >= 1 || q === 0) inst.kick(t, out, lvl === 0 ? 0.6 : 1);
          if (lvl >= 1 && (q === 1 || q === 3)) (lvl >= 3 ? inst.clap : inst.snare)(t, out, 0.9);
          if (q === 0) inst.pad(t, out, chordTones(root + 12), spb * 4, lvl === 0 ? 1.4 : 1);
        }
        if (lvl >= 2 && sub === 2) inst.hat(t, out, 1, q === 3);
        if (lvl >= 3 && (sub === 1 || sub === 3)) inst.hat(t, out, 0.5);
        if (lvl >= 1 && (sub === 0 || sub === 2 || (lvl >= 3 && sub === 3)))
          inst.bass(t, out, root - 12 + (sub === 3 ? 12 : 0), s16 * 1.8, 0.9);
        if (lvl >= 2 || (lvl === 1 && sub % 2 === 0)) {
          const tones = chordTones(root + 24);
          const n = arp[(this.step) % arp.length];
          inst.pluck(t, out, n === 3 ? tones[0] + 12 : tones[n], lvl >= 2 ? 1 : 0.6, s.lead);
        }
        this.step++;
      }
      this.timer = setTimeout(tick, 30);
    };
    tick();
  }
  stop() { this.stopped = true; clearTimeout(this.timer); }
}

// Plays a decoded user AudioBuffer.
export class BufferPlayer {
  constructor(buffer) { this.buffer = buffer; }
  start(when) {
    this.src = ctx.createBufferSource(); this.src.buffer = this.buffer;
    this.src.connect(musicBus); this.src.start(when);
  }
  stop() { try { this.src.stop(); } catch { } }
}

// Onset detection for a user song: band energy flux + adaptive threshold.
export function detectOnsets(buffer) {
  const sr = buffer.sampleRate, ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
  const hop = Math.round(sr * 0.01), n = Math.floor(ch0.length / hop);
  const low = new Float32Array(n), high = new Float32Array(n);
  let lp = 0, hpPrev = 0, hp = 0;
  const aL = 1 - Math.exp(-2 * Math.PI * 180 / sr), aH = Math.exp(-2 * Math.PI * 2500 / sr);
  for (let f = 0; f < n; f++) {
    let el = 0, eh = 0;
    for (let i = f * hop, e = i + hop; i < e; i++) {
      const x = (ch0[i] + ch1[i]) * 0.5;
      lp += aL * (x - lp); el += lp * lp;
      hp = aH * (hp + x - hpPrev); hpPrev = x; eh += hp * hp;
    }
    low[f] = Math.log1p(el * 1000); high[f] = Math.log1p(eh * 1000);
  }
  const flux = new Float32Array(n);
  for (let f = 1; f < n; f++) flux[f] = Math.max(0, low[f] - low[f - 1]) * 1.3 + Math.max(0, high[f] - high[f - 1]);
  const onsets = [], W = 50;
  let last = -1;
  for (let f = 2; f < n - 2; f++) {
    let sum = 0, c = 0;
    for (let k = Math.max(0, f - W); k < Math.min(n, f + W); k++) { sum += flux[k]; c++; }
    const thr = (sum / c) * 1.6 + 0.02;
    const isPeak = flux[f] > thr && flux[f] >= flux[f - 1] && flux[f] >= flux[f + 1] && flux[f] >= flux[f - 2];
    if (isPeak && f - last > 9) { onsets.push({ t: f * hop / sr, s: flux[f] / thr }); last = f; }
  }
  // Loudness envelope (per second) for section intensity.
  const loud = [];
  for (let s = 0; s * 100 < n; s++) {
    let e = 0, c = 0;
    for (let f = s * 100; f < Math.min(n, (s + 1) * 100); f++) { e += low[f] + high[f]; c++; }
    loud.push(e / c);
  }
  return { onsets, loud, duration: buffer.duration };
}

// ---- Sound effects ----
export const sfx = {
  slice(pitch = 1) {
    const t = ctx.currentTime;
    const n = ctx.createBufferSource(); n.buffer = noise; n.playbackRate.value = pitch;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 2;
    f.frequency.setValueAtTime(5200 * pitch, t); f.frequency.exponentialRampToValueAtTime(900, t + 0.12);
    const g = ctx.createGain(); env(g, t, 0.002, 0.6, 0.14);
    n.connect(f).connect(g).connect(sfxBus); n.start(t); n.stop(t + 0.2);
  },
  miss() {
    const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'triangle'; o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(90, t + 0.2);
    env(g, t, 0.003, 0.25, 0.22); o.connect(g).connect(sfxBus); o.start(t); o.stop(t + 0.3);
  },
  boom() {
    const t = ctx.currentTime;
    inst.kick(t, sfxBus, 1.3);
    const n = ctx.createBufferSource(); n.buffer = noise;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(3000, t); f.frequency.exponentialRampToValueAtTime(100, t + 0.6);
    const g = ctx.createGain(); env(g, t, 0.005, 0.9, 0.6);
    n.connect(f).connect(g).connect(sfxBus); n.start(t); n.stop(t + 0.7);
  },
  ding(m = 84) { inst.pluck(ctx.currentTime, sfxBus, m, 2.2, 'triangle'); },
  chord(m = 72) { const t = ctx.currentTime; [0, 4, 7, 12].forEach((d, i) => inst.pluck(t + i * 0.06, sfxBus, m + d, 2, 'triangle')); },
  tick() { inst.hat(ctx.currentTime, sfxBus, 1.5); },
};
