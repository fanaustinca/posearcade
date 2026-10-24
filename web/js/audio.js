// WebAudio: instrument voices that play single notes (one per block hit),
// soft chord backing that rides on chord-change notes, and sound effects.

export const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
const master = ctx.createGain(); master.gain.value = 0.8;
const comp = ctx.createDynamicsCompressor();
comp.threshold.value = -14; comp.ratio.value = 4;
master.connect(comp).connect(ctx.destination);
export const musicBus = ctx.createGain(); musicBus.gain.value = 0.8; musicBus.connect(master);
export const sfxBus = ctx.createGain(); sfxBus.gain.value = 0.5; sfxBus.connect(master);

const noise = (() => {
  const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
})();
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const pulse25 = (() => {
  const n = 32, re = new Float32Array(n), im = new Float32Array(n);
  for (let k = 1; k < n; k++) im[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * 0.25);
  return ctx.createPeriodicWave(re, im);
})();

// Every scheduled source, so quitting a level can silence it.
const live = new Set();
function track(src, stopAt) {
  src.stop(stopAt); live.add(src); src.onended = () => live.delete(src);
}
export function stopAll() { for (const s of live) { try { s.stop(); } catch { } } live.clear(); }

function env(g, t, a, peak, d, sus = 0.0001) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(sus, t + a + d);
}
function osc(type, freq, t, out, stopAt, detune = 0) {
  const o = ctx.createOscillator();
  if (type === 'pulse') o.setPeriodicWave(pulse25); else o.type = type;
  o.frequency.value = freq; o.detune.value = detune;
  o.connect(out); o.start(t); track(o, stopAt);
  return o;
}
// Struck/plucked: decays on its own, damped after the note length.
function struck(t, dur, peak, decay) {
  const g = ctx.createGain(), len = Math.max(dur, 0.12);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  g.gain.setTargetAtTime(0.0001, t + len, 0.06);
  return { g, end: t + Math.min(len + 0.3, decay + 0.05) };
}
// Sustained: holds for the note length, then releases.
function held(t, dur, peak, attack, release) {
  const g = ctx.createGain(), hold = Math.max(attack, dur - 0.02);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.setValueAtTime(peak, t + hold);
  g.gain.linearRampToValueAtTime(0.0001, t + hold + release);
  return { g, end: t + hold + release + 0.05 };
}

const VOICES = {
  piano(m, t, dur, v) {
    const f = mtof(m), { g, end } = struck(t, dur, 0.32 * v, Math.max(0.6, 2.2 - (m - 60) * 0.03));
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 4200;
    g.connect(lp).connect(musicBus);
    osc('triangle', f, t, g, end); osc('sine', f * 2, t, g, end, 3);
    const g2 = ctx.createGain(); g2.gain.value = 0.25; g2.connect(g); osc('sine', f * 3, t, g2, end, -4);
  },
  musicbox(m, t, dur, v) {
    const f = mtof(m + 12), { g, end } = struck(t, Math.max(dur, 0.6), 0.3 * v, 1.6);
    g.connect(musicBus); osc('sine', f, t, g, end);
    const g2 = ctx.createGain(); g2.gain.value = 0.22; g2.connect(g); osc('sine', f * 4.02, t, g2, end);
    const g3 = ctx.createGain(); g3.gain.value = 0.08; g3.connect(g); osc('sine', f * 6.8, t, g3, end);
  },
  marimba(m, t, dur, v) {
    const f = mtof(m), { g, end } = struck(t, dur, 0.42 * v, 0.7);
    g.connect(musicBus); osc('sine', f, t, g, end);
    const { g: g2 } = struck(t, 0.1, 0.12 * v, 0.12); g2.connect(musicBus); osc('sine', f * 4, t, g2, t + 0.2);
  },
  organ(m, t, dur, v) {
    const f = mtof(m), { g, end } = held(t, dur, 0.13 * v, 0.012, 0.08);
    g.connect(musicBus);
    [[1, 1], [2, 0.6], [3, 0.35], [4, 0.25], [6, 0.12]].forEach(([h, a]) => {
      const gg = ctx.createGain(); gg.gain.value = a; gg.connect(g); osc('sine', f * h, t, gg, end);
    });
  },
  sleigh(m, t, dur, v) {
    VOICES.piano(m, t, dur, v);
    for (let k = 0; k < 3; k++) { // jingle
      const n = ctx.createBufferSource(); n.buffer = noise;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 7000 + k * 1500; bp.Q.value = 3;
      const g = ctx.createGain(); env(g, t + k * 0.03, 0.001, 0.18 * v, 0.12);
      n.connect(bp).connect(g).connect(musicBus); n.start(t + k * 0.03, Math.random() * 0.5); track(n, t + 0.3);
    }
  },
  strings(m, t, dur, v) {
    const f = mtof(m), { g, end } = held(t, dur, 0.12 * v, 0.07, 0.35);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400; lp.Q.value = 0.5;
    g.connect(lp).connect(musicBus);
    const vib = ctx.createOscillator(), vg = ctx.createGain(); vib.frequency.value = 5.2; vg.gain.value = 9;
    vib.connect(vg); vib.start(t); track(vib, end);
    for (const d of [-7, 7]) vg.connect(osc('sawtooth', f, t, g, end, d).detune);
  },
  chip(m, t, dur, v) {
    const len = Math.min(dur, 0.6);
    const { g, end } = held(t, len, 0.11 * v, 0.004, 0.05);
    g.connect(musicBus); osc('pulse', mtof(m), t, g, end);
    const { g: gb, end: eb } = held(t, len, 0.09 * v, 0.004, 0.04); // octave-down triangle
    gb.connect(musicBus); osc('triangle', mtof(m - 12), t, gb, eb);
  },
  pizz(m, t, dur, v) {
    const f = mtof(m), { g, end } = struck(t, dur, 0.38 * v, 0.45);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 2;
    lp.frequency.setValueAtTime(3500, t); lp.frequency.exponentialRampToValueAtTime(500, t + 0.3);
    g.connect(lp).connect(musicBus);
    osc('sawtooth', f, t, g, end); osc('triangle', f / 2, t, g, end);
  },
  brass(m, t, dur, v) {
    const f = mtof(m), { g, end } = held(t, dur, 0.13 * v, 0.03, 0.12);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1.5;
    lp.frequency.setValueAtTime(400, t); lp.frequency.linearRampToValueAtTime(2600, t + 0.06);
    lp.frequency.setTargetAtTime(1500, t + 0.08, 0.2);
    g.connect(lp).connect(musicBus);
    osc('sawtooth', f, t, g, end, -4); osc('sawtooth', f, t, g, end, 5);
  },
  flute(m, t, dur, v) {
    const f = mtof(m + 12), { g, end } = held(t, dur, 0.2 * v, 0.04, 0.12);
    g.connect(musicBus);
    const vib = ctx.createOscillator(), vg = ctx.createGain(); vib.frequency.value = 5; vg.gain.value = 12;
    vib.connect(vg); vib.start(t + 0.1); track(vib, end);
    vg.connect(osc('sine', f, t, g, end).detune);
    const g2 = ctx.createGain(); g2.gain.value = 0.12; g2.connect(g); osc('sine', f * 2, t, g2, end);
    const n = ctx.createBufferSource(); n.buffer = noise; // breath
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f * 2; bp.Q.value = 4;
    const ng = ctx.createGain(); env(ng, t, 0.01, 0.06 * v, 0.12);
    n.connect(bp).connect(ng).connect(musicBus); n.start(t, Math.random() * 0.5); track(n, t + 0.2);
  },
  harpsi(m, t, dur, v) {
    const f = mtof(m), { g, end } = struck(t, dur, 0.22 * v, 0.9);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 180;
    g.connect(hp).connect(musicBus);
    osc('sawtooth', f, t, g, end); osc('square', f * 2, t, g, end, 4);
  },
  banjo(m, t, dur, v) {
    const f = mtof(m), { g, end } = struck(t, dur, 0.35 * v, 0.5);
    const bp = ctx.createBiquadFilter(); bp.type = 'peaking'; bp.frequency.value = 2200; bp.gain.value = 9; bp.Q.value = 1;
    g.connect(bp).connect(musicBus);
    osc('sawtooth', f, t, g, end); osc('triangle', f * 2, t, g, end, 6);
  },
};

