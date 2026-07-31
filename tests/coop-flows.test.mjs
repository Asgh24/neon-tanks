/**
 * Second e2e pass: the two co-op flows that need scripted world state —
 * the relic gate (both players must pick before the depth advances) and
 * down/revive.
 *
 * Run with:  node tests/coop-flows.test.mjs      (needs `npm run dev` running)
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
  const errors = { host: [], guest: [] };

  const mk = async (who, name) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors[who].push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors[who].push(m.text()); });
    await page.addInitScript((n) => {
      localStorage.setItem('neon_tanks_profile_v1', JSON.stringify({ id: 'p' + n.toLowerCase(), name: n }));
    }, name);
    return { ctx, page };
  };

  const host = await mk('host', 'HOSTX');
  const guest = await mk('guest', 'GUEST');

  await host.page.goto(BASE, { waitUntil: 'load' });
  await until(host.page, () => typeof Net !== 'undefined');
  await host.page.evaluate(() => Net.createRoom(false));
  const code = await until(host.page, () => (Net.status === 'online' ? Net.code : null));
  await guest.page.goto(`${BASE}/?room=${code}`, { waitUntil: 'load' });
  await until(guest.page, () => Net.status === 'online' && Net.members.length === 2);
  await host.page.click('#rogueBtn');
  await until(host.page, () => Game.state === 'battle');
  await until(guest.page, () => Game.state === 'battle');
  ok('co-op run started', true, 'room ' + code);

  // The guest joins somebody else's run, so its own leftover state must be gone.
  const guestFresh = await guest.page.evaluate(() => ({
    mods: player.modules.length,
    alias: Rogue.modules === player.modules,
    kills: Rogue.runStats.kills,
    scoreMult: player.scoreMult,
    inRun: Net._inRun,
  }));
  ok('guest starts the shared run from a clean slate',
     guestFresh.mods === 0 && guestFresh.kills === 0 && guestFresh.scoreMult === 1 && guestFresh.inRun,
     JSON.stringify(guestFresh));
  ok('guest module tray aliases its own tank', guestFresh.alias);

  // ------------------------------------------------------------- relic gate
  // Clear the depth by removing every enemy on the host side.
  await host.page.evaluate(() => {
    enemies.length = 0;
    drones.length = 0;
    Game.spawnQueue = [];
    Game.enemiesRemaining = 0;
  });
  const hostRelic = await until(host.page, () => Game.state === 'relicchoice');
  const guestRelic = await until(guest.page, () => Game.state === 'relicchoice');
  ok('host opens the relic screen on depth clear', !!hostRelic);
  ok('guest is shown the relic screen too', !!guestRelic);

  const cards = await guest.page.evaluate(() => document.querySelectorAll('#relicRow .relic-card').length);
  ok('guest gets its own relic cards', cards === 3, cards + ' cards');

  // Host picks first: the depth must NOT advance while the guest is undecided.
  const depthBefore = await host.page.evaluate(() => Rogue.depth);
  await host.page.evaluate(() => document.querySelector('#relicRow .relic-card').click());
  await sleep(2500);
  const heldDepth = await host.page.evaluate(() => ({ d: Rogue.depth, st: Game.state, waiting: !!Net._picks }));
  ok('depth is held while a teammate has not picked',
     heldDepth.d === depthBefore && heldDepth.st === 'relicchoice' && heldDepth.waiting,
     `depth=${heldDepth.d} state=${heldDepth.st}`);
  await guest.page.screenshot({ path: SHOTS + '/5-relic-guest.png' });

  // Guest picks: now everyone advances together.
  await guest.page.evaluate(() => document.querySelector('#relicRow .relic-card').click());
  const advanced = await until(host.page, () => (Rogue.depth === 2 && Game.state === 'battle' ? true : null), 8000);
  ok('depth advances once everyone picked', !!advanced);
  const guestAdvanced = await until(guest.page, () => (Rogue.depth === 2 && Game.state === 'battle' ? true : null), 8000);
  ok('guest follows into the next depth', !!guestAdvanced);

  const mods = await Promise.all([
    host.page.evaluate(() => ({ mine: player.modules.length, peer: players.find(t => !t.isLocal).modules.length })),
    guest.page.evaluate(() => ({ mine: player.modules.length, tray: document.querySelectorAll('#moduleTray .mod-chip').length })),
  ]);
  ok('each tank keeps its own relic list', mods[0].mine >= 1 && mods[0].peer >= 1,
     `host=${mods[0].mine} peerOnHost=${mods[0].peer}`);
  ok('guest sees its relic in its own tray', mods[1].mine >= 1 && mods[1].tray >= 1,
     `mods=${mods[1].mine} chips=${mods[1].tray}`);

  // --------------------------------------------------------------- down/revive
  // Park the two tanks apart, then kill the guest's tank on the host.
  await host.page.evaluate(() => {
    const me = player, peer = players.find(t => !t.isLocal);
    me.x = 400; me.y = 450; peer.x = 1100; peer.y = 450;
    peer.invuln = 0; peer.lives = 1;
    damageTank(peer, peer.hp + 50, 'bullet');
  });
  const downedOnHost = await until(host.page, () => {
    const p = players.find(t => !t.isLocal);
    return p && p.downed ? true : null;
  }, 6000);
  ok('teammate goes down instead of ending the run', !!downedOnHost);
  const downedOnGuest = await until(guest.page, () => (player.downed ? true : null), 6000);
  ok('guest learns it is downed', !!downedOnGuest);
  const runStillLive = await host.page.evaluate(() => Game.state);
  ok('run continues while one player is alive', runStillLive === 'battle', runStillLive);
  await host.page.screenshot({ path: SHOTS + '/6-downed-host.png' });

  // Walk the host's tank onto the wreck and hold there through the revive timer.
  await host.page.evaluate(() => {
    const peer = players.find(t => !t.isLocal);
    player.x = peer.x + 20; player.y = peer.y;
    player.invuln = 99;                   // don't die to ambient fire mid-test
  });
  const revived = await until(host.page, () => {
    const peer = players.find(t => !t.isLocal);
    // Keep standing next to them while the timer runs.
    if (peer) { player.x = peer.x + 20; player.y = peer.y; player.invuln = 99; }
    return peer && !peer.downed && peer.alive ? Math.round(peer.hp) : null;
  }, 12000);
  ok('standing next to a downed teammate revives them', !!revived, revived ? revived + ' hp' : 'not revived');
  const revivedOnGuest = await until(guest.page, () => (!player.downed && player.alive ? true : null), 6000);
  ok('guest sees itself revived', !!revivedOnGuest);
  await host.page.screenshot({ path: SHOTS + '/7-revived-host.png' });

  // ------------------------------------------------------------------ run end
  // Award some aether first so the "did everyone bank it" check is meaningful.
  await host.page.evaluate(() => { Rogue.aetherThisRun += 7; });
  const aetherBefore = await guest.page.evaluate(() => Meta.aether);
  const hostAetherBefore = await host.page.evaluate(() => Meta.aether);
  await host.page.evaluate(() => {
    for (const t of players) { t.invuln = 0; t.lives = 1; damageTank(t, t.hp + 100, 'bullet'); }
  });
  const hostEnd = await until(host.page, () => (Game.state === 'roguedeath' ? true : null), 8000);
  ok('run ends when the whole squad is down', !!hostEnd);
  const guestEnd = await until(guest.page, () => (Game.state === 'roguedeath' ? true : null), 8000);
  ok('guest gets the run-end screen', !!guestEnd);
  await sleep(700);
  const aetherAfter = await guest.page.evaluate(() => ({
    a: Meta.aether, shown: document.getElementById('rsAether').textContent, inRun: Net._inRun,
  }));
  const hostAfter = await host.page.evaluate(() => Meta.aether);
  ok('guest banks the run aether on its own device', aetherAfter.a > aetherBefore,
     `${aetherBefore} -> ${aetherAfter.a} (shown ${aetherAfter.shown})`);
  ok('host banks it too', hostAfter > hostAetherBefore, `${hostAetherBefore} -> ${hostAfter}`);
  ok('guest clears its in-run flag at the end', aetherAfter.inRun === false);
  await guest.page.screenshot({ path: SHOTS + '/8-runend-guest.png' });

  ok('no runtime errors on the host', errors.host.length === 0, errors.host.slice(0, 2).join(' | ') || 'clean');
  ok('no runtime errors on the guest', errors.guest.length === 0, errors.guest.slice(0, 2).join(' | ') || 'clean');

  await browser.close();
  const failed = results.filter(r => !r.pass);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  if (failed.length) console.log('failed: ' + failed.map(f => f.name).join('; '));
  process.exit(failed.length ? 1 : 0);
};

main().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
