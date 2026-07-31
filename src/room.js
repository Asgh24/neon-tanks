/**
 * NEON TANKS — room server (Durable Objects)
 * ---------------------------------------------------------------------------
 * Two classes:
 *   GameRoom    one instance per room code. Pure authorized relay: it never
 *               simulates the game. One member is the host; the host's browser
 *               owns the world and broadcasts snapshots, everyone else sends
 *               input. Hibernation-safe — membership is always re-derived from
 *               ctx.getWebSockets() + socket attachments, never from a Map that
 *               would vanish when the object hibernates.
 *   Matchmaker  a single instance ("__match") that remembers which public rooms
 *               have a free seat, so /api/quickplay can drop a player into one.
 *
 * Wire protocol (JSON strings, both directions):
 *   client -> server   {t:'in', ...}          input        -> relayed to host only
 *                      {t:'pick'|'ready'|'hey', ...}       -> relayed to host only
 *                      {t:'S'|'E', ...}       host only    -> relayed to everyone else
 *                      {t:'name', name}       rename       -> roster broadcast
 *                      {t:'bye'}              leave
 *   server -> client   {t:'room', code, you, host, pub, members:[{id,name,host}]}
 *                      {t:'host', id}         host changed (id === you => you host now)
 *                      {t:'peer', join|left, id, name}
 *                      {t:'err', msg}
 *                      ...plus every relayed payload above, with `from` stamped on.
 *   keepalive          client sends the string "p", the runtime answers "o"
 *                      without ever waking the object (auto-response).
 */

import { DurableObject } from 'cloudflare:workers';

export const MAX_MEMBERS = 4;
const MAX_MSG_BYTES = 48 * 1024;   // a full snapshot is ~2KB; 48KB is generous
const MSG_BUDGET = 120;            // messages per second, per socket
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;
const GC_EVERY_MS = 60 * 1000;
const STALE_ROOM_MS = 90 * 1000;   // matchmaker forgets rooms that stop beating

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1