// One melody note (a hit block). A late hit still sounds, just late.
export function playNote(voice, midi, when, dur, vel = 1) {
  (VOICES[voice] || VOICES.piano)(midi, Math.max(when, ctx.currentTime), dur, vel);
}

// Quiet chord + bass under the melody.
export function playChord(tones, when, dur) {
  const t = Math.max(when, ctx.currentTime);
  const { g, end } = held(t, dur, 0.035, 0.08, 0.4);
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400;
  g.connect(lp).connect(musicBus);
  for (const m of tones) { osc('triangle', mtof(m), t, g, end, -5); osc('sawtooth', mtof(m), t, g, end, 6); }
  const { g: gb, end: eb } = struck(t, dur, 0.22, Math.max(0.8, dur + 0.3));
  gb.connect(musicBus); osc('sine', mtof(tones[0] - 12), t, gb, eb);
}

// ---- Sound effects ----
export const sfx = {
  slice(pitch = 1, vol = 1) {
    const t = ctx.currentTime;
    const n = ctx.createBufferSource(); n.buffer = noise; n.playbackRate.value = pitch;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 2;
    f.frequency.setValueAtTime(5200 * pitch, t); f.frequency.exponentialRampToValueAtTime(900, t + 0.12);
    const g = ctx.createGain(); env(g, t, 0.002, 0.6 * vol, 0.14);
    n.connect(f).connect(g).connect(sfxBus); n.start(t); n.stop(t + 0.2);
  },
  miss() {
    const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'triangle'; o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(90, t + 0.2);
    env(g, t, 0.003, 0.15, 0.22); o.connect(g).connect(sfxBus); o.start(t); o.stop(t + 0.3);
  },
  boom() {
    const t = ctx.currentTime;
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.15);
    env(og, t, 0.002, 1.2, 0.4); o.connect(og).connect(sfxBus); o.start(t); o.stop(t + 0.45);
    const n = ctx.createBufferSource(); n.buffer = noise;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(3000, t); f.frequency.exponentialRampToValueAtTime(100, t + 0.6);
    const g = ctx.createGain(); env(g, t, 0.005, 0.9, 0.6);
    n.connect(f).connect(g).connect(sfxBus); n.start(t); n.stop(t + 0.7);
  },
  ding(m = 84) { VOICES.musicbox(m - 12, ctx.currentTime, 0.3, 1.2); },
  chord(m = 72) { const t = ctx.currentTime; [0, 4, 7, 12].forEach((d, i) => VOICES.musicbox(m + d - 12, t + i * 0.07, 0.4, 1)); },
  tick() {
    const t = ctx.currentTime, n = ctx.createBufferSource(); n.buffer = noise;
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 6000;
    const g = ctx.createGain(); env(g, t, 0.001, 0.4, 0.05);
    n.connect(f).connect(g).connect(sfxBus); n.start(t); n.stop(t + 0.1);
  },
};
