// Plays every game in a real (headless) Chrome against a running Unbound
// server, with a photo as the webcam. Fails on any page error.
//   URL=http://127.0.0.1:8600/ Y4M=cam.y4m CHROME=path OUT=dir node e2e.cjs
const puppeteer = require(process.env.PUPPETEER || 'puppeteer-core');
const { URL, Y4M, CHROME, OUT = '.' } = process.env;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const errors = [];
  const fail = (m) => { console.log('FAIL', m); errors.push(m); };
  const b = await puppeteer.launch({
    headless: true, executablePath: CHROME, args: [
      '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${Y4M}`, '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });
  const p = await b.newPage();
  await p.setViewport({ width: 1280, height: 720 });
  p.on('pageerror', e => fail('page error: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') console.log('console error:', m.text().slice(0, 200)); });
  for (let i = 0; ; i++) {  // the server may still be starting
    try { await p.goto(URL, { waitUntil: 'networkidle0' }); break; } catch (e) { if (i > 120) throw e; await sleep(1000); }
  }

  await p.waitForFunction(() => /Pose engine:|failed/.test(document.querySelector('#engineMsg').textContent), { timeout: 600000 });
  const eng = await p.$eval('#engineMsg', e => e.textContent);
  console.log(eng);
  if (!eng.startsWith('Pose engine:')) fail(eng);
  await p.screenshot({ path: `${OUT}/e2e-start.png` });

  await p.click('#btnStart');
  try {
    await p.waitForFunction(() => pa.pose.stats.connected && pa.pose.stats.fps > 0 && pa.body.present, { timeout: 60000 });
  } catch { fail('no tracked player within 60 s'); }
  await sleep(2000);
  const st = await p.evaluate(() => ({ fps: pa.pose.stats.fps.toFixed(1), lat: pa.pose.stats.latency.toFixed(0), infer: pa.pose.stats.infer.toFixed(1) }));
  console.log('tracking', JSON.stringify(st));
  await p.screenshot({ path: `${OUT}/e2e-menu.png` });

  for (const [kind, diff, song, wait] of [['saber', 'Normal', 'ode', 7000], ['wall', 0, 0, 7000], ['mole', 0, 0, 6000],
    ['shooter', 0, 0, 8000], ['tennis', 'Novice', 0, 8000], ['viewer', 0, 0, 3000]]) {
    const before = errors.length;
    await p.evaluate((k, d, s) => d ? pa.launch(k, d, s) : pa.launch(k), kind, diff, song);
    await sleep(2500);
    const alive = await p.evaluate(() => !!pa.game);  // (a still photo can lose a level later on)
    if (!alive) fail(kind + ': game not running');
    await sleep(wait - 2500);
    await p.screenshot({ path: `${OUT}/e2e-${kind}.png` });
    console.log(errors.length === before && alive ? 'PASS' : 'FAIL', kind);
  }
  await b.close();
  console.log(errors.length ? `E2E FAILED (${errors.length})` : 'E2E PASSED');
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.log('E2E CRASHED', e); process.exit(1); });
