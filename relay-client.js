// Relay client: the outbound half of the Guard <-> Stream integration.
//
// When RELAY_ENABLED is set, this dials the Cha0s Stream Relay (see the
// Cha0s-Stream-Server repo), authenticates with the broadcaster's Twitch token,
// advertises the chat command list, and executes commands the relay forwards
// from Guard. Guard becomes the single chat-command front door; Stream stops
// answering `!` commands itself (RELAY_DEFER_COMMANDS) so the two bots no longer
// talk over each other.
//
// listener.js calls init() once with the handful of internals this needs.

const { WebSocket } = require('ws');

const PROTOCOL_VERSION = 1;
const DEFAULT_URL = 'wss://stream.chaosinc.xyz/agent';
const SEEN_TTL_MS = 60 * 60 * 1000;
const SEEN_MAX = 500;

let deps = null;

let ws = null;
let connected = false;
let started = false;
let attempt = 0;
let reconnectTimer = null;
let warnedNoToken = false;

// command.run is processed one at a time: the reply interceptor in
// sendChatMessage is a single module global, so overlapping runs would cross
// their replies. Queue the rest.
let running = false;
const runQueue = [];

// action id -> { result, ts }, so a resend of the same forwarded command does
// not double-queue a song.
const seen = new Map();

function log(...a) { console.log('[relay]', ...a); }

function init(d) {
  deps = d;
  reload();
}

// Called by listener.js when RELAY_ENABLED / RELAY_URL change.
function reload() {
  const want = process.env.RELAY_ENABLED === 'true';
  if (want && !started) { started = true; attempt = 0; connect(); }
  else if (!want && started) { stop(); }
  else if (want && started) {
    // URL may have changed: bounce the socket.
    if (ws) { try { ws.close(); } catch {} }
  }
}

function stop() {
  started = false;
  connected = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.close(); } catch {} ws = null; }
  broadcastStatus();
}

function connect() {
  if (!started) return;
  // The relay authenticates us with this token, so without one the socket would
  // just sit unauthenticated until the relay's handshake timeout closed it, and
  // we would dial straight back. Wait for the streamer to finish Twitch auth.
  if (!process.env.TWITCH_OAUTH) {
    if (!warnedNoToken) { log('waiting for Twitch auth before connecting'); warnedNoToken = true; }
    return scheduleReconnect();
  }
  warnedNoToken = false;
  const url = process.env.RELAY_URL || DEFAULT_URL;
  let sock;
  try { sock = new WebSocket(url); }
  catch (err) { log('bad RELAY_URL:', err.message); return scheduleReconnect(); }
  ws = sock;

  sock.on('open', () => { attempt = 0; handshake(sock); });
  sock.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    onMessage(msg);
  });
  sock.on('close', (code, reason) => {
    if (sock !== ws) return;
    if (connected) log('disconnected', code, reason?.toString() || '');
    connected = false;
    ws = null;
    broadcastStatus();
    scheduleReconnect();
  });
  sock.on('error', () => { /* close event handles reconnect */ });
}

function scheduleReconnect() {
  if (!started || reconnectTimer) return;
  attempt++;
  const base = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
  const delay = Math.round(base * (0.7 + Math.random() * 0.6)); // +-30% jitter
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
}

function handshake(sock) {
  const token = (process.env.TWITCH_OAUTH || '').replace(/^oauth:/i, '');
  if (!token) { log('no TWITCH_OAUTH, cannot authenticate to relay'); return; }
  send(sock, {
    v: PROTOCOL_VERSION,
    role: 'agent',
    token,
    commands: buildCommandList(),
    // Whether this app will stay quiet on "!" commands. Only this side knows, and
    // without telling the relay both bots answer: Guard forwards, and the local
    // chat handler runs the same command again from its own subscription. Two
    // replies, and the command executes twice.
    deferring: isDeferring(),
  });
}

function send(sock, obj) {
  try { sock.send(JSON.stringify(obj)); } catch {}
}

// Built-ins + custom `!` commands, minus the ones the relay refuses anyway.
function buildCommandList() {
  const out = [{ trigger: 'info', level: 'everyone' }]; // always-on watermark
  for (const [name, c] of Object.entries(deps.state.commands)) {
    if (!c.enabled || name === 'run' || name === 'killswitch') continue;
    if (!c.sources || !c.sources.includes('chat')) continue;
    out.push({ trigger: name, level: c.permission || 'broadcaster' });
  }
  for (const [name, c] of Object.entries(deps.state.customCommands)) {
    if (!c.enabled) continue;
    if ((c.match || 'command') !== 'command') continue; // keyword matches aren't name-triggerable
    if (!c.sources || !c.sources.includes('chat')) continue;
    out.push({ trigger: name, level: c.permission || 'everyone' });
  }
  return out;
}

