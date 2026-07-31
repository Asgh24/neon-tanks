/**
 * Headless room-server test: two WebSocket clients in one room, exercising the
 * relay rules the game depends on (host election, input -> host only, snapshot
 * -> guests only, host migration, roster updates).
 *
 * Run against `npm run dev` with:  node tests/room-server.test.mjs
 */
const BASE = process.env.BASE || 'http://localhost:8787';
const WSB = BASE.replace(/^http/, 'ws') + '/ws';

const results = [];
const ok = (name, pass, extra) => {
  results.push({ name, pass, extra });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  -> ' + extra : ''));
};

function open(code, id, name, extra = '') {
  const ws = new WebSocket(`${WSB}?room=${code}&id=${id}&name=${encodeURIComponent(name)}${extra}`);
  ws.inbox = [];
  ws.addEventListener('message', (e) => {
    if (e.data === 'o') { ws.inbox.push({ t: 'pong' }); return; }
    try { ws.inbox.push(JSON.parse(e.data)); } catch (_) {}
  });
  return new Promise((res, rej) => {
    ws.addEventListener('open', () => res(ws));
    ws.addEventListener('error', () => rej(new Error('ws error')));
    ws.addEventListener('close', (ev) => rej(new Error('closed ' + ev.code)));
    setTimeout(() => rej(new Error('open timeout')), 5000);
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const waitFor = async (ws, pred, ms = 2500) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = ws.inbox.find(pred);
    if (hit) return hit;
    await sleep(30);
  }
  return null;
};

const main = async () => {
  // --- room creation -------------------------------------------------------
  const { code } = await fetch(BASE + '/api/room', { method: 'POST' }).then(r => r.json());
  ok('POST /api/room returns a code', /^[A-Z0-9]{5}$/.test(code), code);

  const a = await open(code, 'pAAA', 'میزبان', '&create=1');
  const roomA = await waitFor(a, m => m.t === 'room');
  ok('first member becomes host', roomA && roomA.host === 'pAAA', roomA && roomA.host);
  ok('room message carries own id', roomA && roomA.you === 'pAAA');

  const b = await open(code, 'pBBB', 'مهمان');
  const roomB = await waitFor(b, m => m.t === 'room');
  ok('second member joins, host unchanged', roomB && roomB.host === 'pAAA' && roomB.members.length === 2,
     roomB && roomB.members.map(m => m.name).join(','));
  ok('host is notified of the new peer', !!(await waitFor(a, m => m.t === 'peer' && m.join)));

  // --- relay direction -----------------------------------------------------
  a.inbox.length = 0; b.inbox.length = 0;
  b.send(JSON.stringify({ t: 'in', s: 1, mx: 1, my: 0, mg: 1, am: 0, f: 1 }));
  const inputAtHost = await waitFor(a, m => m.t === 'in');
  ok('guest input reaches the host', !!inputAtHost && inputAtHost.from === 'pBBB');

  a.inbox.length = 0; b.inbox.length = 0;
  a.send(JSON.stringify({ t: 'S', tanks: [], en: [], flow: { phase: 'battle', depth: 3 } }));
  ok('host snapshot reaches the guest', !!(await waitFor(b, m => m.t === 'S')));
  ok('host does not receive its own snapshot', !a.inbox.some(m => m.t === 'S'));

  a.inbox.length = 0; b.inbox.length = 0;
  b.send(JSON.stringify({ t: 'S', tanks: [] }));
  await sleep(300);
  ok('guest snapshots are rejected', !a.inbox.some(m => m.t === 'S'));

  // --- keepalive -----------------------------------------------------------
  b.inbox.length = 0;
  b.send('p');
  ok('ping is answered without waking the room', !!(await waitFor(b, m => m.t === 'pong')));

  // --- rename --------------------------------------------------------------
  b.inbox.length = 0;
  b.send(JSON.stringify({ t: 'name', name: 'فرمانده دو' }));
  const renamed = await waitFor(b, m => m.t === 'room' && m.members.some(x => x.name === 'فرمانده دو'));
  ok('rename is broadcast to the roster', !!renamed);

  // --- host migration ------------------------------------------------------
  b.inbox.length = 0;
  a.close(1000, 'bye');
  const hostMsg = await waitFor(b, m => m.t === 'host', 4000);
  ok('host migrates when the host disconnects', !!hostMsg && hostMsg.id === 'pBBB', hostMsg && hostMsg.id);
  const roomAfter = await waitFor(b, m => m.t === 'room' && m.members.length === 1, 3000);
  ok('roster shrinks after the host leaves', !!roomAfter);

  // --- capacity ------------------------------------------------------------
  // Only pBBB is left in this room, so three more fit and a fifth is refused.
  const extras = [];
  for (const id of ['pCCC', 'pDDD', 'pEEE', 'pFFF']) {
    try { extras.push(await open(code, id, id)); } catch (e) { extras.push(e); }
  }
  ok('room fills to 4 members, 5th is refused',
     extras.slice(0, 3).every(x => x instanceof WebSocket) && !(extras[3] instanceof WebSocket),
     extras.map(x => x instanceof WebSocket ? 'in' : 'refused').join(','));

  // --- quick play ----------------------------------------------------------
  const qp = await fetch(BASE + '/api/quickplay').then(r => r.json());
  const pubRoom = qp.code;
  const p1 = await open(pubRoom, 'qAAA', 'q1', '&create=1&pub=1');
  await waitFor(p1, m => m.t === 'room');
  await sleep(600);                                  // let the matchmaker beat land
  const qp2 = await fetch(BASE + '/api/quickplay').then(r => r.json());
  ok('quick play returns the room that has a free seat', qp2.code === pubRoom, qp2.code + ' vs ' + pubRoom);

  // --- unknown room --------------------------------------------------------
  let refused = false;
  try { await open('ZZZZZ', 'pZZZ', 'z'); } catch (e) { refused = true; }
  ok('joining a non-existent room is refused', refused);

  for (const w of [b, ...extras.filter(x => x instanceof WebSocket), p1]) {
    try { w.close(); } catch (_) {}
  }

  const failed = results.filter(r => !r.pass);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  process.exit(failed.length ? 1 : 0);
};

main().catch((e) => { console.error('TEST HARNESS ERROR', e); process.exit(2); });