export function randomCode(len = 5) {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let out = '';
  for (const b of buf) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

export function normalizeCode(raw) {
  const code = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return code.length >= 4 ? code : '';
}

function cleanName(raw, fallback = 'فرمانده') {
  const name = String(raw == null ? '' : raw).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return name || fallback;
}

function cleanId(raw) {
  return String(raw || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
}

/* ============================== GameRoom ============================== */
export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Answered by the runtime while the object sleeps — keeps proxies from
    // dropping an idle socket without costing a single wake-up.
    try { ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('p', 'o')); } catch (e) {}
    this.rate = new WeakMap();   // ws -> {n, until}  (in-memory is fine: best-effort)
  }

  /* ------------------------------- routing ------------------------------- */
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/rpc/claim') return this.claim(url);
    if (url.pathname === '/rpc/info') return Response.json(await this.info());
    if (url.pathname === '/ws') return this.accept(req, url);
    return new Response('not found', { status: 404 });
  }

  async meta() {
    return (await this.ctx.storage.get('meta')) || null;
  }

  async info() {
    const meta = await this.meta();
    const members = this.members();
    return {
      exists: !!meta,
      code: meta ? meta.code : null,
      pub: !!(meta && meta.pub),
      count: members.length,
      phase: (meta && meta.phase) || 'lobby',
      members: members.map(m => ({ id: m.id, name: m.name, host: !!m.host })),
    };
  }

  // Reserve a code so that joining a mistyped code fails instead of silently
  // creating a ghost room. Returns 409 when the code is already live.
  async claim(url) {
    const code = normalizeCode(url.searchParams.get('room'));
    if (!code) return new Response('bad code', { status: 400 });
    const meta = await this.meta();
    if (meta && (this.members().length > 0 || Date.now() - meta.createdAt < EMPTY_ROOM_TTL_MS)) {
      return new Response('taken', { status: 409 });
    }
    await this.ctx.storage.put('meta', {
      code,
      pub: url.searchParams.get('pub') === '1',
      createdAt: Date.now(),
      phase: 'lobby',
    });
    await this.scheduleGc();
    return Response.json({ ok: true, code });
  }

  async accept(req, url) {
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const code = normalizeCode(url.searchParams.get('room'));
    const id = cleanId(url.searchParams.get('id'));
    const name = cleanName(url.searchParams.get('name'));
    if (!code || !id) return new Response('bad request', { status: 400 });

    let meta = await this.meta();
    if (!meta) {
      if (url.searchParams.get('create') !== '1') {
        return new Response('no such room', { status: 404 });
      }
      meta = { code, pub: url.searchParams.get('pub') === '1', createdAt: Date.now(), phase: 'lobby' };
      await this.ctx.storage.put('meta', meta);
    }

    const existing = this.members();
    // A reconnect (same identity) replaces the stale socket instead of taking a
    // second seat — otherwise a flaky network fills the room with zombies.
    const stale = existing.filter(m => m.id === id);
    if (existing.length - stale.length >= MAX_MEMBERS) {
      return new Response('room full', { status: 403 });
    }
    for (const m of stale) {
      try { m.ws.close(4001, 'replaced'); } catch (e) {}
    }

    const live = existing.filter(m => m.id !== id);
    const host = !live.some(m => m.host);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // Attachment survives hibernation, so membership never lives in RAM only.
    server.serializeAttachment({ id, name, host, joinedAt: Date.now() });
    this.ctx.acceptWebSocket(server);

    this.send(server, { t: 'room', ...this.roster(meta), you: id });
    this.broadcast({ t: 'peer', join: true, id, name }, id);
    this.pushRoster(meta);
    await this.scheduleGc();
    this.beat(meta).catch(() => {});
    return new Response(null, { status: 101, webSocket: client });
  }

  /* ------------------------------ membership ----------------------------- */
  // `skipWs` is the socket currently being torn down: during webSocketClose it
  // is still listed by getWebSockets(), so every roster/broadcast built from a
  // close handler must exclude it explicitly or the departed player lingers.
  members(skipWs) {
    const out = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (skipWs && ws === skipWs) continue;
      if (ws.readyState === WebSocket.CLOSED) continue;
      let a = null;
      try { a = ws.deserializeAttachment(); } catch (e) { a = null; }
      if (!a || !a.id) continue;
      out.push({ ws, id: a.id, name: a.name, host: !!a.host, joinedAt: a.joinedAt || 0 });
    }
    out.sort((a, b) => a.joinedAt - b.joinedAt);
    return out;
  }

  hostMember() {
    return this.members().find(x => x.host) || null;
  }

  roster(meta, skipWs) {
    const members = this.members(skipWs);
    const host = members.find(m => m.host);
    return {
      code: (meta && meta.code) || null,
      pub: !!(meta && meta.pub),
      host: host ? host.id : null,
      members: members.map(m => ({ id: m.id, name: m.name, host: !!m.host })),
    };
  }

  async pushRoster(meta, skipWs) {
    const m = meta || (await this.meta());
    const payload = this.roster(m, skipWs);
    for (const mem of this.members(skipWs)) this.send(mem.ws, { t: 'room', ...payload, you: mem.id });
  }

  send(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch (e) {}
  }

  broadcast(msg, exceptId, skipWs) {
    const raw = JSON.stringify(msg);
    for (const m of this.members(skipWs)) {
      if (exceptId && m.id === exceptId) continue;
      try { m.ws.send(raw); } catch (e) {}
    }
  }

  /* -------------------------------- relay -------------------------------- */
  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string') return;                 // no binary channel (yet)
    if (raw.length > MAX_MSG_BYTES) { this.send(ws, { t: 'err', msg: 'پیام بیش از حد بزرگ' }); return; }
    if (raw === 'p') { try { ws.send('o'); } catch (e) {} return; }   // manual pong fallback
    if (!this.allow(ws)) return;

    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;

    let self = null;
    try { self = ws.deserializeAttachment(); } catch (e) {}
    if (!self || !self.id) return;

    switch (msg.t) {
      // World state and one-shot effects: host -> everyone else.
      case 'S':
      case 'E': {
        if (!self.host) return;
        msg.from = self.id;
        this.broadcast(msg, self.id);
        if (msg.t === 'S' && msg.flow) this.notePhase(msg.flow).catch(() => {});
        break;
      }
      // Input and lobby chatter: client -> host.
      case 'in':
      case 'pick':
      case 'ready':
      case 'hey': {
        const host = this.hostMember();
        if (!host) { this.send(ws, { t: 'err', msg: 'میزبانی وجود ندارد' }); return; }
        msg.from = self.id;
        if (host.id === self.id) { this.broadcast(msg, self.id); break; }  // host echo for 'hey'
        this.send(host.ws, msg);
        break;
      }
      case 'name': {
        const name = cleanName(msg.name, self.name);
        ws.serializeAttachment({ ...self, name });
        await this.pushRoster();
        break;
      }
      case 'bye':
        try { ws.close(1000, 'bye'); } catch (e) {}
        await this.departed(self, ws);
        break;
    }
  }

  allow(ws) {
    const now = Date.now();
    let r = this.rate.get(ws);
    if (!r || now > r.until) { r = { n: 0, until: now + 1000 }; this.rate.set(ws, r); }
    r.n++;
    if (r.n > MSG_BUDGET) {
      if (r.n === MSG_BUDGET + 1) this.send(ws, { t: 'err', msg: 'نرخ ارسال بیش از حد' });
      return false;
    }
    return true;
  }

  async webSocketClose(ws) { await this.onGone(ws); }
  async webSocketError(ws) { await this.onGone(ws); }

  async onGone(ws) {
    let self = null;
    try { self = ws.deserializeAttachment(); } catch (e) {}
    if (!self || !self.id) return;
    await this.departed(self, ws);
  }

  async departed(self, ws) {
    const meta = await this.meta();
    const left = this.members(ws).filter(m => m.id !== self.id);
    this.broadcast({ t: 'peer', join: false, id: self.id, name: self.name }, self.id, ws);

    // Host migration: promote the longest-present survivor. The world state is
    // not transferred — the new host restarts the current depth (the client
    // tells the players so). Keeping it simple beats a fragile state handoff.
    if (self.host && left.length > 0 && !left.some(m => m.host)) {
      const next = left[0];
      try {
        const a = next.ws.deserializeAttachment() || {};
        next.ws.serializeAttachment({ ...a, host: true });
        next.host = true;
      } catch (e) {}
      this.broadcast({ t: 'host', id: next.id }, null, ws);
    }
    await this.pushRoster(meta, ws);
    await this.beat(meta, ws);
  }

  /* --------------------------- matchmaker beat --------------------------- */
  async notePhase(flow) {
    const meta = await this.meta();
    if (!meta) return;
    const phase = String(flow.phase || flow.state || 'lobby').slice(0, 16);
    const depth = flow.depth | 0;
    if (meta.phase === phase && meta.depth === depth) return;
    meta.phase = phase; meta.depth = depth;
    await this.ctx.storage.put('meta', meta);
    await this.beat(meta);
  }

  async beat(meta, skipWs) {
    const m = meta || (await this.meta());
    if (!m || !m.pub) return;
    const count = this.members(skipWs).length;
    try {
      const stub = this.env.MATCH.get(this.env.MATCH.idFromName('__match'));
      await stub.fetch('https://match/beat', {
        method: 'POST',
        body: JSON.stringify({
          code: m.code,
          count,
          phase: m.phase || 'lobby',
          depth: m.depth | 0,
          open: count > 0 && count < MAX_MEMBERS,
        }),
      });
    } catch (e) { /* matchmaking is best-effort */ }
  }

  /* -------------------------------- room GC ------------------------------- */
  async scheduleGc() {
    const at = await this.ctx.storage.getAlarm();
    if (at == null) await this.ctx.storage.setAlarm(Date.now() + GC_EVERY_MS);
  }

  async alarm() {
    const meta = await this.meta();
    const count = this.members().length;
    if (count > 0) {
      await this.ctx.storage.setAlarm(Date.now() + GC_EVERY_MS);
      await this.beat(meta);
      return;
    }
    if (meta && Date.now() - meta.createdAt < EMPTY_ROOM_TTL_MS) {
      await this.ctx.storage.setAlarm(Date.now() + GC_EVERY_MS);
      return;
    }
    if (meta) await this.beat({ ...meta, pub: meta.pub });   // final beat: count 0 => dropped
    await this.ctx.storage.deleteAll();
  }
}

