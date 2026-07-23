/**
 * NEON TANKS — Multiplayer squad server (Cloudflare Worker + Durable Objects)
 * ---------------------------------------------------------------------------
 * Free-tier friendly: no VPS needed. Each squad is one Durable Object room
 * using the WebSocket Hibernation API, so idle squads cost (almost) nothing.
 *
 * Deploy:
 *   1. npm install -g wrangler
 *   2. wrangler secret put BOT_TOKEN        (your Telegram bot token)
 *   3. wrangler deploy
 *   4. In tank.html set:
 *        <meta name="mp-server" content="wss://<your-worker>.workers.dev/ws">
 *        <meta name="mp-bot"    content="YourBotUsername">
 *        <meta name="mp-app"    content="play">   (Mini App short name)
 *
 * Protocol (JSON messages, mirrors the Net module in tank.html):
 *   c->s {t:'hello', initData, name, accountId}
 *   c->s {t:'squad.create'} | {t:'squad.join', code} | {t:'squad.leave'}
 *   c->s {t:'state', p:{...}} | {t:'event', kind, data}
 *   s->c {t:'squad', code, members} | {t:'snap', players} | {t:'event', from, kind, data}
 *   s->c {t:'peer.joined'|'peer.left'} | {t:'error', msg}
 */

const MAX_SQUAD = 4;
const SNAP_MS = 100;            // broadcast rate (10 Hz)
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1

/* ------------------------- Telegram initData check ------------------------- */
async function validateInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const pairs = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
    const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');
    const enc = new TextEncoder();
    // secret = HMAC_SHA256(bot_token, key="WebAppData")
    const seedKey = await crypto.subtle.importKey('raw', enc.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const secret = await crypto.subtle.sign('HMAC', seedKey, enc.encode(botToken));
    const dataKey = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', dataKey, enc.encode(dataCheckString));
    const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
    if (hex !== hash) return null;
    // Reject stale auth (24h)
    const authDate = Number(params.get('auth_date') || 0);
    if (Date.now() / 1000 - authDate > 86400) return null;
    return JSON.parse(params.get('user') || 'null');
  } catch (e) {
    return null;
  }
}

function randomCode(len = 5) {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let out = '';
  for (const b of buf) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

/* ------------------------------ Worker entry ------------------------------ */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected websocket', { status: 426 });
      }
      // The lobby DO owns hello/create/join; it then forwards the socket's
      // squad membership through storage. Simplest robust topology: a single
      // "lobby" object routes each connection to its squad room object.
      const id = env.SQUAD_ROOMS.idFromName('lobby');
      return env.SQUAD_ROOMS.get(id).fetch(req);
    }
    if (url.pathname === '/health') return new Response('ok');
    return new Response('NEON TANKS multiplayer server', { status: 200 });
  },
};

/* ------------------------- Squad room Durable Object ------------------------
 * One DO instance ("lobby") holds all live squads in memory. For the expected
 * scale of a hobby Mini App (small squads, short sessions) this is simpler
 * and cheaper than one DO per squad; it can be sharded later by routing
 * /ws?code=XXXX to idFromName(code) without protocol changes. */
