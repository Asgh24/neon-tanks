/**
 * Regression pass for the single-player paths that the co-op refactor touched:
 * campaign, forge/shop, pause, touch layout, and the ?debug=1 overlay.
 *
 * Run with:  node tests/solo-and-mobile.test.mjs      (needs `npm run dev` running)
 */
import { chromium, devices } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8787';
const SHOTS = 'tests/shots';
mkdirSync(SHOTS, { recursive: true });

const results = [];
const ok = (name, pass, extra) => {
  results.push({ name, pass });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (extra !== undefined ? '  -> ' + extra : ''));
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(page, fn, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await page.evaluate(fn).catch(() => null);
    if (v) return v;
    await sleep(120);
  }
  return null;
}

const main = async () => {
  const browser = await chromium.launch();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  // ------------------------------------------------------------ campaign
  await page.goto(BASE, { waitUntil: 'load' });
  await until(page, () => typeof Game !== 'undefined');
  await page.click('#startBtn');
  await until(page, () => Game.state === 'armory');
  ok('campaign opens the armory', true);
  await page.click('#deployBtn');
  await until(page, () => Game.state === 'battle');
  await sleep(1200);
  const lvl1 = await page.evaluate(() => ({
    mode: Game.mode, level: Game.levelIndex, enemies: enemies.length,
    players: players.length, offline: !Net.isOnline(), host: Net.isHost(),
  }));
  ok('campaign level 1 runs solo', lvl1.mode === 'campaign' && lvl1.players === 1 && lvl1.enemies > 0,
     `enemies=${lvl1.enemies}`);
  ok('offline play still counts as host authority', lvl1.offline && lvl1.host);
  await page.screenshot({ path: SHOTS + '/9-campaign.png' });

  // Clearing the level must advance to the next armory.
  await page.evaluate(() => {
    enemies.length = 0; drones.length = 0; Game.spawnQueue = []; Game.enemiesRemaining = 0;
  });
  const advanced = await until(page, () => (Game.levelIndex === 1 && Game.state === 'armory' ? true : null), 8000);
  ok('campaign advances to level 2', !!advanced);

  // ---------------------------------------------------------------- pause
  await page.click('#deployBtn');
  await until(page, () => Game.state === 'battle');
  await page.click('#pauseBtn');
  const paused = await until(page, () => (Game.state === 'paused' ? true : null));
  ok('pause works in solo play', !!paused);
  await page.click('#resumeBtn');
  ok('resume works', !!(await until(page, () => (Game.state === 'battle' ? true : null))));

  // ---------------------------------------------------- forge / shop screens
  await page.evaluate(() => { Game.state = 'menu'; showScreen('menu'); $('hud').classList.remove('active'); });
  await page.click('#forgeBtn');
  ok('forge opens', !!(await until(page, () => (Game.state === 'forge' ? true : null))));
  await page.click('#forgeBackBtn');
  await page.click('#shopBtn');
  ok('shop opens', !!(await until(page, () => (Game.state === 'shop' ? true : null))));
  await page.click('#shopBackBtn');

  // ------------------------------------------------------- room panel + name
  await page.click('#squadBtn');
  const panelOpen = await page.evaluate(() => getComputedStyle(document.getElementById('squadPanel')).display !== 'none');
  ok('online panel opens from the menu', panelOpen);
  await page.fill('#nameInput', 'فرمانده تست');
  await page.dispatchEvent('#nameInput', 'change');
  const named = await page.evaluate(() => ({
    profile: Profile.name,
    stored: JSON.parse(localStorage.getItem('neon_tanks_profile_v1')).name,
    tank: player.name,
  }));
  ok('nickname is saved to localStorage', named.profile === 'فرمانده تست' && named.stored === named.profile, named.stored);
  ok('nickname is applied to the local tank', named.tank === named.profile, named.tank);
  await page.screenshot({ path: SHOTS + '/10-room-panel.png' });

  // --------------------------------------------------------------- ?debug=1
  await page.goto(BASE + '/?debug=1', { waitUntil: 'load' });
  await until(page, () => typeof DEBUG !== 'undefined');
  const dbg = await page.evaluate(() => {
    showFatal('probe');
    return { debug: DEBUG, overlay: !!document.getElementById('errOverlay') };
  });
  ok('?debug=1 shows the error overlay', dbg.debug && dbg.overlay);
  await page.goto(BASE, { waitUntil: 'load' });
  await until(page, () => typeof DEBUG !== 'undefined');
  const nodbg = await page.evaluate(() => {
    showFatal('probe');
    return { debug: DEBUG, overlay: !!document.getElementById('errOverlay') };
  });
  ok('errors stay hidden without ?debug=1', !nodbg.debug && !nodbg.overlay);
  // The two showFatal() probes above deliberately log to the console; they are
  // the expected output of this check, not a real page error.
  const realErrors = errors.filter(e => !e.includes('probe'));

  await ctx.close();

  // ------------------------------------------------------------ mobile touch
  const mctx = await browser.newContext({ ...devices['Pixel 7'], isMobile: true, hasTouch: true });
  const mp = await mctx.newPage();
  const mErrors = [];
  mp.on('pageerror', e => mErrors.push(String(e)));
  await mp.goto(BASE, { waitUntil: 'load' });
  await until(mp, () => typeof Touch !== 'undefined');
  const portrait = await mp.evaluate(() => ({
    touch: Touch.enabled, world: [W, H], view: [View.sw, View.sh, +View.scale.toFixed(3)],
    pads: [Touch.movePad(), Touch.aimPad()],
  }));
  ok('touch controls enable on a phone', portrait.touch);
  ok('world stays 1600x900 on mobile', portrait.world[0] === 1600 && portrait.world[1] === 900, portrait.world.join('x'));
  ok('pads anchor to the screen, not the world',
     portrait.pads[0].x < portrait.view[0] && portrait.pads[0].x > portrait.view[0] - 300,
     `movePad.x=${Math.round(portrait.pads[0].x)} screenW=${portrait.view[0]}`);

  await mp.evaluate(() => { Game.mode = 'roguelite'; startRoguelite(); });
  await until(mp, () => Game.state === 'battle');
  await sleep(800);
  await mp.screenshot({ path: SHOTS + '/11-mobile-portrait.png' });
  const rotateHint = await mp.evaluate(() => document.getElementById('rotateHint').classList.contains('active'));
  ok('portrait shows the rotate hint', rotateHint);

  await mp.setViewportSize({ width: 915, height: 412 });
  await sleep(700);
  const landscape = await mp.evaluate(() => ({
    view: [View.sw, View.sh, +View.scale.toFixed(3)],
    hint: document.getElementById('rotateHint').classList.contains('active'),
    world: [W, H],
  }));
  ok('landscape clears the rotate hint', !landscape.hint);
  ok('landscape re-letterboxes the same world',
     landscape.world[0] === 1600 && landscape.view[2] > portrait.view[2],
     `scale ${portrait.view[2]} -> ${landscape.view[2]}`);
  await mp.screenshot({ path: SHOTS + '/12-mobile-landscape.png' });
  ok('no runtime errors on mobile', mErrors.length === 0, mErrors[0] || 'clean');
  ok('no runtime errors on desktop', realErrors.length === 0, realErrors.slice(0, 2).join(' | ') || 'clean');

  await browser.close();
  const failed = results.filter(r => !r.pass);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  if (failed.length) console.log('failed: ' + failed.map(f => f.name).join('; '));
  process.exit(failed.length ? 1 : 0);
};

main().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
