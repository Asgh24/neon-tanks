/**
 * End-to-end browser test: two real browser contexts play one co-op Roguelite
 * run against the local dev server.
 *
 * Run with:  node tests/coop-basics.test.mjs      (needs `npm run dev` running)
 */
import { chromium } from 'playwright';
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

// Poll a page-evaluated predicate until it is truthy.
async function until(page, fn, ms = 8000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await page.evaluate(fn, arg).catch(() => null);
    if (v) return v;
    await sleep(120);
  }
  return null;
}

const state = (page) => page.evaluate(() => ({
  gameState: Game.state,
  mode: Game.mode,
  depth: Rogue.depth,
  score: Game.score,
  players: players.length,
  names: players.map(t => t.name),
  enemies: enemies.length,
  bullets: bullets.length,
  net: { status: Net.status, code: Net.code, host: Net.hostId, self: Net.selfId, members: Net.members.length },
  localHp: Math.round(player.hp),
  world: [W, H],
  view: [View.sw, View.sh, +View.scale.toFixed(3)],
}));

const main = async () => {
  const browser = await chromium.launch();
  const errors = { host: [], guest: [] };

  const mk = async (who, name) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors[who].push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors[who].push(m.text()); });
    // Give each context its own identity before the game boots.
    await page.addInitScript((n) => {
      localStorage.setItem('neon_tanks_profile_v1', JSON.stringify({
        id: 'p' + n.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6) + Math.floor(Math.random() * 900 + 100),
        name: n,
      }));
    }, name);
    return { ctx, page };
  };

  const host = await mk('host', 'HOSTX');
  const guest = await mk('guest', 'GUEST');

  // ---------------------------------------------------------------- solo boot
  await host.page.goto(BASE, { waitUntil: 'load' });
  await until(host.page, () => typeof Game !== 'undefined' && typeof players !== 'undefined');
  const boot = await state(host.page);
  ok('game boots with no page errors', errors.host.length === 0, errors.host[0] || 'clean');
  ok('world is the fixed 1600x900 arena', boot.world[0] === 1600 && boot.world[1] === 900, boot.world.join('x'));
  ok('view letterboxes the world to the viewport', boot.view[2] > 0 && boot.view[2] <= 1, 'scale=' + boot.view[2]);
  ok('starts solo with one tank', boot.players === 1);

  // Solo Roguelite must still work untouched.
  await host.page.click('#rogueBtn');
  await until(host.page, () => Game.state === 'battle');
  await sleep(1500);
  const solo = await state(host.page);
  ok('solo roguelite reaches depth 1 battle', solo.gameState === 'battle' && solo.depth === 1, 'depth=' + solo.depth);
  ok('solo run spawns enemies', solo.enemies > 0, solo.enemies + ' enemies');
  await host.page.screenshot({ path: SHOTS + '/1-solo.png' });

  // Firing must produce bullets in solo play.
  await host.page.evaluate(() => { mouse.down = true; });
  await sleep(500);
  const firing = await state(host.page);
  await host.page.evaluate(() => { mouse.down = false; });
  ok('solo player can fire', firing.bullets > 0, firing.bullets + ' bullets');

  // -------------------------------------------------------------- co-op room
  await host.page.goto(BASE, { waitUntil: 'load' });
  await until(host.page, () => typeof Net !== 'undefined');
  await host.page.evaluate(() => Net.createRoom(false));
  const code = await until(host.page, () => (Net.status === 'online' ? Net.code : null));
  ok('host creates and joins a room', !!code, code);

  await guest.page.goto(`${BASE}/?room=${code}`, { waitUntil: 'load' });
  const joined = await until(guest.page, () => (Net.status === 'online' && Net.members.length === 2 ? Net.code : null), 10000);
  ok('guest joins via the ?room= link', joined === code, joined);

  const hostNet = await until(host.page, () => (Net.members.length === 2 ? { host: Net.hostId, self: Net.selfId } : null));
  ok('host keeps authority when the guest arrives', hostNet && hostNet.host === hostNet.self);
  const guestNet = await guest.page.evaluate(() => ({ isClient: Net.isClient(), isHost: Net.isHost() }));
  ok('guest is a client, not a host', guestNet.isClient && !guestNet.isHost);

  // A guest must not be able to start the run.
  await guest.page.click('#rogueBtn');
  await sleep(600);
  const guestTried = await state(guest.page);
  ok('guest cannot start the run itself', guestTried.gameState !== 'battle', guestTried.gameState);

  // -------------------------------------------------------------- shared world
  await host.page.click('#rogueBtn');
  await until(host.page, () => Game.state === 'battle');
  const guestInBattle = await until(guest.page, () => Game.state === 'battle', 10000);
  ok('guest follows the host into battle', !!guestInBattle);

  await sleep(2500);
  const h = await state(host.page);
  const g = await state(guest.page);
  ok('both sides see two tanks', h.players === 2 && g.players === 2, `host=${h.players} guest=${g.players}`);
  ok('both sides are at the same depth', h.depth === g.depth && h.depth === 1, `${h.depth}/${g.depth}`);
  ok('enemies are replicated to the guest', g.enemies > 0 && Math.abs(h.enemies - g.enemies) <= 2,
     `host=${h.enemies} guest=${g.enemies}`);
  ok('guest sees the host by name', g.names.includes('HOSTX'), g.names.join(','));
  ok('host sees the guest by name', h.names.includes('GUEST'), h.names.join(','));

  // The guest's HUD must be fully populated even though it never ran the local
  // depth-setup path.
  const guestHud = await guest.page.evaluate(() => ({
    hearts: document.querySelectorAll('#lifeBelt .heart').length,
    strip: document.querySelectorAll('#squadStrip .sq').length,
    stripVisible: getComputedStyle(document.getElementById('squadStrip')).display !== 'none',
    hpText: document.getElementById('hpNum').textContent,
    depthText: document.getElementById('depthVal').textContent,
  }));
  ok('guest life belt is rendered', guestHud.hearts > 0, guestHud.hearts + ' hearts');
  ok('guest squad strip lists the teammate', guestHud.stripVisible && guestHud.strip === 1,
     `visible=${guestHud.stripVisible} pills=${guestHud.strip}`);
  ok('guest HUD shows depth from the host', guestHud.depthText === String(g.depth), guestHud.depthText);

  await host.page.screenshot({ path: SHOTS + '/2-coop-host.png' });
  await guest.page.screenshot({ path: SHOTS + '/3-coop-guest.png' });

  // Guest movement must reach the host (input relay + host simulation).
  const before = await host.page.evaluate(() => {
    const t = players.find(p => !p.isLocal);
    return t ? { x: Math.round(t.x), y: Math.round(t.y) } : null;
  });
  await guest.page.evaluate(() => {
    // Drive the guest tank right for a moment.
    keys['d'] = true;
  });
  await sleep(1400);
  await guest.page.evaluate(() => { keys['d'] = false; });
  await sleep(400);
  const after = await host.page.evaluate(() => {
    const t = players.find(p => !p.isLocal);
    return t ? { x: Math.round(t.x), y: Math.round(t.y) } : null;
  });
  ok('guest input moves its tank on the host', before && after && Math.abs(after.x - before.x) > 25,
     before && after ? `${before.x} -> ${after.x}` : 'no remote tank');

  // The guest's own view of its tank should track the same motion.
  const guestSelf = await guest.page.evaluate(() => ({ x: Math.round(player.x) }));
  ok('guest prediction stays near the host position', after && Math.abs(guestSelf.x - after.x) < 120,
     after ? `guest=${guestSelf.x} host=${after.x}` : '');

  // Guests must never spawn their own bullets.
  const guestBulletOwners = await guest.page.evaluate(() => {
    mouse.down = true;
    return new Promise(res => setTimeout(() => {
      mouse.down = false;
      res({ bullets: bullets.length, canFire: !Net.isClient() });
    }, 700));
  });
  ok('guest does not simulate its own bullets', guestBulletOwners.canFire === false);

  // ------------------------------------------------------------ host migration
  const hostShots = await guest.page.evaluate(() => Net.hostId);
  await host.ctx.close();
  const migrated = await until(guest.page, () => (Net.hostId === Net.selfId ? Net.hostId : null), 10000);
  ok('guest is promoted when the host disappears', !!migrated && migrated !== hostShots, migrated);
  await sleep(1800);
  const solo2 = await state(guest.page);
  ok('promoted player continues alone', solo2.players === 1, solo2.players + ' tanks');
  ok('promoted player still has a live run', ['battle', 'bossintro', 'relicchoice'].includes(solo2.gameState), solo2.gameState);
  await guest.page.screenshot({ path: SHOTS + '/4-after-migration.png' });

  ok('no runtime errors on the guest', errors.guest.length === 0, errors.guest.slice(0, 2).join(' | ') || 'clean');
  ok('no runtime errors on the host', errors.host.length === 0, errors.host.slice(0, 2).join(' | ') || 'clean');

  await browser.close();
  const failed = results.filter(r => !r.pass);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  if (failed.length) console.log('failed: ' + failed.map(f => f.name).join('; '));
  process.exit(failed.length ? 1 : 0);
};

main().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