/* ============================== Matchmaker ============================== */
/** Single instance. Remembers public rooms with a free seat so quick play can
 *  land two strangers in the same room without a central database. */
export class Matchmaker extends DurableObject {
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/beat') {
      const body = await req.json().catch(() => null);
      if (!body || !body.code) return new Response('bad', { status: 400 });
      const rooms = await this.rooms();
      const code = normalizeCode(body.code);
      if (!code) return new Response('bad', { status: 400 });
      if (!body.open || (body.count | 0) <= 0) rooms.delete(code);
      else rooms.set(code, { count: body.count | 0, phase: body.phase || 'lobby', depth: body.depth | 0, at: Date.now() });
      await this.save(rooms);
      return Response.json({ ok: true, tracked: rooms.size });
    }
    if (url.pathname === '/find') {
      const rooms = this.prune(await this.rooms());
      // Prefer a room still in the lobby (nobody mid-run), then the fullest one
      // so players cluster instead of scattering one-per-room.
      const best = [...rooms.entries()]
        .filter(([, r]) => r.count > 0 && r.count < MAX_MEMBERS)
        .sort((a, b) => (Number(b[1].phase === 'lobby') - Number(a[1].phase === 'lobby')) || (b[1].count - a[1].count))[0];
      await this.save(rooms);
      return Response.json({ code: best ? best[0] : null });
    }
    if (url.pathname === '/list') {
      const rooms = this.prune(await this.rooms());
      return Response.json({ rooms: [...rooms.entries()].map(([code, r]) => ({ code, ...r })) });
    }
    return new Response('not found', { status: 404 });
  }

  async rooms() {
    const raw = (await this.ctx.storage.get('rooms')) || [];
    return this.prune(new Map(raw));
  }

  prune(map) {
    const now = Date.now();
    for (const [code, r] of map) if (now - (r.at || 0) > STALE_ROOM_MS) map.delete(code);
    // Hard cap so a flood of rooms can't grow the record without bound.
    if (map.size > 200) {
      const keep = [...map.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, 200);
      map = new Map(keep);
    }
    return map;
  }

  async save(map) {
    await this.ctx.storage.put('rooms', [...map.entries()]);
  }
}