export class SquadRooms {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // sockets: WebSocket -> session info (also serialized into attachments so
    // sessions survive hibernation).
    this.snapTimer = null;
  }

  squads() {
    if (!this._squads) this._squads = new Map(); // code -> { members: Map<accountId, {ws,name,leader,state}> }
    return this._squads;
  }

  async fetch(req) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ authed: false });
    return new Response(null, { status: 101, webSocket: client });
  }

  session(ws) {
    try { return ws.deserializeAttachment() || {}; } catch (e) { return {}; }
  }
  setSession(ws, s) {
    try { ws.serializeAttachment(s); } catch (e) {}
  }
  sendTo(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch (e) {}
  }
  broadcast(code, msg, exceptId) {
    const sq = this.squads().get(code);
    if (!sq) return;
    for (const [id, m] of sq.members) {
      if (id === exceptId) continue;
      this.sendTo(m.ws, msg);
    }
  }
  membersPayload(code) {
    const sq = this.squads().get(code);
    if (!sq) return [];
    return [...sq.members.entries()].map(([id, m]) => ({ id, name: m.name, leader: !!m.leader }));
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    const s = this.session(ws);

    if (msg.t === 'hello') {
      // Validate Telegram initData when possible; fall back to accountId as a
      // guest identity so the game still works in a plain browser during dev.
      const tgUser = await validateInitData(msg.initData, this.env.BOT_TOKEN);
      const id = tgUser ? ('tg' + tgUser.id) : String(msg.accountId || ('guest' + Math.random().toString(36).slice(2, 8)));
      const name = tgUser
        ? (tgUser.username ? '@' + tgUser.username : [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' '))
        : String(msg.name || 'مهمان').slice(0, 32);
      this.setSession(ws, { ...s, authed: true, verified: !!tgUser, id, name });
      ws._live = { id, name };
      return;
    }
    if (!s.authed) { this.sendTo(ws, { t: 'error', msg: 'hello first' }); return; }

    switch (msg.t) {
      case 'squad.create': {
        this.leaveCurrent(ws, s);
        let code;
        do { code = randomCode(); } while (this.squads().has(code));
        this.squads().set(code, { members: new Map([[s.id, { ws, name: s.name, leader: true, state: null }]]) });
        this.setSession(ws, { ...s, code });
        this.sendTo(ws, { t: 'squad', code, members: this.membersPayload(code) });
        this.ensureSnapLoop();
        break;
      }
      case 'squad.join': {
        const code = String(msg.code || '').toUpperCase().trim();
        const sq = this.squads().get(code);
        if (!sq) { this.sendTo(ws, { t: 'error', msg: 'اسکواد پیدا نشد' }); return; }
        if (sq.members.size >= MAX_SQUAD && !sq.members.has(s.id)) {
          this.sendTo(ws, { t: 'error', msg: 'اسکواد پر است' }); return;
        }
        this.leaveCurrent(ws, s);
        sq.members.set(s.id, { ws, name: s.name, leader: sq.members.size === 0, state: null });
        this.setSession(ws, { ...s, code });
        // Tell everyone (including the joiner) the new roster.
        for (const [, m] of sq.members) this.sendTo(m.ws, { t: 'squad', code, members: this.membersPayload(code) });
        this.broadcast(code, { t: 'peer.joined', id: s.id, name: s.name }, s.id);
        this.ensureSnapLoop();
        break;
      }
      case 'squad.leave':
        this.leaveCurrent(ws, this.session(ws));
        break;
      case 'state': {
        const sess = this.session(ws);
        const sq = sess.code && this.squads().get(sess.code);
        if (!sq) return;
        const m = sq.members.get(sess.id);
        if (m) { m.state = msg.p; m.ws = ws; }
        break;
      }
      case 'event': {
        const sess = this.session(ws);
        if (!sess.code) return;
        this.broadcast(sess.code, { t: 'event', from: sess.id, kind: String(msg.kind || ''), data: msg.data || {} }, sess.id);
        break;
      }
    }
  }

  leaveCurrent(ws, s) {
    if (!s || !s.code) return;
    const sq = this.squads().get(s.code);
    if (sq) {
      sq.members.delete(s.id);
      if (sq.members.size === 0) {
        this.squads().delete(s.code);
      } else {
        // promote a new leader if needed
        if (![...sq.members.values()].some(m => m.leader)) {
          const first = sq.members.values().next().value;
          if (first) first.leader = true;
        }
        this.broadcast(s.code, { t: 'peer.left', id: s.id });
        this.broadcast(s.code, { t: 'squad', code: s.code, members: this.membersPayload(s.code) });
      }
    }
    this.setSession(ws, { ...s, code: null });
  }

  async webSocketClose(ws) { this.leaveCurrent(ws, this.session(ws)); }
  async webSocketError(ws) { this.leaveCurrent(ws, this.session(ws)); }

  /* Broadcast position snapshots to each squad at SNAP_MS while any squad is
   * non-empty. Uses a DO alarm-free interval; when all squads empty, the loop
   * stops and the object can hibernate. */
  ensureSnapLoop() {
    if (this.snapTimer) return;
    this.snapTimer = setInterval(() => {
      const all = this.squads();
      if (all.size === 0) { clearInterval(this.snapTimer); this.snapTimer = null; return; }
      for (const [code, sq] of all) {
        const players = {};
        for (const [id, m] of sq.members) {
          if (m.state) players[id] = { ...m.state, name: m.name };
        }
        if (Object.keys(players).length === 0) continue;
        for (const [, m] of sq.members) this.sendTo(m.ws, { t: 'snap', players });
      }
    }, SNAP_MS);
  }
}
