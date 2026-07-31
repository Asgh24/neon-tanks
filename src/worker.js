/**
 * NEON TANKS — Worker entry point.
 *
 * One Worker serves both halves of the game:
 *   • Static assets (public/index.html and friends) via the [assets] binding —
 *     handled by the runtime before this fetch handler ever runs.
 *   • The multiplayer API and WebSocket endpoint below, on the same origin, so
 *     the client can derive wss://<same-host>/ws with zero configuration.
 *
 * Endpoints:
 *   GET  /ws?room=CODE&id=..&name=..[&create=1][&pub=1]   join a room socket
 *   POST /api/room[?pub=1]                                reserve a fresh code
 *   GET  /api/quickplay                                   open public room or new one
 *   GET  /api/room/CODE                                   room info (debug/lobby)
 *   GET  /api/health
 */

import { GameRoom, Matchmaker, randomCode, normalizeCode, MAX_MEMBERS } from './room.js';

export { GameRoom, Matchmaker };

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function roomStub(env, code) {
  return env.ROOMS.get(env.ROOMS.idFromName('room:' + code));
}

// Reserve an unused code. The room DO refuses (409) if that code is already
// live, so a handful of attempts is plenty against a 33M-code space.
async function reserveCode(env, pub) {
  for (let i = 0; i < 6; i++) {
    const code = randomCode(5);
    const res = await roomStub(env, code).fetch(
      `https://room/rpc/claim?room=${code}&pub=${pub ? '1' : '0'}`
    );
    if (res.ok) return code;
  }
  return null;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === '/ws') {
      const code = normalizeCode(url.searchParams.get('room'));
      if (!code) return new Response('bad room code', { status: 400 });
      return roomStub(env, code).fetch(req);
    }

    if (url.pathname === '/api/room' && req.method === 'POST') {
      const code = await reserveCode(env, url.searchParams.get('pub') === '1');
      if (!code) return json({ error: 'could not allocate a room' }, 503);
      return json({ code, max: MAX_MEMBERS });
    }

    if (url.pathname === '/api/quickplay') {
      let code = null;
      try {
        const match = env.MATCH.get(env.MATCH.idFromName('__match'));
        const found = await match.fetch('https://match/find').then(r => r.json());
        code = found && found.code ? normalizeCode(found.code) : null;
      } catch (e) { code = null; }

      if (code) {
        // Confirm the room still has a free seat before sending anyone there.
        const info = await roomStub(env, code).fetch('https://room/rpc/info').then(r => r.json()).catch(() => null);
        if (!info || !info.exists || info.count >= MAX_MEMBERS) code = null;
      }
      if (!code) {
        code = await reserveCode(env, true);
        if (!code) return json({ error: 'could not allocate a room' }, 503);
        return json({ code, created: true, max: MAX_MEMBERS });
      }
      return json({ code, created: false, max: MAX_MEMBERS });
    }

    const roomInfo = url.pathname.match(/^\/api\/room\/([A-Za-z0-9]{4,8})$/);
    if (roomInfo) {
      const code = normalizeCode(roomInfo[1]);
      if (!code) return json({ error: 'bad code' }, 400);
      const info = await roomStub(env, code).fetch('https://room/rpc/info').then(r => r.json()).catch(() => null);
      if (!info) return json({ error: 'unavailable' }, 503);
      return json(info, info.exists ? 200 : 404);
    }

    if (url.pathname === '/api/health') return json({ ok: true, ts: Date.now() });

    return new Response('not found', { status: 404 });
  },
};