function onMessage(msg) {
  switch (msg.type) {
    case 'ready':
      connected = true;
      log('connected as', msg.login);
      broadcastStatus();
      break;
    case 'displaced':
      log('displaced by a newer connection for this channel');
      break;
    case 'command.run':
      runQueue.push(msg);
      drainRunQueue();
      break;
    case 'queue.approve':
      handleQueueApprove(msg);
      break;
    case 'queue.skip':
      handleQueueSkip(msg);
      break;
    case 'queue.list':
      result(msg.id, { ok: true, queue: deps.state.queue, wishlist: deps.state.wishlist });
      break;
  }
}

function result(id, payload) {
  if (ws && connected) send(ws, { type: 'action.result', id, ...payload });
}

function remember(id, res) {
  seen.set(id, { result: res, ts: Date.now() });
  if (seen.size > SEEN_MAX) {
    const cutoff = Date.now() - SEEN_TTL_MS;
    for (const [k, v] of seen) if (v.ts < cutoff) seen.delete(k);
  }
}

async function drainRunQueue() {
  if (running) return;
  running = true;
  try {
    while (runQueue.length) {
      const msg = runQueue.shift();
      try { await execCommand(msg); }
      catch (err) { result(msg.id, { ok: false, error: err.message }); }
    }
  } finally {
    running = false;
  }
}

// Null-prototype: a plain object literal answers BADGES['constructor'] with a
// function and BADGES['__proto__'] with an object, so an odd userLevel used to
// blow up in .map() below instead of falling back to no badges.
const BADGES = Object.assign(Object.create(null), {
  moderator: ['moderator'], vip: ['vip'], subscriber: ['subscriber'],
});

// checkPermission() in listener.js reads badges, and treats chatter == broadcaster
// as broadcaster level. Build the smallest event that satisfies it.
function fakeEvent(userLevel) {
  const bid = 'relay-broadcaster';
  if (userLevel === 'broadcaster') {
    return { broadcaster_user_id: bid, chatter_user_id: bid, badges: [{ set_id: 'broadcaster' }] };
  }
  const badges = BADGES[userLevel] || [];
  return {
    broadcaster_user_id: bid,
    chatter_user_id: 'relay-user',
    badges: badges.map(set_id => ({ set_id })),
  };
}

async function execCommand(msg) {
  const cached = seen.get(msg.id);
  if (cached) return result(msg.id, cached.result);

  const user = typeof msg.user === 'string' ? msg.user : 'unknown';
  const args = Array.isArray(msg.args) ? msg.args : [];
  const text = '!' + msg.trigger + (args.length ? ' ' + args.join(' ') : '');

  let reply = '';
  // ponytail: module global, safe because command.run is drained serially above;
  // thread a context object through sendChatMessage if that ever changes.
  deps.setReplyInterceptor((t) => { reply = t; });
  try {
    await deps.dispatchCommand(fakeEvent(msg.userLevel), 'chat', user, text);
  } finally {
    deps.setReplyInterceptor(null);
  }

  const res = { ok: true, reply: reply || undefined };
  remember(msg.id, res);
  result(msg.id, res);
  deps.addLog('mod', 'relay:' + msg.trigger, `${user} via Guard`);
}

async function handleQueueApprove(msg) {
  const r = await deps.approveQueueEntry(msg.entryId, 'relay:' + (msg.user || 'mod'));
  result(msg.id, { ok: r.status === 200, error: r.body && r.body.error });
}

function handleQueueSkip(msg) {
  const r = deps.skipQueueEntry(msg.entryId, 'relay:' + (msg.user || 'mod'));
  result(msg.id, { ok: r.status === 200, error: r.body && r.body.error });
}

// listener.js calls this after a command config edit.
function commandsChanged() {
  if (ws && connected) {
    send(ws, { type: 'commands.update', commands: buildCommandList(), deferring: isDeferring() });
  }
}

// listener.js calls this from broadcast() on queue/wishlist mutations.
function pushSnapshot() {
  if (ws && connected) {
    send(ws, { type: 'queue.snapshot', queue: deps.state.queue, wishlist: deps.state.wishlist });
  }
}

function isConnected() { return connected; }

// The handshake reports this before `connected` is set, so it cannot depend on it.
function isDeferring() {
  return process.env.RELAY_DEFER_COMMANDS === 'true';
}

function status() {
  return {
    enabled: process.env.RELAY_ENABLED === 'true',
    connected,
    url: process.env.RELAY_URL || DEFAULT_URL,
    deferring: isDeferring() && connected,
  };
}

function broadcastStatus() {
  try { deps.broadcast({ event: 'relay_status', ...status() }); } catch {}
}

module.exports = {
  init, reload, stop,
  commandsChanged, pushSnapshot, isConnected, status,
};
