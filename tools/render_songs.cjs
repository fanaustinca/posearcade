// Pre-renders the built-in synth songs to web/songs/<id>.wav using headless
// Chrome (same WebAudio code the game uses). Run with the server up:
//   node tools/render_songs.cjs && python tools/wav_to_flac.py
// Needs puppeteer (npm i puppeteer) or PUPPETEER_PATH pointing at it;
// CHROME_PATH picks a system Chrome if the bundled one can't run.
const puppeteer = require(process.env.PUPPETEER_PATH || 'puppeteer');
const fs = require('fs'), path = require('path');
const URL = process.env.POSE_URL || 'https://localhost:8600/';
(async () => {
  const b = await puppeteer.launch({ headless: 'new', executablePath: process.env.CHROME_PATH, args: ['--ignore-certificate-errors'] });
  const p = await b.newPage();
  await p.goto(URL, { waitUntil: 'networkidle0' });
  const ids = await p.evaluate(async () => (await import('./js/audio.js')).SONGS.map(s => s.id));
  for (const id of ids) {
    const t = Date.now();
    const b64 = await p.evaluate(async (id) => {
      const A = await import('./js/audio.js');
      const buf = await A.renderSongOffline(A.SONGS.find(s => s.id === id));
      const d = buf.getChannelData(0), pcm = new Int16Array(d.length);
      for (let i = 0; i < d.length; i++) pcm[i] = Math.max(-1, Math.min(1, d[i])) * 32767;
      let s = ''; const u8 = new Uint8Array(pcm.buffer);
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      return btoa(s);
    }, id);
    const pcm = Buffer.from(b64, 'base64'), hdr = Buffer.alloc(44), sr = 44100;
    hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write('WAVEfmt ', 8);
    hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(sr, 24);
    hdr.writeUInt32LE(sr * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(pcm.length, 40);
    fs.writeFileSync(path.join(__dirname, '..', 'web', 'songs', `${id}.wav`), Buffer.concat([hdr, pcm]));
    console.log(`${id}: ${(pcm.length / 2 / sr).toFixed(1)}s rendered in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  }
  await b.close();
})();
