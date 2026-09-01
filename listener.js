const dotenvPath = process.env.DOTENV_CONFIG_PATH || require('path').join(__dirname, '.env');
require('dotenv').config({ path: dotenvPath });

// Keys that should be written back to .env whenever they change so settings
// survive process restarts.
const PERSIST_KEYS = [
  'JELLYFIN_URL','JELLYFIN_API_KEY','JELLYFIN_USERNAME','JELLYFIN_PASSWORD','JELLYFIN_DEVICE_ID',
  'OBS_HOST','OBS_PORT','OBS_PASSWORD',
  'LISTENER_PORT','MOD_PORT','MOD_ENABLED',
  'TWITCH_OAUTH','TWITCH_CHANNEL','TWITCH_CLIENT_ID','TWITCH_CLIENT_SECRET',
  'TWITCH_BOT_USERNAME','TWITCH_BOT_OAUTH',
  'SCRIPT_ALLOWLIST','MEDIA_CONTROL_MODE','CIDER_TOKEN','SPOTIFY_CLIENT_ID',
  'SONG_REQUEST_MODE','SONG_REQUEST_REDEEM_NAME','SONG_REQUEST_ENABLED',
  'SONG_REQUEST_APPROVAL','SONG_REQUEST_FILTERS','CIDER_STOREFRONT','MOD_TOKEN',
  'COMMANDS_CONFIG','CUSTOM_COMMANDS','REDEEM_ACTIONS',
  'ALERT_MODE','ALERT_OBS_SOURCE','ALERT_OBS_DURATION','ALERT_CUSTOM_CONFIG',
  'CHAT_OVERLAY_CONFIG','OVERLAY_MODE','OVERLAYS_ENABLED','NOWPLAYING_CONFIG',
  'SEVENTV_ENABLED','BTTV_ENABLED',
  'EVENT_TRIGGERS',
  'TTS_ENABLED','TTS_VOICE','TTS_RATE',
  'TTS_CHAT_ENABLED','TTS_CHAT_PERMISSION','TTS_CHAT_SAY_NAME','TTS_CHAT_MAX_LENGTH',
  'TTS_BITS_THRESHOLD',
  'TTS_REDEMPTIONS_ENABLED','TTS_REDEMPTION_NAMES',
  'TTS_ALERTS_ENABLED','TTS_ALERT_TYPES',
  'RELAY_ENABLED','RELAY_URL','RELAY_DEFER_COMMANDS',
];

function persistEnv() {
  const fs = require('fs');
  try {
    let lines = [];
    try { lines = fs.readFileSync(dotenvPath, 'utf8').split('\n'); } catch {}

    const written = new Set();
    // Update existing lines in place (preserves ordering and comments)
    lines = lines.map(line => {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=/);
      if (match && PERSIST_KEYS.includes(match[1])) {
        written.add(match[1]);
        const val = process.env[match[1]] ?? '';
        return `${match[1]}="${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      }
      return line;
    });

    // Append any keys not yet in the file
    for (const key of PERSIST_KEYS) {
      if (!written.has(key) && process.env[key] != null) {
        const val = process.env[key];
        lines.push(`${key}="${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
      }
    }

    fs.writeFileSync(dotenvPath, lines.join('\n'), 'utf8');
  } catch (err) {
    console.error('Failed to persist .env:', err.message);
  }
}

/**
 * Persist the settings this process owns.
 *
 * Under Electron the .env file is the wrong place and, in a packaged build, an
 * impossible one: listener.js runs from inside app.asar, so __dirname/.env is
 * read-only and every write threw into a console nobody sees. Worse, the app
 * restarts this process from electron-store, so anything only ever written to
 * .env was overwritten on the next save. That is why alert, chat and overlay
 * settings did not stick.
 *
 * So hand them to the main process, which owns the store. Standalone
 * (`npm run listener`) still writes .env, which is the right place there.
 */
function persistSettings() {
  if (typeof process.send === 'function') {
    const patch = {};
    for (const key of PERSIST_KEYS) if (process.env[key] != null) patch[key] = process.env[key];
    try { process.send({ type: 'persist', patch }); return; } catch {}
  }
  persistEnv();
}
const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const OBSWebSocket = require('obs-websocket-js').default;
const crypto = require('crypto');

// Built-in Twitch app Client ID (PKCE public client — no secret needed).
// Users can override this with their own by setting TWITCH_CLIENT_ID in Advanced settings.
const BUILTIN_CLIENT_ID = '3u4lr8zav4saitil8q3fhrydcstta6';
function getEffectiveClientId() {
  return process.env.TWITCH_CLIENT_ID || BUILTIN_CLIENT_ID;
}

// Dev mode: set by Electron when a .debug file exists next to the exe,
// or detected here directly for standalone `node listener.js` usage.
const DEV_MODE = process.env.DEV_MODE === 'true' ||
  (() => { try { return fs.existsSync(require('path').join(__dirname, '.debug')); } catch { return false; } })();

const app = express();
app.use(express.json());
app.use(express.static(require('path').join(__dirname, 'public')));

const SOUNDS_DIR = process.env.SOUNDS_DIR ||
  (require('path').join(process.pkg ? require('path').dirname(process.execPath) : __dirname, 'sounds'));
require('fs').mkdirSync(SOUNDS_DIR, { recursive: true });
app.use('/sounds', express.static(SOUNDS_DIR));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
// ws re-emits the underlying http server's 'error' on the WebSocketServer too,
// so handling it on `server` alone still left an unhandled 'error' event here -
// which is what actually crashed the process on a port collision.
wss.on('error', (err) => console.error(`WebSocket server error: ${err.message}`));

const PORT = process.env.LISTENER_PORT || 3000;
const MOD_PORT = process.env.MOD_PORT || 3001;

// modWss is created later — declared here so broadcast() can reach it
let modWss = null;

// Guard <-> Stream relay client. init() is called near the mod server block once
// its dependencies exist; every method is a no-op until then / until connected.
const relayClient = require('./relay-client');
const OBS_HOST = process.env.OBS_HOST || 'localhost';
const OBS_PORT = process.env.OBS_PORT || 4455;
const OBS_PASSWORD = process.env.OBS_PASSWORD;

// --- Default command config ---
// permission: 'everyone' | 'subscriber' | 'vip' | 'moderator' | 'broadcaster'
// sources: any combination of 'chat' | 'whisper' | 'redemption_input'
// response: chat reply template — supports {user}, {song}, {result}, {query}. Empty = no reply.
const DEFAULT_COMMANDS = {
  song:      { enabled: true,  permission: 'everyone',    sources: ['chat','whisper'],                    response: 'Now playing: {song}',                          description: "Show what's currently playing" },
  sr:        { enabled: true,  permission: 'everyone',    sources: ['chat','whisper','redemption_input'], response: '@{user} — {result}',                           description: 'Request a song (!sr <query>)' },
  play:      { enabled: true,  permission: 'moderator',   sources: ['chat','whisper'],                    response: '{result}',                                     description: 'Resume playback' },
  pause:     { enabled: true,  permission: 'moderator',   sources: ['chat','whisper'],                    response: '{result}',                                     description: 'Pause playback' },
  next:      { enabled: true,  permission: 'moderator',   sources: ['chat','whisper'],                    response: '⏭ Skipped to next track',                      description: 'Skip to next track' },
  prev:      { enabled: true,  permission: 'moderator',   sources: ['chat','whisper'],                    response: '⏮ Back to previous track',                     description: 'Go to previous track' },
  scene:     { enabled: true,  permission: 'moderator',   sources: ['chat','whisper'],                    response: '',                                             description: 'Switch OBS scene (!scene <name>)' },
  source:    { enabled: true,  permission: 'moderator',   sources: ['chat','whisper'],                    response: '',                                             description: 'Toggle OBS source (!source <name> on|off)' },
  sound:     { enabled: true,  permission: 'moderator',   sources: ['chat','whisper'],                    response: '',                                             description: 'Play a sound (!sound <name>)' },
  record:    { enabled: true,  permission: 'moderator',   sources: ['chat','whisper'],                    response: '',                                             description: 'Start/stop recording (!record start|stop)' },
  run:       { enabled: false, permission: 'broadcaster', sources: ['chat','whisper'],                    response: '',                                             description: 'Run a script URL (!run <url>)' },
  killswitch:{ enabled: false, permission: 'broadcaster', sources: ['chat','whisper'],                    response: '',                                             description: 'Stop stream and recording immediately' },
  tts:       { enabled: true,  permission: 'everyone',    sources: ['chat','whisper'],                    response: '',                                             description: 'Speak a message via TTS (!tts <message>)' },
};

// --- State ---
const state = {
  obs: { connected: false, reconnecting: false, failCount: 0, paused: false },
  jellyfin: { connected: false, lastChecked: null },
  twitch: { connected: false, failCount: 0, paused: false },
  log: [],
  queue: [],
  wishlist: [],
  redeemActions: {},
  commands: { ...DEFAULT_COMMANDS },
  customCommands: {},
  pluginCommands: {}
};

// Load persisted configs from env
try {
  if (process.env.REDEEM_ACTIONS) state.redeemActions = JSON.parse(process.env.REDEEM_ACTIONS);
} catch { console.log('Could not parse REDEEM_ACTIONS'); }

try {
  if (process.env.COMMANDS_CONFIG) {
    const saved = JSON.parse(process.env.COMMANDS_CONFIG);
    for (const [key, val] of Object.entries(saved)) {
      if (state.commands[key]) {
        if (typeof val.enabled === 'boolean') state.commands[key].enabled = val.enabled;
        if (val.permission) state.commands[key].permission = val.permission;
        if (Array.isArray(val.sources)) state.commands[key].sources = val.sources;
        if (typeof val.response === 'string') state.commands[key].response = val.response;
      }
    }
  }
} catch { console.log('Could not parse COMMANDS_CONFIG'); }

try {
  if (process.env.CUSTOM_COMMANDS) state.customCommands = JSON.parse(process.env.CUSTOM_COMMANDS);
} catch { console.log('Could not parse CUSTOM_COMMANDS'); }

// --- Plugin System ---
const EventEmitter = require('events');
const pluginEvents = new EventEmitter();
pluginEvents.setMaxListeners(50);

const PLUGINS_DIR = process.env.PLUGINS_DIR || require('path').join(__dirname, 'plugins');
const PLUGIN_STORE_PATH = process.env.PLUGIN_STORE_PATH || require('path').join(__dirname, 'plugin-store.json');
const fs = require('fs');

// Persistent key-value store for plugins, namespaced by plugin id
let pluginStore = {};
try { pluginStore = JSON.parse(fs.readFileSync(PLUGIN_STORE_PATH, 'utf8')); } catch {}
function savePluginStore() {
  try { fs.writeFileSync(PLUGIN_STORE_PATH, JSON.stringify(pluginStore, null, 2)); } catch {}
}

// Registry of loaded plugins: id -> { manifest, filePath, enabled }
const loadedPlugins = new Map();

function createPluginApi(pluginId) {
  return {
    addCommand(name, config) {
      state.pluginCommands[name.toLowerCase()] = { ...config, pluginId };
    },
    removeCommand(name) {
      delete state.pluginCommands[name.toLowerCase()];
    },
    on(event, handler)  { pluginEvents.on(event, handler); },
    off(event, handler) { pluginEvents.off(event, handler); },
    sendChat: (text) => sendChatMessage(text),
    get obs() { return obs; },
    jellyfin: (path, method = 'GET', body = null) => jellyfinRequest(path, method, body),
    log(detail, ok = true) { addLog('plugin', pluginId, detail, ok); },
    broadcast(data) { broadcast({ event: 'plugin_data', pluginId, data }); },
    store: {
      get(key)          { return pluginStore[pluginId]?.[key]; },
      set(key, value)   { if (!pluginStore[pluginId]) pluginStore[pluginId] = {}; pluginStore[pluginId][key] = value; savePluginStore(); },
      delete(key)       { if (pluginStore[pluginId]) { delete pluginStore[pluginId][key]; savePluginStore(); } },
      getAll()          { return { ...(pluginStore[pluginId] || {}) }; }
    },
    getSetting: (key)        => process.env[key],
    setSetting: (key, value) => { process.env[key] = value; persistSettings(); }
  };
}

function loadPlugin(filePath) {
  try {
    delete require.cache[require.resolve(filePath)];
    const manifest = require(filePath);
    if (!manifest.id || !manifest.name || typeof manifest.register !== 'function') {
      console.log(`Plugin ${filePath}: missing required fields (id, name, register)`);
      return null;
    }
    // Remove old commands from this plugin if reloading
    for (const [cmd, cfg] of Object.entries(state.pluginCommands)) {
      if (cfg.pluginId === manifest.id) delete state.pluginCommands[cmd];
    }
    // Remove old event listeners from this plugin
    pluginEvents.removeAllListeners();
    const enabled = pluginStore[`__enabled_${manifest.id}`] !== false;
    if (enabled) {
      const api = createPluginApi(manifest.id);
      manifest.register(api);
    }
    loadedPlugins.set(manifest.id, { manifest, filePath, enabled });
    addLog('plugin', 'load', `Loaded: ${manifest.name} v${manifest.version || '?'}${enabled ? '' : ' (disabled)'}`);
    return manifest;
  } catch (err) {
    console.log(`Plugin load error (${require('path').basename(filePath)}):`, err.message);
    addLog('plugin', 'load', `Failed to load ${require('path').basename(filePath)}: ${err.message}`, false);
    return null;
  }
}

function loadAllPlugins() {
  try {
    if (!fs.existsSync(PLUGINS_DIR)) fs.mkdirSync(PLUGINS_DIR, { recursive: true });
    const files = fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.js'));
    for (const file of files) loadPlugin(require('path').join(PLUGINS_DIR, file));
  } catch (err) { console.log('Plugin directory error:', err.message); }
}

// Load plugins after server is ready (so addLog etc. are available)
process.nextTick(loadAllPlugins);

// --- Broadcast / log ---
function broadcast(data) {
  const msg = JSON.stringify(data);
  [wss, modWss].forEach(ws => {
    if (!ws) return;
    ws.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    });
  });
  // ponytail: fire on every queue/wishlist mutation, no coalescing - these are
  // user-paced. Add a debounce if a bulk import ever spams it.
  if (data && typeof data.event === 'string' && /^(queue|wishlist)_/.test(data.event)) {
    relayClient.pushSnapshot();
  }
}

function addLog(type, command, detail, ok = true) {
  const entry = { id: Date.now(), time: new Date().toISOString(), type, command, detail, ok };
  state.log.unshift(entry);
  if (state.log.length > 100) state.log.pop();
  broadcast({ event: 'log', entry });
}

// --- Permission check ---
const PERMISSION_LEVELS = ['everyone', 'subscriber', 'vip', 'moderator', 'broadcaster'];

function checkPermission(chatEvent, required) {
  if (required === 'everyone') return true;
  const isBroadcaster = chatEvent.broadcaster_user_id === chatEvent.chatter_user_id;
  if (isBroadcaster) return true;
  if (required === 'broadcaster') return false;
  if (required === 'moderator') return chatEvent.badges?.some(b => b.set_id === 'moderator') || false;
  if (required === 'vip') return chatEvent.badges?.some(b => b.set_id === 'moderator' || b.set_id === 'vip') || false;
  if (required === 'subscriber') return chatEvent.badges?.some(b => ['moderator','vip','subscriber','founder'].includes(b.set_id)) || false;
  return false;
}

// --- OBS ---
const obs = new OBSWebSocket();

async function connectOBS() {
  if (state.obs.connected || state.obs.reconnecting || state.obs.paused) return;
  state.obs.reconnecting = true;
  try {
    await obs.connect(`ws://${OBS_HOST}:${OBS_PORT}`, OBS_PASSWORD);
    state.obs.connected = true;
    state.obs.reconnecting = false;
    state.obs.failCount = 0;
    state.obs.paused = false;
    broadcast({ event: 'status', service: 'obs', connected: true, paused: false });
    addLog('obs', 'connect', 'OBS WebSocket connected');
  } catch (err) {
    state.obs.reconnecting = false;
    state.obs.connected = false;
    state.obs.failCount++;
    if (state.obs.failCount >= 2) {
      state.obs.paused = true;
      broadcast({ event: 'status', service: 'obs', connected: false, paused: true });
      addLog('obs', 'disconnect', 'OBS unavailable — click OBS in the status bar to retry', false);
      return;
    }
    broadcast({ event: 'status', service: 'obs', connected: false, paused: false });
    setTimeout(connectOBS, 10000);
  }
}

obs.on('ConnectionClosed', () => {
  // obs-websocket-js fires ConnectionClosed on both genuine disconnects AND failed
  // connection attempts. Only treat it as a real disconnect if we were actually connected.
  if (!state.obs.connected) return;
  state.obs.connected = false;
  state.obs.failCount = 0; // genuine disconnect — reset the failure counter
  state.obs.paused = false;
  broadcast({ event: 'status', service: 'obs', connected: false, paused: false });
  addLog('obs', 'disconnect', 'OBS connection lost — reconnecting...', false);
  setTimeout(connectOBS, 10000);
});

connectOBS();

// Broadcast OBS state changes to the dashboard in real time
obs.on('CurrentProgramSceneChanged', ({ sceneName }) => {
  broadcast({ event: 'obs_scene', scene: sceneName });
});
obs.on('StreamStateChanged', ({ outputActive }) => {
  broadcast({ event: 'obs_stream_state', streaming: outputActive });
});
obs.on('RecordStateChanged', ({ outputActive }) => {
  broadcast({ event: 'obs_record_state', recording: outputActive });
});
obs.on('SceneItemEnableStateChanged', ({ sceneName, sceneItemId, sceneItemEnabled }) => {
  broadcast({ event: 'obs_source', scene: sceneName, id: sceneItemId, enabled: sceneItemEnabled });
});

// Tracks active OBS source-flash timers so rapid alerts don't conflict
const obsAlertTimers = new Map();

// --- Jellyfin ---
let jellyfinToken = null;
let jellyfinUserId = null;
let jellyfinBaseUrl = null;

// Cascade is already signed in to Jellyfin. Rather than make the user configure
// the same server twice - which they simply don't, and then every !sr silently
// lands in the wishlist - borrow Cascade's session. Only reached when Stream has
// no working credentials of its own, so a valid explicit config always wins.
async function jellyfinCredsFromCascade() {
  try {
    const r = await fetch('http://127.0.0.1:47847/cascade/jellyfin', { signal: AbortSignal.timeout(2000), headers: cascadeAuthHeaders() });
    if (!r.ok) return null;
    const d = await r.json();
    return d?.url && d?.token ? d : null;
  } catch { return null; }
}

async function authenticateJellyfin() {
  const JELLYFIN_URL = process.env.JELLYFIN_URL;
  const username = process.env.JELLYFIN_USERNAME;
  const password = process.env.JELLYFIN_PASSWORD;
  const apiKey = process.env.JELLYFIN_API_KEY;
  jellyfinBaseUrl = JELLYFIN_URL || null;

  if (username && password) {
    try {
      const res = await fetch(`${JELLYFIN_URL}/Users/AuthenticateByName`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': 'MediaBrowser Client="Cha0s Stream", Device="Cha0s", DeviceId="cha0s_stream", Version="1.0"' },
        body: JSON.stringify({ Username: username, Pw: password })
      });
      if (res.ok) {
        const data = await res.json();
        jellyfinToken = data.AccessToken;
        jellyfinUserId = data.User?.Id || null;
        return;
      }
    } catch (err) { console.log(`Jellyfin auth error: ${err.message}`); }
  }
  if (apiKey) {
    jellyfinToken = apiKey;
    try {
      const res = await fetch(`${JELLYFIN_URL}/Users/Me`, { headers: { 'X-Emby-Token': apiKey } });
      if (res.ok) { const data = await res.json(); jellyfinUserId = data.Id || null; }
    } catch {}
    return;
  }

  const borrowed = await jellyfinCredsFromCascade();
  if (borrowed) {
    jellyfinBaseUrl = borrowed.url.replace(/\/$/, '');
    jellyfinToken   = borrowed.token;
    jellyfinUserId  = borrowed.userId || null;
  }
}

async function jellyfinRequest(path, method = 'GET', body = null) {
  if (!jellyfinToken) await authenticateJellyfin();
  const JELLYFIN_URL = jellyfinBaseUrl || process.env.JELLYFIN_URL;
  if (!JELLYFIN_URL) throw new Error('No Jellyfin server configured');
  const url = `${JELLYFIN_URL}${path}`;
  const opts = { method, headers: { 'X-Emby-Token': jellyfinToken, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (res.status === 401) {
    jellyfinToken = null; await authenticateJellyfin();
    opts.headers['X-Emby-Token'] = jellyfinToken;
    const retry = await fetch(url, opts);
    if (!retry.ok) throw new Error(`Jellyfin HTTP ${retry.status}`);
    const retryText = await retry.text();
    return retryText ? JSON.parse(retryText) : null;
  }
  if (!res.ok) throw new Error(`Jellyfin HTTP ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/**
 * A session that can accept a queue/playback command.
 *
 * Not the same thing as getActiveSession(): that one requires NowPlayingItem
 * because !song and the transport commands read it, which meant approving a
 * request failed with "No active session" whenever the music happened to be
 * stopped - exactly when you most want to queue something up.
 *
 * The capability flag is checked permissively. Jellyfin exposes it as
 * SupportsRemoteControl on the session and SupportsMediaControl inside
 * Capabilities depending on version, so an absent flag is treated as
 * controllable: attempting the command and letting the server refuse beats
 * refusing to send it because we looked for the wrong field name.
 */
async function getControllableSession() {
  const sessions = await jellyfinRequest('/Sessions');
  const deviceId = process.env.JELLYFIN_DEVICE_ID;
  const username = process.env.JELLYFIN_USERNAME;
  const matches = (sessions || []).filter(s => {
    if (!(s.SupportsRemoteControl ?? s.Capabilities?.SupportsMediaControl ?? true)) return false;
    if (username && s.UserName?.toLowerCase() !== username.toLowerCase()) return false;
    if (deviceId && s.DeviceId !== deviceId) return false;
    return true;
  });
  // Whatever is actually playing wins when more than one client qualifies.
  return matches.find(s => s.NowPlayingItem) || matches[0] || null;
}

/**
 * Approve a pending request: hand it to the player as "play next".
 *
 * Shared by the dashboard route and the mod-queue route, which were identical
 * apart from their log line and had already drifted once.
 */
async function approveQueueEntry(id, via) {
  const entry = state.queue.find(e => e.id === id);
  if (!entry) return { status: 404, body: { error: 'Not found' } };
  if (!entry.resolvedItem) return { status: 400, body: { error: 'No resolved item' } };
  try {
    const { label, queueNext } = mediaAdapter();
    if (!queueNext) return { status: 400, body: { error: `${label} cannot queue song requests` } };
    await queueNext(entry.resolvedItem);
    entry.status = 'approved';
    broadcast({ event: 'queue_update', entry });
    addLog('jellyfin', 'queue', `Approved${via ? ` (${via})` : ''}: ${entry.resolvedItem.artist} — ${entry.resolvedItem.name}`);
    return { status: 200, body: { ok: true } };
  } catch (err) {
    addLog('jellyfin', 'queue', `Approve failed: ${err.message}`, false);
    return { status: 500, body: { error: err.message } };
  }
}

/**
 * Remove a pending request from the queue. Shared by the dashboard route, the
 * mod-queue route, and the relay client, which had drifted (different log lines).
 */
function skipQueueEntry(id, via) {
  const idx = state.queue.findIndex(e => e.id === id);
  if (idx === -1) return { status: 404, body: { error: 'Not found' } };
  const [entry] = state.queue.splice(idx, 1);
  broadcast({ event: 'queue_remove', id: entry.id });
  addLog('jellyfin', 'queue', `Skipped${via ? ` (${via})` : ''}: ${entry.query}`);
  return { status: 200, body: { ok: true } };
}

async function getActiveSession() {
  const sessions = await jellyfinRequest('/Sessions');
  const deviceId = process.env.JELLYFIN_DEVICE_ID;
  const username = process.env.JELLYFIN_USERNAME;
  return sessions?.find(s => {
    if (!s.NowPlayingItem) return false;
    if (username && s.UserName?.toLowerCase() !== username.toLowerCase()) return false;
    if (deviceId && s.DeviceId !== deviceId) return false;
    return true;
  }) || null;
}

async function checkJellyfinConnection() {
  try {
    await jellyfinRequest('/System/Info/Public');
    if (!state.jellyfin.connected) {
      state.jellyfin.connected = true;
      broadcast({ event: 'status', service: 'jellyfin', connected: true, paused: false });
      addLog('jellyfin', 'connect', 'Jellyfin reachable');
    }
    state.jellyfin.lastChecked = new Date().toISOString();
  } catch {
    if (state.jellyfin.connected) {
      state.jellyfin.connected = false;
      broadcast({ event: 'status', service: 'jellyfin', connected: false, paused: false });
      addLog('jellyfin', 'disconnect', 'Jellyfin unreachable', false);
    }
    // Stay disconnected and keep polling silently — no log spam, no forced pause
  }
}

checkJellyfinConnection();
setInterval(checkJellyfinConnection, 30000);

// --- OS Media Keys ---
function getOSNowPlaying() {
  const { exec } = require('child_process');
  const platform = require('os').platform();

  const cmds = {
    darwin: `osascript -e '
set output to ""
try
  if application "Spotify" is running then
    tell application "Spotify"
      if player state is playing then
        set output to artist & " — " & name of current track
      end if
    end tell
  end if
end try
try
  if output is "" and application "Music" is running then
    tell application "Music"
      if player state is playing then
        set output to artist of current track & " — " & name of current track
      end if
    end tell
  end if
end try
return output'`,
    win32: `powershell -Command "$null=[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media,ContentType=WindowsRuntime];$m=[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync().GetAwaiter().GetResult();$s=$m.GetCurrentSession();if($s){$p=$s.TryGetMediaPropertiesAsync().GetAwaiter().GetResult();if($p -and $p.Title){\\"$($p.Artist) — $($p.Title)\\"}}"`,
    linux: `playerctl metadata --format "{{artist}} — {{title}}" 2>/dev/null`
  };

  const cmd = cmds[platform];
  if (!cmd) return Promise.resolve(null);
  return new Promise(resolve => {
    exec(cmd, (err, stdout) => {
      const result = stdout?.trim();
      resolve(result && result.length > 0 ? result : null);
    });
  });
}

function sendOSMediaKey(action) {
  const { exec } = require('child_process');
  const platform = require('os').platform();

  // macOS: talk directly to the running music app — no Accessibility permission needed.
  // Tries Spotify first, then Apple Music.
  const darwinCmds = {
    play:  `osascript -e 'try\nif application "Spotify" is running then\ntell application "Spotify" to play\nelse if application "Music" is running then\ntell application "Music" to play\nend if\nend try'`,
    pause: `osascript -e 'try\nif application "Spotify" is running then\ntell application "Spotify" to pause\nelse if application "Music" is running then\ntell application "Music" to pause\nend if\nend try'`,
    next:  `osascript -e 'try\nif application "Spotify" is running then\ntell application "Spotify" to next track\nelse if application "Music" is running then\ntell application "Music" to next track\nend if\nend try'`,
    prev:  `osascript -e 'try\nif application "Spotify" is running then\ntell application "Spotify" to previous track\nelse if application "Music" is running then\ntell application "Music" to previous track\nend if\nend try'`,
  };

  const commands = {
    play:  { win32: `powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]179)"`, linux: `xdotool key XF86AudioPlay` },
    pause: { win32: `powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]179)"`, linux: `xdotool key XF86AudioPlay` },
    next:  { win32: `powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]176)"`, linux: `xdotool key XF86AudioNext` },
    prev:  { win32: `powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]177)"`, linux: `xdotool key XF86AudioPrev` },
  };

  const cmd = platform === 'darwin' ? darwinCmds[action] : commands[action]?.[platform];
  if (!cmd) throw new Error(`OS media key not supported for ${action} on ${platform}`);
  return new Promise((resolve, reject) => exec(cmd, err => err ? reject(err) : resolve()));
}

// --- Spotify ---
const SPOTIFY_SCOPES = 'user-read-currently-playing user-read-playback-state user-modify-playback-state';

function spotifyIsConfigured() {
  return !!(process.env.SPOTIFY_ACCESS_TOKEN);
}

async function spotifyRefreshToken() {
  const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN;
  const clientId     = process.env.SPOTIFY_CLIENT_ID;
  if (!refreshToken || !clientId) return false;
  try {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: refreshToken,
        client_id:     clientId,
      }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    process.env.SPOTIFY_ACCESS_TOKEN  = data.access_token;
    process.env.SPOTIFY_TOKEN_EXPIRY  = String(Date.now() + (data.expires_in - 60) * 1000);
    if (data.refresh_token) process.env.SPOTIFY_REFRESH_TOKEN = data.refresh_token;
    persistSettings();
    return true;
  } catch { return false; }
}

async function spotifyApiCall(path, method = 'GET', body = null) {
  // Refresh token if expiring within 60s
  const expiry = parseInt(process.env.SPOTIFY_TOKEN_EXPIRY || '0');
  if (Date.now() > expiry) await spotifyRefreshToken();

  const opts = {
    method,
    headers: { 'Authorization': `Bearer ${process.env.SPOTIFY_ACCESS_TOKEN}` },
  };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(`https://api.spotify.com/v1${path}`, opts);
  if (res.status === 401) {
    // Token expired mid-request — try one refresh and retry
    if (await spotifyRefreshToken()) {
      opts.headers['Authorization'] = `Bearer ${process.env.SPOTIFY_ACCESS_TOKEN}`;
      return fetch(`https://api.spotify.com/v1${path}`, opts);
    }
  }
  return res;
}

async function spotifyGetCurrentTrack() {
  if (!spotifyIsConfigured()) return null;
  try {
    const res = await spotifyApiCall('/me/player/currently-playing');
    if (res.status === 204 || !res.ok) return null;
    const data = await res.json();
    if (!data?.item) return null;
    return {
      title:     data.item.name,
      artist:    data.item.artists?.map(a => a.name).join(', ') || 'Unknown',
      album:     data.item.album?.name || '',
      id:        data.item.id,
      // images[0] is the largest Spotify offers; the overlay scales it down.
      art:        data.item.album?.images?.[0]?.url || null,
      durationMs: data.item.duration_ms ?? null,
      positionMs: data.progress_ms ?? null,
      isPlaying: data.is_playing,
    };
  } catch { return null; }
}

// --- Cascade now-playing polling ---

// Cascade's control server requires this token on every request (any local webpage
// can otherwise reach a loopback port). Cascade writes it to ~/.cascade-control-token;
// re-read on every call since it's a tiny local file and this avoids needing a restart
// if Cascade ever regenerates it.
function cascadeAuthHeaders() {
  try {
    const token = fs.readFileSync(require('path').join(require('os').homedir(), '.cascade-control-token'), 'utf8').trim();
    return { 'X-Cascade-Token': token };
  } catch { return {}; }
}

async function cascadeGetNowPlaying() {
  try {
    const r = await fetch('http://127.0.0.1:47847/cascade/now-playing', { signal: AbortSignal.timeout(2000), headers: cascadeAuthHeaders() });
    if (!r.ok) return null;
    const data = await r.json();
    if (!data.title) return null;
    // Cascade sends Jellyfin ids rather than a URL, because its own artUrl()
    // embeds Cascade's token. We build ours from the session we already have -
    // which, on a machine where only Cascade is configured, was borrowed from
    // Cascade in the first place (see jellyfinCredsFromCascade).
    const base = jellyfinBaseUrl || process.env.JELLYFIN_URL;
    const art = base && data.artItemId
      ? `${base}/Items/${data.artItemId}/Images/Primary?maxHeight=600${data.artImageTag ? `&tag=${data.artImageTag}` : ''}`
      : null;
    return {
      title: data.title,
      artist: data.artist || '',
      album: data.album || '',
      art,
      durationMs: data.durationMs ?? null,
      positionMs: data.positionMs ?? null,
      isPlaying: data.isPlaying ?? true,
    };
  } catch { return null; }
}

// One poller for every mode. There used to be two near-identical ones for
// Spotify and Cascade only, which is why the dashboard's now-playing line and
// anything else listening for `now_playing` stayed blank in Jellyfin and OS
// modes - nothing ever broadcast there.
let nowPlayingTimer = null;
let nowPlayingCurrent = null;

// Spotify and Jellyfin are network round trips; Cascade is a loopback read and
// can afford to be snappier.
const NOW_PLAYING_POLL_MS = { cascade: 4000, cider: 4000, spotify: 8000, jellyfin: 8000, os: 8000 };

function nowPlayingStartPolling() {
  nowPlayingStopPolling();
  const mode = mediaMode();
  const adapter = MEDIA_MODES[mode];
  // Spotify without credentials would poll forever and always answer null.
  if (adapter.available && !adapter.available()) return;

  const poll = async () => {
    // The mode can change under us between ticks; the next call re-arms.
    if (mediaMode() !== mode) return;
    let track = null;
    try { track = await adapter.nowPlaying(); } catch { track = null; }
    const now = formatTrack(track);
    const playing = track?.isPlaying ?? false;
    const changed = now !== formatTrack(nowPlayingCurrent) || playing !== (nowPlayingCurrent?.isPlaying ?? false);
    nowPlayingCurrent = track;
    if (changed) broadcast(nowPlayingPayload(track));
  };
  // Once straight away, then on the interval. Waiting a full period first left
  // nowPlayingCurrent null, so anything connecting in those first seconds - an
  // OBS source starting with the app - was told nothing was playing.
  poll();
  nowPlayingTimer = setInterval(poll, NOW_PLAYING_POLL_MS[mode] || 8000);
}

/**
 * The now_playing message, built in one place because it is sent from two: the
 * poller on a change, and every newly connected client.
 *
 * That second one is not cosmetic. The poller only broadcasts on change, so an
 * OBS browser source added or refreshed mid-song used to connect and receive
 * nothing at all until the track changed - a blank overlay for however long the
 * song had left. Same for the dashboard's now-playing line.
 */
function nowPlayingPayload(track) {
  return {
    event: 'now_playing',
    track: formatTrack(track),      // kept: the dashboard reads only this
    isPlaying: track?.isPlaying ?? false,
    title:  track?.title  || null,
    artist: track?.artist || null,
    album:  track?.album  || null,
    // Proxied so the overlay's canvas can read it - see /api/art.
    art: track?.art ? `/api/art?u=${encodeURIComponent(track.art)}` : null,
    durationMs: track?.durationMs ?? null,
    // Sampled at poll time, so an overlay wanting a smooth bar should tick
    // forward locally from here rather than waiting for the next poll.
    positionMs: track?.positionMs ?? null,
  };
}

function nowPlayingStopPolling() {
  if (nowPlayingTimer) { clearInterval(nowPlayingTimer); nowPlayingTimer = null; }
  nowPlayingCurrent = null;
}

// --- Twitch EventSub ---
let twitchWs = null;
let twitchReconnectTimer = null;
let twitchSessionId = null;
let twitchKeepaliveTimer = null;
let twitchKeepaliveTimeout = 15000;
let twitchIsReconnect = false;   // true when connecting via session_reconnect URL
let twitchReconnectAttempts = 0; // for exponential backoff
let twitchAuthFailed = false;   // set true on 401/403; cleared when Twitch settings update

async function getTwitchUserId(channelName, token) {
  const bearerToken = token.replace(/^oauth:/i, '');
  const res = await fetch(`https://api.twitch.tv/helix/users?login=${channelName}`, {
    headers: { 'Authorization': `Bearer ${bearerToken}`, 'Client-Id': getEffectiveClientId() }
  });
  if (!res.ok) throw new Error(`Twitch user lookup failed: ${res.status}`);
  const data = await res.json();
  return data.data?.[0]?.id || null;
}

async function subscribeEventSub(sessionId, type, condition, version = '1') {
  const token = (process.env.TWITCH_OAUTH || '').replace(/^oauth:/i, '');
  const clientId = getEffectiveClientId();
  const res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': clientId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, version, condition, transport: { method: 'websocket', session_id: sessionId } })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) {
      twitchAuthFailed = true;
      addLog('system', 'twitch',
        `Token rejected (${res.status}) — check Twitch settings. Auto-reconnect paused.`, false);
      // Close the WebSocket — the close handler will skip reconnect because twitchAuthFailed is set
      if (twitchWs) { twitchWs.removeAllListeners(); twitchWs.terminate(); twitchWs = null; }
    } else {
      addLog('system', 'twitch', `Subscription failed (${type}): ${err.message || res.status}`, false);
    }
  }
}

function resetKeepaliveWatchdog() {
  if (twitchKeepaliveTimer) clearTimeout(twitchKeepaliveTimer);
  twitchKeepaliveTimer = setTimeout(() => {
    addLog('system', 'twitch', 'Keepalive timeout — reconnecting', false);
    if (twitchWs) { twitchWs.removeAllListeners(); twitchWs.terminate(); twitchWs = null; }
    connectTwitchEventSub();
  }, twitchKeepaliveTimeout + 5000);
}

function attachTwitchHandlers(socket) {
  socket.on('open', () => { resetKeepaliveWatchdog(); });

  socket.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    resetKeepaliveWatchdog();
    const type = msg.metadata?.message_type;

    if (type === 'session_welcome') {
      twitchSessionId = msg.payload?.session?.id;
      const twKeepalive = msg.payload?.session?.keepalive_timeout_seconds;
      if (twKeepalive) twitchKeepaliveTimeout = (twKeepalive + 5) * 1000;
      twitchReconnectAttempts = 0;
      state.twitch.connected = true;
      state.twitch.paused = false;
      broadcast({ event: 'status', service: 'twitch', connected: true, paused: false });
      const wasReconnect = twitchIsReconnect;
      twitchIsReconnect = false;
      addLog('system', 'twitch', wasReconnect ? 'EventSub reconnected (subscriptions migrated)' : 'EventSub connected');

      // Only subscribe on the initial connection — Twitch migrates subscriptions
      // automatically during session_reconnect, so re-subscribing creates duplicates.
      const channel = process.env.TWITCH_CHANNEL;
      const token = process.env.TWITCH_OAUTH;
      if (!wasReconnect && channel && token) {
        try {
          const broadcasterId = await getTwitchUserId(channel, token);
          if (broadcasterId) {
            state.twitch.broadcasterId = broadcasterId;
            // Invalidate the 7TV cache — broadcasterId just became available, so any
            // cache built from the earlier connected broadcast was global-only.
            sevenTvCacheTime           = 0;
            sevenTvCacheHadBroadcaster = false;
            // Tell all connected clients to re-fetch emotes now that we have the broadcaster ID
            broadcast({ event: 'seventv_ready' });
            await subscribeEventSub(twitchSessionId, 'channel.chat.message', {
              broadcaster_user_id: broadcasterId, user_id: broadcasterId
            });
            // Whisper subscription (needs user:read:whispers scope)
            await subscribeEventSub(twitchSessionId, 'user.whisper.message', {
              user_id: broadcasterId
            });
            const srMode = process.env.SONG_REQUEST_MODE || 'chat';
            const hasRedeemActions = Object.keys(state.redeemActions).length > 0;
            if (srMode === 'channel_points' || hasRedeemActions) {
              await subscribeEventSub(twitchSessionId, 'channel.channel_points_custom_reward_redemption.add', {
                broadcaster_user_id: broadcasterId
              });
            }
            // Alert subscriptions — follow (v2), cheer, subscribe, resub, gift subs
            await subscribeEventSub(twitchSessionId, 'channel.follow', {
              broadcaster_user_id: broadcasterId,
              moderator_user_id: broadcasterId
            }, '2');
            await subscribeEventSub(twitchSessionId, 'channel.cheer', {
              broadcaster_user_id: broadcasterId
            });
            await subscribeEventSub(twitchSessionId, 'channel.subscribe', {
              broadcaster_user_id: broadcasterId
            });
            await subscribeEventSub(twitchSessionId, 'channel.subscription.message', {
              broadcaster_user_id: broadcasterId
            });
            await subscribeEventSub(twitchSessionId, 'channel.subscription.gift', {
              broadcaster_user_id: broadcasterId
            });
          }
        } catch (err) {
          addLog('system', 'twitch', `Subscription setup error: ${err.message}`, false);
        }
      }
    }

    if (type === 'session_keepalive') return;

    if (type === 'session_reconnect') {
      const url = msg.payload?.session?.reconnect_url;
      if (url) {
        addLog('system', 'twitch', 'Twitch requested reconnect — switching socket');
        const oldSocket = twitchWs;
        const newSocket = new WebSocket(url);
        twitchIsReconnect = true;
        twitchWs = newSocket;
        attachTwitchHandlers(newSocket);
        newSocket.once('open', () => oldSocket.close());
      }
      return;
    }

    if (type === 'notification') {
      const subType = msg.metadata?.subscription_type;
      const event = msg.payload?.event;
      if (subType === 'channel.channel_points_custom_reward_redemption.add') {
        const redeemTitle = event?.reward?.title;
        const user = event?.user_name || 'unknown';
        const input = event?.user_input || '';
        addLog('system', 'redeem', `${user} redeemed: ${redeemTitle}${input ? ` — "${input}"` : ''}`);
        await handleRedeem(redeemTitle, user, input);
        // Redemption TTS
        if (process.env.TTS_ENABLED === 'true' && process.env.TTS_REDEMPTIONS_ENABLED === 'true' && input) {
          const names = (process.env.TTS_REDEMPTION_NAMES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
          if (!names.length || names.includes(redeemTitle.toLowerCase())) {
            speakTTS(`${user} redeemed ${redeemTitle}: ${input}`);
          }
        }
      }
      if (subType === 'channel.chat.message') {
        await handleChatMessage(event);
      }
      if (subType === 'user.whisper.message') {
        await handleWhisperMessage(event);
      }
      if (subType === 'channel.follow') {
        const user = event?.user_name || 'someone';
        addLog('system', 'alert', `New follow: ${user}`);
        await triggerAlert({ type: 'follow', user });
        await fireTrigger('follow', { user });
      }
      if (subType === 'channel.cheer') {
        const user = event?.is_anonymous ? 'anonymous' : (event?.user_name || 'anonymous');
        const bits = event?.bits || 0;
        const message = event?.message || '';
        addLog('system', 'alert', `${user} cheered ${bits} bits`);
        await triggerAlert({ type: 'cheer', user, bits, message });
        await fireTrigger('cheer', { user, bits, message });
        // Bits TTS
        const bitsThreshold = parseInt(process.env.TTS_BITS_THRESHOLD) || 0;
        if (process.env.TTS_ENABLED === 'true' && bitsThreshold > 0 && bits >= bitsThreshold) {
          const cheerMsg = message ? `${user} cheered ${bits} bits: ${message}` : `${user} cheered ${bits} bits`;
          speakTTS(cheerMsg);
        }
      }
      if (subType === 'channel.subscribe') {
        const user = event?.user_name || 'someone';
        const tier = ({ '1000': 'Tier 1', '2000': 'Tier 2', '3000': 'Tier 3' })[event?.tier] || 'Tier 1';
        if (!event?.is_gift) {
          addLog('system', 'alert', `New sub: ${user} (${tier})`);
          await triggerAlert({ type: 'sub', user, tier });
          await fireTrigger('sub', { user, tier });
        }
      }
      if (subType === 'channel.subscription.message') {
        const user = event?.user_name || 'someone';
        const tier = ({ '1000': 'Tier 1', '2000': 'Tier 2', '3000': 'Tier 3' })[event?.tier] || 'Tier 1';
        const months = event?.cumulative_months || 1;
        const message = event?.message?.text || '';
        addLog('system', 'alert', `Resub: ${user} (${months} months, ${tier})`);
        await triggerAlert({ type: 'resub', user, tier, months, message });
        await fireTrigger('resub', { user, tier, months, message });
      }
      if (subType === 'channel.subscription.gift') {
        const gifter = event?.is_anonymous ? 'anonymous' : (event?.user_name || 'anonymous');
        const count = event?.total || 1;
        const tier = ({ '1000': 'Tier 1', '2000': 'Tier 2', '3000': 'Tier 3' })[event?.tier] || 'Tier 1';
        addLog('system', 'alert', `Gift subs: ${gifter} gifted ${count} (${tier})`);
        await triggerAlert({ type: 'giftsub', user: gifter, count, tier });
        await fireTrigger('giftsub', { user: gifter, count, tier });
      }
    }
  });

  socket.on('close', () => {
    if (socket !== twitchWs) return;
    if (twitchKeepaliveTimer) { clearTimeout(twitchKeepaliveTimer); twitchKeepaliveTimer = null; }
    state.twitch.connected = false;
    broadcast({ event: 'status', service: 'twitch', connected: false });
    // Don't reconnect if the token was rejected — wait for the user to fix their credentials
    if (twitchAuthFailed) {
      state.twitch.paused = true;
      broadcast({ event: 'status', service: 'twitch', connected: false, paused: true });
      addLog('system', 'twitch', 'Auto-reconnect paused — update your Twitch token in settings to reconnect.', false);
      return;
    }
    // Pause after 2 failed retry attempts — require manual reconnect
    if (twitchReconnectAttempts >= 2) {
      state.twitch.paused = true;
      twitchReconnectAttempts = 0;
      broadcast({ event: 'status', service: 'twitch', connected: false, paused: true });
      addLog('system', 'twitch', 'Twitch unavailable — click Twitch in the status bar to retry', false);
      return;
    }
    // Exponential backoff: 5s, 10s
    const delay = Math.min(5000 * Math.pow(2, twitchReconnectAttempts), 120000);
    twitchReconnectAttempts++;
    addLog('system', 'twitch', `EventSub disconnected — reconnecting in ${delay / 1000}s (attempt ${twitchReconnectAttempts})`, false);
    twitchReconnectTimer = setTimeout(connectTwitchEventSub, delay);
  });

  socket.on('error', (err) => {
    addLog('system', 'twitch', `WebSocket error: ${err.message}`, false);
  });
}

function connectTwitchEventSub() {
  if (twitchReconnectTimer) { clearTimeout(twitchReconnectTimer); twitchReconnectTimer = null; }
  if (!process.env.TWITCH_OAUTH) return;
  twitchWs = new WebSocket('wss://eventsub.wss.twitch.tv/ws');
  attachTwitchHandlers(twitchWs);
}

if (process.env.TWITCH_OAUTH) {
  connectTwitchEventSub();
}

// --- Chat command dispatcher ---
// --- TTS engine ---
const { spawn } = require('child_process');
let ttsQueue = [];
let ttsBusy  = false;

function sanitizeTTS(text, maxLen) {
  const max = parseInt(maxLen) || 200;
  return text
    .replace(/https?:\/\/\S+/g, 'link')          // replace URLs with "link"
    .replace(/[\p{Extended_Pictographic}]/gu, '') // strip emoji
    .replace(/[^\w\s',.!?:;-]/g, ' ')            // strip other special chars
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function enqueueTTS(text) {
  // Directly enqueue — no enabled check. Use speakTTS for normal guarded calls.
  const cleaned = sanitizeTTS(text, process.env.TTS_CHAT_MAX_LENGTH);
  if (!cleaned) return;
  ttsQueue.push(cleaned);
  if (!ttsBusy) drainTTSQueue();
}

function speakTTS(text) {
  if (process.env.TTS_ENABLED !== 'true') return;
  enqueueTTS(text);
}

function drainTTSQueue() {
  if (!ttsQueue.length) { ttsBusy = false; return; }
  ttsBusy = true;
  const text    = ttsQueue.shift();
  const voice   = process.env.TTS_VOICE || '';
  const rate    = process.env.TTS_RATE  || '';
  let cmd, args;

  if (process.platform === 'darwin') {
    args = [];
    if (voice) args.push('-v', voice);
    if (rate)  args.push('-r', rate);
    args.push(text);
    cmd = 'say';
  } else if (process.platform === 'win32') {
    const rateNum = rate ? Math.max(-10, Math.min(10, Math.round((parseInt(rate) - 150) / 25))) : 0;
    const safe    = text.replace(/'/g, "''");
    const voiceCmd = voice ? `$s.SelectVoice('${voice}');` : '';
    cmd  = 'powershell';
    args = ['-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ${voiceCmd} $s.Rate = ${rateNum}; $s.Speak('${safe}')`];
  } else {
    args = [];
    if (voice) args.push('-v', voice);
    if (rate)  args.push('-s', rate);
    args.push(text);
    cmd = 'espeak';
  }

  const proc = spawn(cmd, args, { stdio: 'ignore' });
  proc.on('close', () => drainTTSQueue());
  proc.on('error', err => {
    addLog('system', 'tts', `TTS error: ${err.message}`, false);
    drainTTSQueue();
  });
}

async function handleChatMessage(event) {
  const user = event?.chatter_user_name || 'unknown';
  const text = event?.message?.text || '';
  // Shared chat — source channel when message comes from a different broadcaster
  const sourceChannel = (event?.source_broadcaster_user_login &&
    event.source_broadcaster_user_login !== event.broadcaster_user_login)
    ? event.source_broadcaster_user_login : null;
  pluginEvents.emit('chat', { user, text, event });
  broadcast({
    event:     'chat',
    user,
    color:     event?.color || '',
    // Send full {set_id, id} pairs so overlays can look up real badge images
    badges:    (event?.badges || []).map(b => ({ set_id: b.set_id, id: b.id })),
    message:   text,
    fragments: (event?.message?.fragments || []).map(f => ({
      type:    f.type,
      text:    f.text,
      emoteId: f.emote?.id || null,
    })),
    sourceChannel, // null if same channel, login name if shared chat
    ts:        Date.now(),
  });
  // When deferring to Guard, skip the `!` command path here so the two bots
  // don't both answer. Keyword commands and TTS still run locally.
  const deferToGuard = process.env.RELAY_DEFER_COMMANDS === 'true' && relayClient.isConnected();
  await dispatchCommand(event, 'chat', user, text, { keywordOnly: deferToGuard });

  // Chat TTS
  if (process.env.TTS_ENABLED === 'true' && process.env.TTS_CHAT_ENABLED === 'true') {
    const minPerm = process.env.TTS_CHAT_PERMISSION || 'everyone';
    if (checkPermission(event, minPerm)) {
      const sayName = process.env.TTS_CHAT_SAY_NAME !== 'false';
      speakTTS(sayName ? `${user} says: ${text}` : text);
    }
  }
}

async function handleWhisperMessage(event) {
  // Whisper event shape: { from_user_name, whisper: { text } }
  // Build a minimal fake event so checkPermission still works correctly —
  // whispers are always treated as broadcaster-level since only the broadcaster
  // receives them and we can't check badges in whispers.
  const fakeEvent = {
    broadcaster_user_id: event?.to_user_id || '',
    chatter_user_id:     event?.from_user_id || '',
    badges: [{ set_id: 'broadcaster' }] // grant full permissions in whispers
  };
  await dispatchCommand(fakeEvent, 'whisper',
    event?.from_user_name || 'unknown',
    event?.whisper?.text || '');
}

async function dispatchCommand(permEvent, source, user, text, opts = {}) {
  text = (text || '').trim();

  // Keyword matching — runs on every message regardless of ! prefix
  for (const [name, custom] of Object.entries(state.customCommands)) {
    const matchType = custom.match || 'command';
    if (matchType === 'command') continue;
    if (!custom.enabled) continue;
    if (!custom.sources || !custom.sources.includes(source)) continue;
    const trigger = (custom.trigger || name).toLowerCase();
    const haystack = text.toLowerCase();
    const hit = matchType === 'contains'
      ? haystack.includes(trigger)
      : haystack.startsWith(trigger);
    if (!hit) continue;
    if (!checkPermission(permEvent, custom.permission)) continue;
    const response = fillTemplate(custom.response || '', { user });
    if (response) await sendChatMessage(response);
    addLog('system', `keyword:${name}`, `${user} — "${text}"`);
    // Don't return — multiple keyword commands can fire on the same message
  }

  // keywordOnly: relay defer mode still runs keyword/contains matches locally
  // (Guard has no equivalent), but hands `!` commands to Guard.
  if (opts.keywordOnly || !text.startsWith('!')) return;

  const parts = text.slice(1).split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  // Always-on watermark — runs before any config/permission checks
  if (cmd === 'info') { await cmdInfo(); return; }

  const cfg = state.commands[cmd];
  const custom = state.customCommands[cmd];

  if (!cfg && !custom) return;

  const activeCfg = cfg || custom;
  if (!activeCfg.enabled) return;

  // Source gate
  if (!activeCfg.sources || !activeCfg.sources.includes(source)) return;

  if (!checkPermission(permEvent, activeCfg.permission)) {
    addLog('system', `!${cmd}`, `${user} (${source}) — permission denied (need ${activeCfg.permission})`, false);
    return;
  }

  // Custom command — just send the response
  if (custom && !cfg) {
    const response = fillTemplate(custom.response || '', { user });
    if (response) await sendChatMessage(response);
    addLog('system', `!${cmd}`, `${user} — custom command`);
    return;
  }

  // Plugin command
  const pluginCmd = state.pluginCommands[cmd];
  if (pluginCmd && !cfg) {
    if (!pluginCmd.sources || !pluginCmd.sources.includes(source)) return;
    if (!checkPermission(permEvent, pluginCmd.permission || 'everyone')) {
      addLog('plugin', `!${cmd}`, `${user} — permission denied`, false);
      return;
    }
    try {
      await pluginCmd.handler({ user, args, source, event: permEvent });
      addLog('plugin', `!${cmd}`, `${user} (${source})`);
    } catch (err) {
      addLog('plugin', `!${cmd}`, `Error: ${err.message}`, false);
    }
    return;
  }

  switch (cmd) {
    case 'song':       await cmdSong(user); break;
    case 'sr':         await cmdSongRequest(user, args.join(' ')); break;
    case 'play':       await cmdMediaControl(user, 'play'); break;
    case 'pause':      await cmdMediaControl(user, 'pause'); break;
    case 'next':       await cmdMediaControl(user, 'next'); break;
    case 'prev':       await cmdMediaControl(user, 'prev'); break;
    case 'scene':      await cmdScene(user, args.join(' ')); break;
    case 'source':     await cmdSource(user, args[0], args[1]); break;
    case 'sound':      await cmdSound(user, args.join(' ')); break;
    case 'record':     await cmdRecord(user, args[0]); break;
    case 'run':        await cmdRun(user, args[0]); break;
    case 'killswitch': await cmdKillswitch(user); break;
    case 'tts':        await cmdTTS(user, args.join(' ')); break;
  }
}

// --- Chat response sender ---
// When set, a command's chat reply is captured here instead of being sent to
// Twitch: the relay client uses this so Guard can post the reply from its own
// bot identity. Set/cleared around each relayed command (drained serially).
let replyInterceptor = null;
function setReplyInterceptor(fn) { replyInterceptor = fn; }

async function sendChatMessage(text, sender = 'auto') {
  if (!text) return;
  if (replyInterceptor) { replyInterceptor(String(text)); return; }
  const clientId = getEffectiveClientId();
  const channel = process.env.TWITCH_CHANNEL || '';
  if (!channel) return;

  // Determine which credentials to use based on requested sender:
  //   'broadcaster' → always use broadcaster token (TWITCH_OAUTH), send as broadcaster
  //   'bot' / 'auto' → use bot token+username if configured, else fall back to broadcaster
  const forcebroadcaster = sender === 'broadcaster';
  const hasBotCreds = !forcebroadcaster && process.env.TWITCH_BOT_OAUTH && process.env.TWITCH_BOT_USERNAME;

  const rawToken = (hasBotCreds
    ? process.env.TWITCH_BOT_OAUTH
    : (process.env.TWITCH_OAUTH || process.env.TWITCH_BOT_OAUTH || '')
  ).replace(/^oauth:/i, '');
  if (!rawToken) return;

  try {
    // Need broadcaster ID to address the chat room, and sender ID for the bot (or broadcaster)
    const broadcasterId = await getTwitchUserId(channel, rawToken);
    if (!broadcasterId) {
      addLog('system', 'chat', `Could not resolve broadcaster ID for channel "${channel}"`, false);
      return;
    }

    // Sender is the bot account if username is set and we're not forcing broadcaster
    const botUsername = hasBotCreds ? (process.env.TWITCH_BOT_USERNAME || '') : '';
    const senderId = botUsername
      ? await getTwitchUserId(botUsername, rawToken)
      : broadcasterId;
    if (!senderId) {
      addLog('system', 'chat', `Could not resolve sender ID for bot username "${botUsername}" — is it correct?`, false);
      return;
    }

    const chatRes = await fetch('https://api.twitch.tv/helix/chat/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${rawToken}`,
        'Client-Id': clientId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        broadcaster_id: broadcasterId,
        sender_id: senderId,
        message: text.slice(0, 500) // Twitch chat message limit
      })
    });
    if (!chatRes.ok) {
      const body = await chatRes.text().catch(() => '');
      addLog('system', 'chat', `Chat send failed ${chatRes.status}: ${body}`, false);
    }
  } catch (err) {
    addLog('system', 'chat', `Failed to send message: ${err.message}`, false);
  }
}

// Fill a response template with context vars
function fillTemplate(template, vars) {
  if (!template) return '';
  return template
    .replace(/\{user\}/g, vars.user || '')
    .replace(/\{song\}/g, vars.song || '')
    .replace(/\{result\}/g, vars.result || '')
    .replace(/\{query\}/g, vars.query || '');
}

// --- Media control modes ---
// One adapter per mode, so the four commands that used to each carry their own
// four-branch if-chain (cmdSong, cmdMediaControl, POST /media, and the two
// polling switches) share a single lookup. Adding a mode used to mean five
// pasted copies, and they had already drifted: POST /media never handled
// Spotify at all and silently fell through to Jellyfin.
//
// nowPlaying() returns { title, artist, isPlaying } or null. control() performs
// play/pause/next/prev and throws on failure - the callers do the logging,
// since only they know whether they answer in chat or over HTTP.

async function cascadeControl(action) {
  const map = { play: 'playpause', pause: 'playpause', next: 'next', prev: 'prev' };
  const r = await fetch('http://127.0.0.1:47847/cascade/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cascadeAuthHeaders() },
    body: JSON.stringify({ action: map[action] || action })
  });
  if (!r.ok) throw new Error(`Cascade returned ${r.status}`);
}

async function spotifyControl(action) {
  const path   = { play: '/me/player/play', pause: '/me/player/pause', next: '/me/player/next', prev: '/me/player/previous' }[action];
  const method = { play: 'PUT', pause: 'PUT', next: 'POST', prev: 'POST' }[action] || 'POST';
  if (!path) throw new Error(`Unknown action: ${action}`);
  if (!spotifyIsConfigured()) throw new Error('Spotify is not connected');
  // spotifyApiCall hands back the response without inspecting it, so an action
  // Spotify refused - 404 with no active device being much the commonest - was
  // being reported to chat as a success.
  const res = await spotifyApiCall(path, method);
  if (!res.ok) throw new Error(res.status === 404 ? 'Spotify has no active device' : `Spotify returned ${res.status}`);
}

async function jellyfinControl(action) {
  const command = { play: 'Unpause', pause: 'Pause', next: 'NextTrack', prev: 'PreviousTrack' }[action];
  if (!command) throw new Error(`Unknown action: ${action}`);
  const session = await getActiveSession();
  if (!session) throw new Error('No active session');
  await jellyfinRequest(`/Sessions/${session.Id}/Playing/${command}`, 'POST');
}

async function jellyfinNowPlaying() {
  const session = await getActiveSession();
  const item = session?.NowPlayingItem;
  if (!item) return null;
  const base = jellyfinBaseUrl || process.env.JELLYFIN_URL;
  // Jellyfin serves item images without a token, so the overlay can load this
  // directly - no proxy route and no credential in a browser-source URL. The
  // tag busts the cache when the artwork is replaced.
  const artId = item.AlbumId || item.Id;
  const artTag = item.AlbumPrimaryImageTag || item.ImageTags?.Primary;
  return {
    title:  item.Name || '',
    artist: item.Artists?.[0] || item.AlbumArtist || 'Unknown Artist',
    album:  item.Album || '',
    art: base && artId ? `${base}/Items/${artId}/Images/Primary?maxHeight=600${artTag ? `&tag=${artTag}` : ''}` : null,
    durationMs: item.RunTimeTicks ? Math.round(item.RunTimeTicks / 10000) : null,
    positionMs: session.PlayState?.PositionTicks ? Math.round(session.PlayState.PositionTicks / 10000) : null,
    isPlaying: !session.PlayState?.IsPaused,
  };
}

// The OS helper answers with one pre-joined "Artist — Title" string, because
// that is all the platform scripts can get. Split it back apart so every
// adapter returns the same shape; an em dash inside a title is why this splits
// on the first separator only.
async function osNowPlaying() {
  const line = await getOSNowPlaying();
  if (!line) return null;
  const i = line.indexOf(' — ');
  return i === -1
    ? { title: line, artist: '', isPlaying: true }
    : { title: line.slice(i + 3), artist: line.slice(0, i), isPlaying: true };
}

// --- Cider ---
// Cider's local REST API, same idea as Cascade's control server but a documented
// first-party feature (Settings -> Connectivity -> Manage External Application
// Access). The header is `apptoken`: Cider's own docs say `apitoken`, and that
// is simply wrong - verified against a running Cider, apptoken returns 200 and
// apitoken 403.
const CIDER_API = 'http://127.0.0.1:10767/api/v1';

/** Cider's config, where the tokens generated in its UI are stored. */
function ciderConfigPath() {
  const os = require('os'), path = require('path');
  const dir = 'sh.cider.genten';
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', dir, 'spa-config.yml');
  if (process.platform === 'win32')  return path.join(process.env.APPDATA || '', dir, 'spa-config.yml');
  return path.join(os.homedir(), '.config', dir, 'spa-config.yml');
}

/**
 * An app token for Cider, preferring an explicitly configured one.
 *
 * The fallback scrapes the first token out of Cider's YAML rather than pulling
 * in a YAML parser for one field. Re-read each call so generating a token in
 * Cider does not need a Stream restart.
 */
function ciderToken() {
  if (process.env.CIDER_TOKEN) return process.env.CIDER_TOKEN;
  try {
    const raw = fs.readFileSync(ciderConfigPath(), 'utf8');
    const block = raw.slice(raw.indexOf('apiTokens:'));
    return block.match(/token:\s*(\S+)/)?.[1] || '';
  } catch { return ''; }
}

function ciderIsConfigured() { return !!ciderToken(); }

async function ciderFetch(path, method = 'GET', body = null) {
  const token = ciderToken();
  if (!token) throw new Error('No Cider app token (Settings \u2192 Connectivity \u2192 Manage External Application Access)');
  const headers = { apptoken: token };
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${CIDER_API}${path}`, {
    method, signal: AbortSignal.timeout(6000), headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(r.status === 403 ? 'Cider rejected the app token' : `Cider returned ${r.status}`);
  return r;
}

async function ciderControl(action) {
  // Cider has real play and pause, so these do not collapse into a toggle the
  // way Cascade's do - !play on an already-playing track is a no-op, not a stop.
  const path = { play: '/playback/play', pause: '/playback/pause', next: '/playback/next', prev: '/playback/previous' }[action];
  if (!path) throw new Error(`Unknown action: ${action}`);
  await ciderFetch(path, 'POST');
}

/**
 * Apple Music artwork URLs can carry {w}/{h} placeholders, which 404 unless
 * substituted. Cider resolves them itself before reporting a track - verified
 * against a live queue - so this is usually a no-op, kept for the sources that
 * hand them over raw.
 */
function ciderArtUrl(url) {
  return typeof url === 'string' ? url.replace(/\{w\}/g, '600').replace(/\{h\}/g, '600') : null;
}

async function ciderNowPlaying() {
  try {
    const [npRes, playRes] = await Promise.all([
      ciderFetch('/playback/now-playing'),
      ciderFetch('/playback/is-playing').catch(() => null),
    ]);
    const info = (await npRes.json())?.info;
    // Verified against a running Cider: the envelope is { status, info }, and
    // with nothing loaded `info` carries only shuffle/repeat/library flags and
    // no track at all - which is what a missing name means here.
    if (!info?.name) return null;
    const isPlaying = playRes ? (await playRes.json())?.is_playing ?? true : true;
    return {
      title:  info.name,
      artist: info.artistName || '',
      album:  info.albumName || '',
      art:    ciderArtUrl(info.artwork?.url),
      durationMs: info.durationInMillis ?? null,
      // Cider reports elapsed time in seconds, unlike every other field here.
      positionMs: info.currentPlaybackTime != null ? Math.round(info.currentPlaybackTime * 1000) : null,
      isPlaying,
    };
  } catch { return null; }
}

// --- Song request backends ---
// search() resolves a query to { id, type, name, artist, album, explicit } or
// null; queueNext() puts a resolved item next in the player. A mode without
// both simply cannot take song requests, and says so rather than dropping every
// request into the wishlist.

async function jellyfinSearch(query) {
  if (!jellyfinToken) await authenticateJellyfin();
  if (!jellyfinToken) throw new Error('Jellyfin is not connected');
  const uid = jellyfinUserId;
  const fields = 'Id,Name,Artists,Album,AlbumArtist';
  const path = uid
    ? `/Users/${uid}/Items?searchTerm=${encodeURIComponent(query)}&IncludeItemTypes=Audio&Recursive=true&Limit=1&Fields=${fields}`
    : `/Items?searchTerm=${encodeURIComponent(query)}&IncludeItemTypes=Audio&Recursive=true&Limit=1&Fields=${fields}`;
  const item = (await jellyfinRequest(path))?.Items?.[0];
  if (!item) return null;
  return {
    id: item.Id, type: 'jellyfin',
    name: item.Name || '',
    artist: item.Artists?.[0] || item.AlbumArtist || '',
    album: item.Album || '',
    // Jellyfin has no reliable explicit flag on audio, so nothing to filter on.
    explicit: false,
  };
}

async function jellyfinQueueNext(item) {
  const session = await getControllableSession();
  if (!session) throw new Error('No player to send it to');
  await jellyfinRequest(`/Sessions/${session.Id}/Playing?playCommand=PlayNext&itemIds=${item.id}`, 'POST');
}

/** Apple Music catalog search, through Cider's passthrough to the user's own
 *  subscription. Cider exposes no search of its own; run-v3 forwards a raw
 *  Apple Music API path. */
async function ciderSearch(query) {
  const storefront = process.env.CIDER_STOREFRONT || 'us';
  const path = `/v1/catalog/${storefront}/search?term=${encodeURIComponent(query)}&types=songs&limit=1`;
  const r = await ciderFetch('/amapi/run-v3', 'POST', { path });
  const song = (await r.json())?.data?.results?.songs?.data?.[0];
  if (!song) return null;
  const a = song.attributes || {};
  return {
    id: song.id, type: 'songs',
    name: a.name || '',
    artist: a.artistName || '',
    album: a.albumName || '',
    explicit: a.contentRating === 'explicit',
  };
}

async function ciderQueueNext(item) {
  // Schema is { type, id } - both required strings, per the endpoint's own
  // validation error.
  await ciderFetch('/playback/play-next', 'POST', { type: item.type || 'songs', id: item.id });
}

async function spotifySearch(query) {
  if (!spotifyIsConfigured()) throw new Error('Spotify is not connected');
  const res = await spotifyApiCall(`/search?q=${encodeURIComponent(query)}&type=track&limit=1`);
  if (!res.ok) throw new Error(`Spotify returned ${res.status}`);
  const t = (await res.json())?.tracks?.items?.[0];
  if (!t) return null;
  return {
    id: t.uri, type: 'track',
    name: t.name || '',
    artist: t.artists?.map(a => a.name).join(', ') || '',
    album: t.album?.name || '',
    explicit: !!t.explicit,
  };
}

async function spotifyQueueNext(item) {
  // Spotify has no "play next" - add-to-queue appends after the current track,
  // which is the closest thing it offers.
  const res = await spotifyApiCall(`/me/player/queue?uri=${encodeURIComponent(item.id)}`, 'POST');
  if (!res.ok) throw new Error(res.status === 404 ? 'Spotify has no active device' : `Spotify returned ${res.status}`);
}

const MEDIA_MODES = {
  cascade:  { label: 'Cascade',        nowPlaying: cascadeGetNowPlaying,  control: cascadeControl,
              search: jellyfinSearch, queueNext: jellyfinQueueNext },
  spotify:  { label: 'Spotify',        nowPlaying: spotifyGetCurrentTrack, control: spotifyControl, available: spotifyIsConfigured,
              search: spotifySearch,  queueNext: spotifyQueueNext },
  jellyfin: { label: 'Jellyfin',       nowPlaying: jellyfinNowPlaying,    control: jellyfinControl,
              search: jellyfinSearch, queueNext: jellyfinQueueNext },
  cider:    { label: 'Cider',          nowPlaying: ciderNowPlaying,       control: ciderControl,   available: ciderIsConfigured,
              search: ciderSearch,    queueNext: ciderQueueNext },
  os:       { label: 'OS media keys',  nowPlaying: osNowPlaying,          control: sendOSMediaKey },
};

/** The configured mode, falling back to 'os' for an unset or unknown value. */
function mediaMode() {
  const m = process.env.MEDIA_CONTROL_MODE;
  return MEDIA_MODES[m] ? m : 'os';
}

function mediaAdapter() {
  return MEDIA_MODES[mediaMode()];
}

/** "Artist — Title", or null. Shared by !song, the pollers and the overlay. */
function formatTrack(track) {
  if (!track?.title) return null;
  return track.artist ? `${track.artist} — ${track.title}` : track.title;
}

// --- Command implementations ---

// A command that fails logs it and, until now, said nothing in chat - so from
// chat's side a misconfigured command was indistinguishable from a working one
// that had nothing to say. Whoever ran it deserves to know it did not work.
// { until, cooldown } per command name.
const cmdWarn = new Map();
const CMD_WARN_BASE_MS = 20_000;
const CMD_WARN_MAX_MS  = 5 * 60_000;

/**
 * Report a failed command: to the log always, and to chat on a cooldown.
 *
 * The cooldown escalates. A broken command is an invitation to spam it, and a
 * bot that answers every invocation is both a self-inflicted timeout and a way
 * for chat to make it shout on demand. So each attempt that arrives while the
 * warning is still cooling down doubles the wait, up to five minutes; a quiet
 * spell decays it back to the base.
 */
function cmdFailed(source, cmd, user, reason) {
  addLog(source, `!${cmd}`, user ? `${user} — ${reason}` : reason, false);
  if (!user) return;

  const now = Date.now();
  const st = cmdWarn.get(cmd) || { until: 0, cooldown: CMD_WARN_BASE_MS };

  if (now < st.until) {
    // Still cooling down and they tried again: that is the abuse case, so back
    // further off rather than just staying quiet.
    st.cooldown = Math.min(st.cooldown * 2, CMD_WARN_MAX_MS);
    st.until = now + st.cooldown;
    cmdWarn.set(cmd, st);
    return;
  }
  // Quiet for a full cooldown past expiry - treat it as a fresh incident.
  if (now > st.until + st.cooldown) st.cooldown = CMD_WARN_BASE_MS;
  st.until = now + st.cooldown;
  cmdWarn.set(cmd, st);

  // Deliberately not a configurable template: this fires when the setup is
  // wrong, which is exactly when a user-edited response is least trustworthy.
  sendChatMessage(`@${user} — I couldn't run "!${cmd}" (${reason}). Is it set up right?`).catch(() => {});
}


async function cmdSong(user) {
  const { label, nowPlaying } = mediaAdapter();
  try {
    const song = formatTrack(await nowPlaying());
    if (!song) {
      addLog('system', '!song', `${user} — nothing playing`);
      await sendChatMessage(`@${user} — Nothing is playing right now.`);
      return;
    }
    addLog('system', '!song', `${user} → ${song} [${label}]`);
    const tmpl = state.commands.song?.response;
    if (tmpl) await sendChatMessage(fillTemplate(tmpl, { user, song }));
  } catch (err) { cmdFailed('system', 'song', user, err.message); }
}
async function cmdSongRequest(user, query) {
  if (!query) return;
  await handleSongRequest(user, query, 'chat');
}

async function cmdMediaControl(user, action) {
  const { label, control } = mediaAdapter();
  const resultMap = { play: '\u25b6\ufe0f Resumed', pause: '\u23f8 Paused', next: '\u23ed Skipped to next', prev: '\u23ee Back to previous' };
  const tmpl = state.commands[action]?.response;
  try {
    await control(action);
    addLog('system', `!${action}`, `${user} \u2192 ${label}`);
    if (tmpl) await sendChatMessage(fillTemplate(tmpl, { user, result: resultMap[action] || '\u25b6\ufe0f Done' }));
  } catch (err) { cmdFailed('system', action, user, `${label}: ${err.message}`); }
}
async function cmdScene(user, scene) {
  if (!state.obs.connected) { cmdFailed('obs', 'scene', user, 'OBS is not connected'); return; }
  if (!scene) {
    // No argument — list available scenes
    try {
      const { scenes, currentProgramSceneName } = await obs.call('GetSceneList');
      const names = scenes.map(s => s.sceneName === currentProgramSceneName ? `[${s.sceneName}]` : s.sceneName).reverse();
      await sendChatMessage(`Scenes: ${names.join(', ')} — use !scene <name>`);
      addLog('obs', '!scene', `${user} — listed scenes`);
    } catch (err) { addLog('obs', '!scene', err.message, false); }
    return;
  }
  try { await obs.call('SetCurrentProgramScene', { sceneName: scene }); addLog('obs', '!scene', `${user} → ${scene}`); }
  catch (err) { cmdFailed('obs', 'scene', user, err.message); }
}

async function cmdSource(user, source, onoff) {
  if (!state.obs.connected) { cmdFailed('obs', 'source', user, 'OBS is not connected'); return; }
  if (!source) {
    // No argument — list sources in the current scene
    try {
      const { currentProgramSceneName } = await obs.call('GetSceneList');
      const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: currentProgramSceneName });
      const names = sceneItems.map(i => `${i.sourceName}(${i.sceneItemEnabled ? 'on' : 'off'})`);
      await sendChatMessage(`Sources in "${currentProgramSceneName}": ${names.join(', ')} — use !source <name> on|off`);
      addLog('obs', '!source', `${user} — listed sources`);
    } catch (err) { cmdFailed('obs', 'source', user, err.message); }
    return;
  }
  const visible = onoff?.toLowerCase() !== 'off';
  try {
    const { scenes } = await obs.call('GetSceneList');
    for (const scene of scenes) {
      const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: scene.sceneName });
      const item = sceneItems.find(i => i.sourceName === source);
      if (item) {
        await obs.call('SetSceneItemEnabled', { sceneName: scene.sceneName, sceneItemId: item.sceneItemId, sceneItemEnabled: visible });
        addLog('obs', '!source', `${user} → ${source} ${visible ? 'on' : 'off'}`);
        return;
      }
    }
    addLog('obs', '!source', `Source not found: ${source}`, false);
    await sendChatMessage(`@${user} Source "${source}" not found. Use !source to list available sources.`);
  } catch (err) { cmdFailed('obs', 'source', user, err.message); }
}

async function cmdSound(user, sound) {
  if (!sound) return;
  const fs = require('fs'), path = require('path');
  if (sound.startsWith('http://') || sound.startsWith('https://')) {
    broadcast({ event: 'play_sound', url: sound });
    addLog('sound', '!sound', `${user} → ${sound}`);
    return;
  }
  // Absolute path support — works in Electron via file:// URL
  if (path.isAbsolute(sound)) {
    if (!fs.existsSync(sound)) { addLog('sound', '!sound', `File not found: ${sound}`, false); return; }
    const fileUrl = 'file:///' + sound.replace(/\\/g, '/').replace(/^\//, '');
    broadcast({ event: 'play_sound', url: fileUrl });
    addLog('sound', '!sound', `${user} → ${sound}`);
    return;
  }
  const ext = ['mp3','wav','ogg','flac'].find(e => fs.existsSync(path.join(SOUNDS_DIR, `${sound}.${e}`)));
  if (!ext) { addLog('sound', '!sound', `File not found: ${sound}`, false); return; }
  broadcast({ event: 'play_sound', url: `/sounds/${sound}.${ext}` });
  addLog('sound', '!sound', `${user} → ${sound}.${ext}`);
}

async function cmdRecord(user, action) {
  if (!state.obs.connected) { cmdFailed('obs', 'record', user, 'OBS is not connected'); return; }
  try {
    if (action === 'start') { await obs.call('StartRecord'); addLog('obs', '!record', `${user} → started`); }
    else if (action === 'stop') { await obs.call('StopRecord'); addLog('obs', '!record', `${user} → stopped`); }
    else addLog('obs', '!record', `${user} — unknown action: ${action}`, false);
  } catch (err) { cmdFailed('obs', 'record', user, err.message); }
}

async function cmdRun(user, scriptUrl) {
  if (!scriptUrl) return;
  if (!scriptUrl.startsWith('http://') && !scriptUrl.startsWith('https://')) {
    addLog('system', '!run', `${user} — invalid URL`, false); return;
  }
  const allowlist = (process.env.SCRIPT_ALLOWLIST || '').split(',').map(d => d.trim()).filter(Boolean);
  if (allowlist.length > 0) {
    const host = new URL(scriptUrl).hostname;
    if (!allowlist.some(d => host === d || host.endsWith(`.${d}`))) {
      addLog('system', '!run', `${user} — blocked domain: ${host}`, false); return;
    }
  }
  try {
    const fetchRes = await fetch(scriptUrl);
    if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status}`);
    const scriptContent = await fetchRes.text();
    const ext = scriptUrl.split('?')[0].split('.').pop().toLowerCase();
    const platform = require('os').platform();
    const tmpFile = require('path').join(require('os').tmpdir(), `cha0s_script_${Date.now()}.${ext}`);
    require('fs').writeFileSync(tmpFile, scriptContent);
    const { exec } = require('child_process');
    let command;
    if (ext === 'sh' && platform !== 'win32') command = `bash "${tmpFile}"`;
    else if (ext === 'ps1' && platform === 'win32') command = `powershell -ExecutionPolicy Bypass -File "${tmpFile}"`;
    else if (ext === 'bat' && platform === 'win32') command = `cmd /c "${tmpFile}"`;
    else { require('fs').unlinkSync(tmpFile); addLog('system', '!run', `Unsupported on ${platform}`, false); return; }
    addLog('system', '!run', `${user} → running ${ext.toUpperCase()}`);
    exec(command, (err) => {
      try { require('fs').unlinkSync(tmpFile); } catch {}
      if (err) addLog('system', '!run', `Script failed: ${err.message}`, false);
      else addLog('system', '!run', 'Script completed');
    });
  } catch (err) { addLog('system', '!run', err.message, false); }
}

async function cmdKillswitch(user) {
  if (!state.obs.connected) { cmdFailed('obs', 'killswitch', user, 'OBS is not connected'); return; }
  try {
    await obs.call('StopStream'); addLog('obs', '!killswitch', `${user} → stream stopped`);
    try { await obs.call('StopRecord'); addLog('obs', '!killswitch', 'Recording stopped'); } catch {}
  } catch (err) { addLog('obs', '!killswitch', err.message, false); }
}

async function cmdTTS(user, text) {
  if (process.env.TTS_ENABLED !== 'true') return;
  if (!text) return;
  speakTTS(text);
  addLog('system', '!tts', `${user}: ${text}`);
}

async function cmdInfo() {
  const { version } = require('./package.json');
  await sendChatMessage(`Cha0s Stream v${version} — https://github.com/Cha0s1nc/cha0s-stream`);
  addLog('system', '!info', `Sent app info (v${version})`);
}

// --- Alert trigger ---
async function triggerAlert(alertData) {
  const mode = process.env.ALERT_MODE || 'browser_source';
  if (mode === 'disabled') return;

  // Play alert sound if one is configured for this type
  const alertCfg = getAlertCustomConfig() || ALERT_CUSTOM_DEFAULTS;
  const alertTypeCfg = alertCfg.types?.[alertData.type];
  if (alertTypeCfg?.sound && alertTypeCfg.sound.trim()) {
    await cmdSound('alert', alertTypeCfg.sound.trim()).catch(() => {});
  }

  // Browser Source mode: push event to WebSocket clients — alerts.html picks it up
  if (mode === 'browser_source' || mode === 'both') {
    broadcast({ event: 'alert', ...alertData });
  }

  // OBS WebSocket mode: flash a named source on/off for a configurable duration
  if ((mode === 'obs_websocket' || mode === 'both') && state.obs.connected) {
    const sourceName = (process.env.ALERT_OBS_SOURCE || '').trim();
    const duration = parseInt(process.env.ALERT_OBS_DURATION) || 5000;
    if (!sourceName) return;

    try {
      const { scenes } = await obs.call('GetSceneList');
      for (const scene of scenes) {
        const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: scene.sceneName });
        const item = sceneItems.find(i => i.sourceName === sourceName);
        if (item) {
          // Show the source
          await obs.call('SetSceneItemEnabled', {
            sceneName: scene.sceneName, sceneItemId: item.sceneItemId, sceneItemEnabled: true
          });
          // Clear any existing hide-timer for this source so rapid alerts extend the display
          if (obsAlertTimers.has(sourceName)) clearTimeout(obsAlertTimers.get(sourceName));
          const timer = setTimeout(async () => {
            obsAlertTimers.delete(sourceName);
            try {
              await obs.call('SetSceneItemEnabled', {
                sceneName: scene.sceneName, sceneItemId: item.sceneItemId, sceneItemEnabled: false
              });
            } catch {}
          }, duration);
          obsAlertTimers.set(sourceName, timer);
          break;
        }
      }
    } catch (err) {
      addLog('obs', 'alert', `Source flash failed: ${err.message}`, false);
    }
  }
}

// --- Redeem handler ---
async function handleRedeem(redeemTitle, user, input) {
  pluginEvents.emit('redeem', { title: redeemTitle, user, input });
  const action = state.redeemActions[redeemTitle];
  if (!action) {
    const srMode = process.env.SONG_REQUEST_MODE || 'chat';
    const srRedeemName = process.env.SONG_REQUEST_REDEEM_NAME || '';
    if (srMode === 'channel_points' && srRedeemName && redeemTitle === srRedeemName) {
      await handleSongRequest(user, input, 'redeem');
    }
    return;
  }
  try {
    if (action.type === 'script') await cmdRun(user, action.script);
    else if (action.type === 'sound') await cmdSound(user, action.sound);
    else if (action.type === 'scene') await cmdScene(user, action.scene);
    else if (action.type === 'source') await cmdSource(user, action.source, action.visible !== false ? 'on' : 'off');
  } catch (err) { addLog('system', `redeem:${redeemTitle}`, `Action failed: ${err.message}`, false); }
}

// --- Song request handler ---
// --- Song request filtering ---
// Blocked artists and songs are matched case-insensitively as substrings, so
// "kanye" catches "Kanye West" without anyone maintaining exact spellings. That
// also means a short entry can over-match: "war" would block "Warpaint". The
// settings copy says so.
const SR_FILTER_DEFAULTS = { blockedArtists: [], blockedSongs: [], allowExplicit: true };

function getSongRequestFilters() {
  try {
    const raw = process.env.SONG_REQUEST_FILTERS;
    if (raw) return { ...SR_FILTER_DEFAULTS, ...JSON.parse(raw) };
  } catch {}
  return { ...SR_FILTER_DEFAULTS };
}

/** Why this request is refused, or null to allow it. */
function songRequestBlockedReason(item) {
  const f = getSongRequestFilters();
  if (!f.allowExplicit && item.explicit) return 'it is marked explicit';
  const artist = (item.artist || '').toLowerCase();
  const name   = (item.name   || '').toLowerCase();
  const hit = (list, hay) => (Array.isArray(list) ? list : [])
    .map(v => String(v).trim().toLowerCase()).filter(Boolean)
    .find(v => hay.includes(v));
  const badArtist = hit(f.blockedArtists, artist);
  if (badArtist) return `"${badArtist}" is on the blocked artists list`;
  const badSong = hit(f.blockedSongs, name);
  if (badSong) return `"${badSong}" is on the blocked songs list`;
  return null;
}

/** 'approve' (default) holds requests for a mod; 'open' queues them straight. */
function songRequestMode() {
  return process.env.SONG_REQUEST_APPROVAL === 'open' ? 'open' : 'approve';
}

async function handleSongRequest(user, query, source) {
  if (!query || process.env.SONG_REQUEST_ENABLED === 'false') return;
  const { label, search, queueNext } = mediaAdapter();
  const tmpl = state.commands.sr?.response;
  const reply = async (result) => { if (tmpl) await sendChatMessage(fillTemplate(tmpl, { user, query, result })); };
  addLog('system', '!sr', `${user} requested: ${query}`);

  // OS media keys can drive a player but cannot search one, so say that rather
  // than wishlisting every request as "not found".
  if (!search || !queueNext) {
    addLog('system', '!sr', `${label} cannot take song requests`, false);
    await reply(`song requests aren't available in ${label} mode.`);
    return;
  }

  let item = null;
  try {
    item = await search(query);
  } catch (err) {
    addLog('system', '!sr', `${label}: ${err.message}`, false);
    await reply(`I couldn't search ${label} (${err.message}).`);
    return;
  }

  if (!item) {
    const entry = { id: `wish_${Date.now()}`, user, query, addedAt: new Date().toISOString() };
    state.wishlist.unshift(entry);
    if (state.wishlist.length > 200) state.wishlist.pop();
    broadcast({ event: 'wishlist_add', entry });
    addLog('system', '!sr', `"${query}" not found — added to wishlist`, false);
    await reply(`"${query}" wasn't found — added to the wishlist!`);
    return;
  }

  // Filters run on the resolved track, not the raw query: someone asking for
  // "that one song" should still be caught by the artist it resolves to.
  const blocked = songRequestBlockedReason(item);
  if (blocked) {
    addLog('system', '!sr', `Blocked: ${item.artist} — ${item.name} (${blocked})`, false);
    await reply(`"${item.artist} — ${item.name}" can't be requested: ${blocked}.`);
    return;
  }

  const track = `${item.artist} — ${item.name}`;
  if (songRequestMode() === 'open') {
    try {
      await queueNext(item);
      const entry = { id: `req_${Date.now()}`, user, query, source, resolvedItem: item, status: 'approved', addedAt: new Date().toISOString() };
      state.queue.push(entry);
      broadcast({ event: 'queue_add', entry });
      addLog('system', '!sr', `Queued (open): ${track}`);
      await reply(`"${track}" added to the queue!`);
    } catch (err) {
      addLog('system', '!sr', `Queue failed: ${err.message}`, false);
      await reply(`I found "${track}" but couldn't queue it (${err.message}).`);
    }
    return;
  }

  const entry = { id: `req_${Date.now()}`, user, query, source, resolvedItem: item, status: 'pending', addedAt: new Date().toISOString() };
  state.queue.push(entry);
  broadcast({ event: 'queue_add', entry });
  addLog('system', '!sr', `Pending approval: ${track}`);
  await reply(`"${track}" is waiting for a mod to approve it.`);
}

// --- Service reconnect ---
app.post('/api/reconnect/:service', (req, res) => {
  const { service } = req.params;
  if (service === 'obs') {
    state.obs.paused = false;
    state.obs.failCount = 0;
    connectOBS();
  } else if (service === 'jellyfin') {
    checkJellyfinConnection(); // triggers an immediate check outside the 30s cycle
  } else if (service === 'twitch') {
    state.twitch.paused = false;
    twitchReconnectAttempts = 0;
    twitchAuthFailed = false;
    connectTwitchEventSub();
  } else {
    return res.status(400).json({ error: 'Unknown service' });
  }
  res.json({ ok: true });
});

// Frontend can't hit Cascade's control server directly anymore (it now requires
// the token file only the backend can read), so proxy the presence check through here.
// Same shape as the Cascade check below: the browser cannot read Cider's token
// file, so the presence probe is proxied through here.
// Artwork proxy.
//
// The overlay reads the cover's pixels on a canvas to pick its accent colour,
// and a cross-origin image taints the canvas so those pixels cannot be read at
// all. Serving art from our own origin sidesteps that, and keeps the Jellyfin
// address out of a browser-source URL as a side effect.
//
// Origin-restricted rather than open: this happily fetches whatever it is
// given, and an open fetcher bound to localhost is worth closing even when only
// local pages can reach it.
const ART_HOST_ALLOWLIST = [
  'i.scdn.co', 'mosaic.scdn.co', 'image-cdn-ak.spotifycdn.com', 'image-cdn-fa.spotifycdn.com', // Spotify
  'is1-ssl.mzstatic.com', 'is2-ssl.mzstatic.com', 'is3-ssl.mzstatic.com',
  'is4-ssl.mzstatic.com', 'is5-ssl.mzstatic.com', 'a1.mzstatic.com',                            // Apple Music / Cider
];

function artUrlAllowed(target) {
  // Whichever Jellyfin we are actually pointed at, however it is addressed.
  const base = jellyfinBaseUrl || process.env.JELLYFIN_URL;
  if (base) {
    try { if (new URL(base).host === target.host) return true; } catch {}
  }
  return ART_HOST_ALLOWLIST.includes(target.host);
}

app.get('/api/art', async (req, res) => {
  let target;
  try { target = new URL(req.query.u || ''); } catch { return res.status(400).end(); }
  if (!/^https?:$/.test(target.protocol)) return res.status(400).end();
  if (!artUrlAllowed(target)) return res.status(403).end();
  try {
    const r = await fetch(target, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return res.status(502).end();
    const type = r.headers.get('content-type') || '';
    if (!type.startsWith('image/')) return res.status(415).end();
    res.set('Content-Type', type);
    // Art for a given item does not change, and the overlay re-requests it on
    // every track change.
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch { res.status(504).end(); }
});

// The mod queue link, token included. Served from the main app rather than the
// mod server so the streamer can read it without already holding the token.
app.get('/api/mod/link', (req, res) => {
  const port = parseInt(process.env.MOD_PORT) || MOD_PORT;
  res.json({ url: `http://localhost:${port}/?token=${modToken()}` });
});

app.post('/api/mod/link', (req, res) => {
  process.env.MOD_TOKEN = crypto.randomBytes(24).toString('hex');
  persistSettings();
  modWss.clients.forEach(c => c.terminate());   // old link stops working now, not on reconnect
  addLog('system', 'mod', 'Mod queue link regenerated — existing sessions disconnected');
  res.json({ ok: true });
});

app.get('/api/cider/status', async (req, res) => {
  try { await ciderFetch('/playback/active'); res.json({ running: true }); }
  catch { res.json({ running: false }); }
});

app.get('/api/cascade/status', async (req, res) => {
  try {
    const r = await fetch('http://127.0.0.1:47847/cascade/status', { signal: AbortSignal.timeout(800), headers: cascadeAuthHeaders() });
    res.json({ running: r.ok });
  } catch { res.json({ running: false }); }
});

// --- HTTP Routes (kept for external compat) ---
app.post('/media', async (req, res) => {
  const { action } = req.body;
  const { nowPlaying, control } = mediaAdapter();

  if (action === 'song') {
    try {
      const song = formatTrack(await nowPlaying());
      return res.json(song ? { song } : { nothing: true });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  if (!['play', 'pause', 'next', 'prev'].includes(action)) {
    return res.status(400).json({ error: `Unknown action: ${action}` });
  }
  try { await control(action); return res.json({ ok: true }); }
  catch (err) { return res.status(503).json({ error: err.message }); }
});
app.post('/sound', async (req, res) => {
  await cmdSound('http', req.body.sound);
  res.json({ ok: true });
});

// --- Sound file management ---
const AUDIO_EXTS = ['.mp3', '.wav', '.ogg', '.flac'];
app.get('/api/sounds', (req, res) => {
  const fs = require('fs'), path = require('path');
  const files = fs.readdirSync(SOUNDS_DIR)
    .filter(f => AUDIO_EXTS.includes(path.extname(f).toLowerCase())).sort();
  res.json({ sounds: files, dir: SOUNDS_DIR });
});
app.post('/api/sounds/upload', express.raw({ type: '*/*', limit: '20mb' }), (req, res) => {
  const fs = require('fs'), path = require('path');
  const rawName = (req.headers['x-filename'] || 'upload.mp3').replace(/[/\\:*?"<>|]/g, '_');
  const ext = path.extname(rawName).toLowerCase();
  if (!AUDIO_EXTS.includes(ext)) return res.status(400).json({ error: 'Invalid file type' });
  fs.writeFileSync(path.join(SOUNDS_DIR, rawName), req.body);
  const name = path.basename(rawName, ext);
  addLog('system', 'sounds', `Uploaded: ${rawName}`);
  res.json({ ok: true, name, filename: rawName });
});
app.delete('/api/sounds/:filename', (req, res) => {
  const fs = require('fs'), path = require('path');
  const filename = req.params.filename;
  if (/[\/\\]|\.\./u.test(filename) || !AUDIO_EXTS.includes(path.extname(filename).toLowerCase()))
    return res.status(400).json({ error: 'Invalid filename' });
  const filePath = path.join(SOUNDS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(filePath);
  addLog('system', 'sounds', `Deleted: ${filename}`);
  res.json({ ok: true });
});
app.post('/scene', async (req, res) => {
  await cmdScene('http', req.body.scene);
  res.json({ ok: true });
});
app.post('/source', async (req, res) => {
  const { source, visible } = req.body;
  await cmdSource('http', source, visible ? 'on' : 'off');
  res.json({ ok: true });
});
app.post('/recording', async (req, res) => {
  await cmdRecord('http', req.body.action);
  res.json({ ok: true });
});
app.post('/killswitch', async (req, res) => {
  await cmdKillswitch('http');
  res.json({ ok: true });
});
app.post('/run', async (req, res) => {
  await cmdRun('http', req.body.script);
  res.json({ ok: true });
});

// --- Queue API ---
app.get('/api/queue', (req, res) => res.json({ queue: state.queue, wishlist: state.wishlist }));

app.post('/api/queue/add', async (req, res) => {
  const { user, query, itemId, itemName, itemArtist, itemAlbum } = req.body;
  const entry = { id: `req_${Date.now()}`, user: user || 'streamer', query: query || itemName, source: 'manual', resolvedItem: itemId ? { id: itemId, name: itemName, artist: itemArtist, album: itemAlbum } : null, status: 'pending', addedAt: new Date().toISOString() };
  state.queue.push(entry);
  broadcast({ event: 'queue_add', entry });
  addLog('jellyfin', 'queue', `Manually queued: ${itemArtist} — ${itemName}`);
  res.json({ ok: true, entry });
});

app.post('/api/queue/:id/approve', async (req, res) => {
  const { status, body } = await approveQueueEntry(req.params.id, null);
  res.status(status).json(body);
});

app.post('/api/queue/:id/skip', (req, res) => {
  const { status, body } = skipQueueEntry(req.params.id, null);
  res.status(status).json(body);
});

app.delete('/api/wishlist/:id', (req, res) => {
  const idx = state.wishlist.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  state.wishlist.splice(idx, 1);
  broadcast({ event: 'wishlist_remove', id: req.params.id });
  res.json({ ok: true });
});

app.get('/api/jellyfin/search', async (req, res) => {
  const q = req.query.q || '';
  if (!q) return res.json({ items: [] });
  try {
    if (!jellyfinToken) await authenticateJellyfin();
    const uid = jellyfinUserId;
    const path = uid
      ? `/Users/${uid}/Items?searchTerm=${encodeURIComponent(q)}&IncludeItemTypes=Audio&Recursive=true&Limit=20&Fields=Id,Name,Artists,Album,RunTimeTicks`
      : `/Items?searchTerm=${encodeURIComponent(q)}&IncludeItemTypes=Audio&Recursive=true&Limit=20&Fields=Id,Name,Artists,Album,RunTimeTicks`;
    const result = await jellyfinRequest(path);
    const items = (result?.Items || []).map(item => ({
      id: item.Id, name: item.Name, artist: item.Artists?.[0] || item.AlbumArtist || '',
      album: item.Album || '', duration: item.RunTimeTicks ? Math.round(item.RunTimeTicks / 10000000) : null
    }));
    res.json({ items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Alerts route (Browser Source overlay) ---
app.get('/alerts',  (req, res) => res.sendFile(require('path').join(__dirname, 'public', 'alerts.html')));
app.get('/chat',    (req, res) => res.sendFile(require('path').join(__dirname, 'public', 'chat.html')));
app.get('/overlay', (req, res) => res.sendFile(require('path').join(__dirname, 'public', 'overlay.html')));
// Its own page rather than a layer in /overlay, matching /alerts and /chat: it
// is a small card you position and size as its own OBS source. Configured by
// query string (align, art, bar, hide) - see the top of nowplaying.html.
app.get('/nowplaying', (req, res) => res.sendFile(require('path').join(__dirname, 'public', 'nowplaying.html')));
// ── Chat overlay config ──────────────────────────────────────────
const CHAT_OVERLAY_DEFAULTS = {
  maxMessages: 8, lifetime: 30000,
  fontSize: 15, bgOpacity: 75, bgColor: '#000000',
  showBadges: true, showTimestamps: false, position: 'left',
  customCSS: '',
};
function getChatOverlayConfig() {
  try { const r = process.env.CHAT_OVERLAY_CONFIG; if (r) return JSON.parse(r); } catch {}
  return null;
}
app.get('/api/chat/config', (req, res) => {
  res.json({ ...CHAT_OVERLAY_DEFAULTS, ...(getChatOverlayConfig() || {}), browserSourceUrl: `http://localhost:${PORT}/chat` });
});
app.post('/api/chat/send', async (req, res) => {
  const text   = (req.body?.message || '').trim();
  const sender = req.body?.sender || 'auto'; // 'bot' | 'broadcaster' | 'auto'
  if (!text) return res.status(400).json({ error: 'No message' });
  if (!state.twitch.connected) return res.status(503).json({ error: 'Twitch not connected' });
  try {
    await sendChatMessage(text, sender);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chat/config', (req, res) => {
  if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'Invalid body' });
  process.env.CHAT_OVERLAY_CONFIG = JSON.stringify(req.body);
  persistSettings();
  broadcast({ event: 'overlay_config_update', scope: 'chat' });
  res.json({ ok: true });
});

// ── Combined overlay config (mode + alert + chat merged) ──────────────────────
// Which overlays the user has switched on. Replaces the old single
// OVERLAY_MODE choice, which forced one-of - now that every overlay has its own
// page and its own browser source, they are independent.
const OVERLAYS_ENABLED_DEFAULTS = { events: true, chat: false, nowplaying: false };
function getOverlaysEnabled() {
  try {
    const raw = process.env.OVERLAYS_ENABLED;
    if (raw) return { ...OVERLAYS_ENABLED_DEFAULTS, ...JSON.parse(raw) };
  } catch {}
  // First run after an upgrade: derive from whatever OVERLAY_MODE said, so an
  // existing setup keeps working without being reconfigured.
  const legacy = process.env.OVERLAY_MODE;
  if (legacy === 'chat')  return { ...OVERLAYS_ENABLED_DEFAULTS, events: false, chat: true };
  if (legacy === 'both')  return { ...OVERLAYS_ENABLED_DEFAULTS, events: true,  chat: true };
  return { ...OVERLAYS_ENABLED_DEFAULTS };
}

const NOWPLAYING_DEFAULTS = {
  theme: 'card', accent: 'auto', width: 440, size: 15, radius: 14,
  align: 'bottom-left', art: true, album: true, bar: true, times: true,
};
function getNowPlayingConfig() {
  try {
    const raw = process.env.NOWPLAYING_CONFIG;
    if (raw) return { ...NOWPLAYING_DEFAULTS, ...JSON.parse(raw) };
  } catch {}
  return { ...NOWPLAYING_DEFAULTS };
}

/** The overlay is configured entirely by query string, so its settings ARE its
 *  URL - built here so the dashboard and any caller agree on one answer. */
function nowPlayingUrl(cfg = getNowPlayingConfig(), host = `localhost:${PORT}`) {
  const q = new URLSearchParams();
  if (cfg.theme  !== NOWPLAYING_DEFAULTS.theme)  q.set('theme', cfg.theme);
  if (cfg.accent !== NOWPLAYING_DEFAULTS.accent) q.set('accent', cfg.accent);
  if (+cfg.width  !== NOWPLAYING_DEFAULTS.width)  q.set('width', cfg.width);
  if (+cfg.size   !== NOWPLAYING_DEFAULTS.size)   q.set('size', cfg.size);
  if (+cfg.radius !== NOWPLAYING_DEFAULTS.radius) q.set('radius', cfg.radius);
  if (cfg.align  !== NOWPLAYING_DEFAULTS.align)  q.set('align', cfg.align);
  for (const k of ['art', 'album', 'bar', 'times']) if (!cfg[k]) q.set(k, '0');
  const qs = q.toString();
  return `http://${host}/nowplaying${qs ? '?' + qs : ''}`;
}

app.get('/api/overlay/config', (req, res) => {
  let alertCfg = {};
  try { const r = process.env.ALERT_CUSTOM_CONFIG; if (r) alertCfg = JSON.parse(r); } catch {}
  const enabled = getOverlaysEnabled();
  const npCfg = getNowPlayingConfig();
  res.json({
    // Kept for the combined /overlay page, which still asks what to render.
    // Derived rather than stored so the switches are the single source of truth.
    mode: enabled.events && enabled.chat ? 'both' : enabled.chat ? 'chat' : 'alerts',
    enabled,
    alert:            alertCfg,
    chat:             { ...CHAT_OVERLAY_DEFAULTS, ...(getChatOverlayConfig() || {}) },
    nowPlaying:       npCfg,
    browserSourceUrl: `http://localhost:${PORT}/overlay`,
    alertsUrl:        `http://localhost:${PORT}/alerts`,
    chatUrl:          `http://localhost:${PORT}/chat`,
    nowPlayingUrl:    nowPlayingUrl(npCfg),
  });
});

// ── Twitch badge cache ────────────────────────────────────────────────────────
// Builds a flat map: "set_id/version_id" → image_url_1x
// e.g. "subscriber/3" → "https://static-cdn.jtvnw.net/badges/v1/.../1"
let badgeCache     = {};   // { "moderator/1": url, ... }
let badgeCacheTime = 0;
const BADGE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function fetchBadgeCache() {
  if (Date.now() - badgeCacheTime < BADGE_TTL_MS && Object.keys(badgeCache).length) return badgeCache;
  const token      = process.env.TWITCH_OAUTH;
  const clientId   = getEffectiveClientId();
  const broadcasterId = state.twitch.broadcasterId;
  if (!token || !clientId) return badgeCache;

  const headers = { 'Authorization': `Bearer ${token.replace(/^oauth:/i, '')}`, 'Client-Id': clientId };
  const map = {};

  try {
    const globalRes = await fetch('https://api.twitch.tv/helix/chat/badges/global', { headers });
    if (globalRes.ok) {
      const { data } = await globalRes.json();
      for (const set of data) {
        for (const v of set.versions) map[`${set.set_id}/${v.id}`] = v.image_url_1x;
      }
    }
  } catch {}

  if (broadcasterId) {
    try {
      const chanRes = await fetch(`https://api.twitch.tv/helix/chat/badges?broadcaster_id=${broadcasterId}`, { headers });
      if (chanRes.ok) {
        const { data } = await chanRes.json();
        for (const set of data) {
          for (const v of set.versions) map[`${set.set_id}/${v.id}`] = v.image_url_1x;
        }
      }
    } catch {}
  }

  if (Object.keys(map).length) { badgeCache = map; badgeCacheTime = Date.now(); }
  return badgeCache;
}

app.get('/api/chat/badges', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await fetchBadgeCache());
});

// ── 7TV persistent emote cache ────────────────────────────────────────────────
const SEVENTV_CACHE_FILE = process.env.SEVENTV_CACHE_FILE || require('path').join(__dirname, 'emote-cache.json');
const SEVENTV_TTL_MS     = 30 * 60 * 1000; // re-check every 30 min

let sevenTvEmoteCache          = null; // { name: url, ... }
let sevenTvCacheChecksum       = '';   // MD5 of sorted emote names — detects real changes
let sevenTvCacheTime           = 0;
let sevenTvCacheHadBroadcaster = false;

// Load whatever was saved last time the app ran
function loadSevenTvCacheFromDisk() {
  try {
    const raw  = fs.readFileSync(SEVENTV_CACHE_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data.emotes && Object.keys(data.emotes).length > 0) {
      sevenTvEmoteCache          = data.emotes;
      sevenTvCacheChecksum       = data.checksum       || '';
      sevenTvCacheTime           = data.timestamp      || 0;
      sevenTvCacheHadBroadcaster = data.hadBroadcaster || false;
      addLog('system', 'chat',
        `7TV: restored ${Object.keys(sevenTvEmoteCache).length} emotes from disk cache`);
    }
  } catch { /* no cache yet — that's fine */ }
}

function saveSevenTvCacheToDisk() {
  try {
    fs.writeFileSync(SEVENTV_CACHE_FILE, JSON.stringify({
      emotes:        sevenTvEmoteCache,
      checksum:      sevenTvCacheChecksum,
      timestamp:     sevenTvCacheTime,
      hadBroadcaster: sevenTvCacheHadBroadcaster,
    }), 'utf8');
  } catch (err) {
    addLog('system', 'chat', `7TV: failed to write disk cache: ${err.message}`, false);
  }
}

function computeEmoteChecksum(map) {
  // MD5 of sorted "name=url" pairs — sensitive to both additions and URL changes
  const content = Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  return crypto.createHash('md5').update(content).digest('hex');
}

function buildEmoteUrl(emote) {
  const host = emote?.data?.host;
  if (!host?.url) return null;
  const files = host.files || [];
  const file =
    files.find(f => f.name === '2x.webp') ||
    files.find(f => f.name === '1x.webp') ||
    files.find(f => /\.webp$/i.test(f.name)) ||
    files[0];
  if (!file) return null;
  const base = host.url.startsWith('//') ? `https:${host.url}` : host.url;
  return `${base}/${file.name}`;
}

// Load disk cache at startup
loadSevenTvCacheFromDisk();

app.get('/api/chat/emotes', async (req, res) => {
  try {
    const now            = Date.now();
    const broadcasterId  = state.twitch.broadcasterId;
    const forceRefresh   = req.query.refresh === '1';

    // Serve from in-memory (or already-loaded disk) cache when:
    //   • we have data AND
    //   • it's within the TTL AND
    //   • it was built with a broadcasterId, or we still don't have one yet AND
    //   • the caller didn't ask for a forced refresh
    const cacheValid =
      sevenTvEmoteCache !== null &&
      (now - sevenTvCacheTime) < SEVENTV_TTL_MS &&
      (sevenTvCacheHadBroadcaster || !broadcasterId) &&
      !forceRefresh;

    res.set('Cache-Control', 'no-store');
    if (cacheValid) return res.json(sevenTvEmoteCache);

    const map          = {};
    const HEADERS      = { 'User-Agent': 'Cha0sStream/1.0' };
    const sevenTvOn    = process.env.SEVENTV_ENABLED !== 'false';
    const bttvOn       = process.env.BTTV_ENABLED    !== 'false';

    // ── Global 7TV emotes ─────────────────────────────────────────
    if (sevenTvOn) try {
      const r = await fetch('https://7tv.io/v3/emote-sets/global', { headers: HEADERS });
      if (r.ok) {
        const data = await r.json();
        let n = 0;
        for (const e of (data?.emotes || [])) {
          const url = buildEmoteUrl(e);
          if (e?.name && url) { map[e.name] = url; n++; }
        }
        addLog('system', 'chat', `7TV: fetched ${n} global emotes`);
      } else {
        addLog('system', 'chat', `7TV global fetch failed: HTTP ${r.status}`, false);
      }
    } catch (err) {
      addLog('system', 'chat', `7TV global fetch error: ${err.message}`, false);
    }

    // ── Channel 7TV emotes ────────────────────────────────────────
    if (sevenTvOn && broadcasterId) {
      try {
        const r = await fetch(`https://7tv.io/v3/users/twitch/${broadcasterId}`, { headers: HEADERS });
        if (r.ok) {
          const data = await r.json();
          let n = 0;
          for (const e of (data?.emote_set?.emotes || [])) {
            const url = buildEmoteUrl(e);
            if (e?.name && url) { map[e.name] = url; n++; }
          }
          addLog('system', 'chat', `7TV: fetched ${n} channel emotes`);
        } else {
          addLog('system', 'chat', `7TV channel fetch failed: HTTP ${r.status}`, false);
        }
      } catch (err) {
        addLog('system', 'chat', `7TV channel fetch error: ${err.message}`, false);
      }
    }

    // ── Global BTTV emotes ────────────────────────────────────────
    if (bttvOn) try {
      const r = await fetch('https://api.betterttv.net/3/cached/emotes/global', { headers: HEADERS });
      if (r.ok) {
        const data = await r.json();
        let n = 0;
        for (const e of (data || [])) {
          if (e?.code && e?.id) {
            map[e.code] = `https://cdn.betterttv.net/emote/${e.id}/2x`;
            n++;
          }
        }
        addLog('system', 'chat', `BTTV: fetched ${n} global emotes`);
      } else {
        addLog('system', 'chat', `BTTV global fetch failed: HTTP ${r.status}`, false);
      }
    } catch (err) {
      addLog('system', 'chat', `BTTV global fetch error: ${err.message}`, false);
    }

    // ── Channel BTTV emotes ───────────────────────────────────────
    if (bttvOn && broadcasterId) {
      try {
        const r = await fetch(`https://api.betterttv.net/3/cached/users/twitch/${broadcasterId}`, { headers: HEADERS });
        if (r.ok) {
          const data = await r.json();
          let n = 0;
          // channelEmotes = emotes the broadcaster added; sharedEmotes = emotes shared from other users
          for (const e of [...(data?.channelEmotes || []), ...(data?.sharedEmotes || [])]) {
            if (e?.code && e?.id) {
              map[e.code] = `https://cdn.betterttv.net/emote/${e.id}/2x`;
              n++;
            }
          }
          addLog('system', 'chat', `BTTV: fetched ${n} channel emotes`);
        } else {
          addLog('system', 'chat', `BTTV channel fetch failed: HTTP ${r.status}`, false);
        }
      } catch (err) {
        addLog('system', 'chat', `BTTV channel fetch error: ${err.message}`, false);
      }
    }

    if (Object.keys(map).length > 0) {
      const newChecksum = computeEmoteChecksum(map);
      const changed     = newChecksum !== sevenTvCacheChecksum;

      sevenTvEmoteCache          = map;
      sevenTvCacheTime           = now;
      sevenTvCacheHadBroadcaster = !!broadcasterId;
      sevenTvCacheChecksum       = newChecksum;

      if (changed) {
        // Emotes actually changed — persist to disk
        saveSevenTvCacheToDisk();
        addLog('system', 'chat',
          `Emote cache updated (${Object.keys(map).length} total, checksum ${newChecksum.slice(0, 8)})`);
      } else {
        // Same data — just reset the TTL clock, no disk write needed
        addLog('system', 'chat', `7TV: emote set unchanged (checksum match)`);
      }
    } else {
      // Fetch returned nothing — serve last known good data rather than an empty map
      addLog('system', 'chat',
        `Emote fetch returned 0 results — serving cached data (${Object.keys(sevenTvEmoteCache || {}).length} emotes)`, false);
    }

    res.json(sevenTvEmoteCache || {});
  } catch (err) {
    addLog('system', 'chat', `7TV endpoint error: ${err.message}`, false);
    // Always return whatever we have rather than an error
    res.json(sevenTvEmoteCache || {});
  }
});

// Manual emote refresh — busts the in-memory cache for the requested provider(s)
app.post('/api/tts/test', (req, res) => {
  const text = (req.body?.text || 'Cha0s Stream TTS is working.').slice(0, 200);
  enqueueTTS(text); // bypasses TTS_ENABLED so you can test before enabling
  addLog('system', 'tts', `Test: "${text}"`);
  res.json({ ok: true });
});

app.post('/api/emotes/refresh', (req, res) => {
  const { which } = req.body || {};
  // 'which' is 'seventv', 'bttv', or omitted (both)
  const all = !which || which === 'both';
  if (all || which === 'seventv' || which === 'bttv') {
    sevenTvCacheTime           = 0;
    sevenTvCacheHadBroadcaster = false;
    addLog('system', 'chat', `Emote cache cleared (${which || 'all'}) — will re-fetch on next request`);
  }
  res.json({ ok: true });
});

// Debug endpoint — visit /api/chat/emotes/debug to see exactly what 7TV returns
app.get('/api/chat/emotes/debug', async (req, res) => {
  const broadcasterId = state.twitch.broadcasterId;
  const result = {
    broadcasterId:        broadcasterId || null,
    cacheSize:            sevenTvEmoteCache ? Object.keys(sevenTvEmoteCache).length : 0,
    cacheChecksum:        sevenTvCacheChecksum || null,
    cacheHadBroadcaster:  sevenTvCacheHadBroadcaster,
    cacheAgeSeconds:      sevenTvCacheTime ? Math.round((Date.now() - sevenTvCacheTime) / 1000) : null,
    globalFetch:          null,
    channelFetch:         null,
  };

  try {
    const r = await fetch('https://7tv.io/v3/emote-sets/global', { headers: { 'User-Agent': 'Cha0sStream/1.0' } });
    result.globalFetch = { status: r.status, ok: r.ok };
    if (r.ok) {
      const data = await r.json();
      result.globalFetch.emoteCount = (data?.emotes || []).length;
      result.globalFetch.sampleEmotes = (data?.emotes || []).slice(0, 3).map(e => e.name);
    }
  } catch (err) {
    result.globalFetch = { error: err.message };
  }

  if (broadcasterId) {
    try {
      const r = await fetch(`https://7tv.io/v3/users/twitch/${broadcasterId}`, { headers: { 'User-Agent': 'Cha0sStream/1.0' } });
      result.channelFetch = { status: r.status, ok: r.ok };
      if (r.ok) {
        const data = await r.json();
        result.channelFetch.topLevelKeys   = Object.keys(data);
        result.channelFetch.emoteSetKeys   = data.emote_set ? Object.keys(data.emote_set) : null;
        result.channelFetch.emoteCount     = (data?.emote_set?.emotes || []).length;
        result.channelFetch.sampleEmotes   = (data?.emote_set?.emotes || []).slice(0, 5).map(e => ({
          name: e.name,
          url:  buildEmoteUrl(e),
          hasData: !!e?.data,
          hasHost: !!e?.data?.host,
          filesCount: (e?.data?.host?.files || []).length,
        }));
      } else {
        const body = await r.text().catch(() => '');
        result.channelFetch.body = body.slice(0, 300);
      }
    } catch (err) {
      result.channelFetch = { error: err.message };
    }
  } else {
    result.channelFetch = { skipped: 'broadcasterId not set — Twitch not connected' };
  }

  // Show what the cache actually has for a few known channel emote names
  if (sevenTvEmoteCache) {
    const channelSamples = ['peepoShy','donowall','Madge','NOOOO','COPIUM'];
    result.cacheUrlSamples = {};
    for (const name of channelSamples) {
      result.cacheUrlSamples[name] = sevenTvEmoteCache[name] || null;
    }
  }

  res.json(result);
});

// --- Alerts config API ---
const ALERT_CUSTOM_DEFAULTS = {
  position: 'bottom-left',
  duration: 6000,
  animation: 'slide-left',
  maxVisible: 4,
  customCSS: '',
  types: {
    follow:  { enabled: true, color: '#9b59b6', message: '{user} just followed!',                        sound: '' },
    cheer:   { enabled: true, color: '#ffd60a', message: '{user} cheered {bits} bits!',                  sound: '' },
    sub:     { enabled: true, color: '#ff2d78', message: '{user} subscribed! ({tier})',                  sound: '' },
    resub:   { enabled: true, color: '#0ee5ff', message: '{user} resubbed for {months} months! ({tier})', sound: '' },
    giftsub: { enabled: true, color: '#ff9f0a', message: '{user} gifted {count} subs! ({tier})',          sound: '' }
  }
};

function getAlertCustomConfig() {
  try {
    const raw = process.env.ALERT_CUSTOM_CONFIG;
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

app.get('/api/alerts/config', (req, res) => {
  res.json({
    mode: process.env.ALERT_MODE || 'browser_source',
    obsSource: process.env.ALERT_OBS_SOURCE || '',
    obsDuration: parseInt(process.env.ALERT_OBS_DURATION) || 5000,
    browserSourceUrl: `http://localhost:${PORT}/alerts`,
    custom: getAlertCustomConfig() || ALERT_CUSTOM_DEFAULTS
  });
});

app.post('/api/alerts/config', (req, res) => {
  const { mode, obsSource, obsDuration, custom } = req.body;
  const validModes = ['browser_source', 'obs_websocket', 'both', 'disabled'];
  if (mode && validModes.includes(mode)) process.env.ALERT_MODE = mode;
  if (typeof obsSource === 'string') process.env.ALERT_OBS_SOURCE = obsSource;
  if (obsDuration != null && !isNaN(parseInt(obsDuration))) process.env.ALERT_OBS_DURATION = String(parseInt(obsDuration));
  if (custom && typeof custom === 'object') process.env.ALERT_CUSTOM_CONFIG = JSON.stringify(custom);
  persistSettings();
  broadcast({ event: 'alerts_config_update', mode: process.env.ALERT_MODE, obsSource: process.env.ALERT_OBS_SOURCE, obsDuration: parseInt(process.env.ALERT_OBS_DURATION) || 5000 });
  broadcast({ event: 'overlay_config_update', scope: 'alerts' });
  addLog('system', 'settings', `Alert config updated — mode: ${process.env.ALERT_MODE}`);
  res.json({ ok: true });
});

app.post('/api/alerts/test', async (req, res) => {
  const type = req.body.type || 'follow';
  const testData = {
    follow:   { type: 'follow', user: 'TestUser' },
    cheer:    { type: 'cheer',  user: 'TestUser', bits: 100, message: 'PogChamp!' },
    sub:      { type: 'sub',    user: 'TestUser', tier: 'Tier 1' },
    resub:    { type: 'resub',  user: 'TestUser', tier: 'Tier 1', months: 6, message: 'Love the stream!' },
    giftsub:  { type: 'giftsub', user: 'TestUser', count: 5, tier: 'Tier 1' }
  };
  const payload = testData[type] || testData.follow;
  await triggerAlert(payload);
  addLog('system', 'alert', `Test alert sent: ${type}`);
  res.json({ ok: true });
});


// --- Event Triggers ---
const EVENT_TRIGGER_DEFAULTS = {
  follow:  { enabled: false, response: 'Welcome {user}, thanks for the follow! \u{1F49C}', sound: '', script: '' },
  cheer:   { enabled: false, response: 'Thanks for the {bits} bits, {user}! ⚡',       sound: '', script: '' },
  sub:     { enabled: false, response: 'Welcome to the squad, {user}! ⭐',             sound: '', script: '' },
  resub:   { enabled: false, response: '{user} has been subscribed for {months} months! \u{1F501}', sound: '', script: '' },
  giftsub: { enabled: false, response: '{user} just gifted {count} subs! \u{1F381}',       sound: '', script: '' }
};

function getEventTriggers() {
  try {
    const raw = process.env.EVENT_TRIGGERS;
    if (raw) {
      const parsed = JSON.parse(raw);
      const out = {};
      for (const [type, def] of Object.entries(EVENT_TRIGGER_DEFAULTS)) {
        out[type] = Object.assign({}, def, parsed[type] || {});
      }
      return out;
    }
  } catch {}
  return JSON.parse(JSON.stringify(EVENT_TRIGGER_DEFAULTS));
}

async function fireTrigger(type, vars) {
  // Alert TTS — fires independently of whether the event trigger itself is enabled
  if (process.env.TTS_ENABLED === 'true' && process.env.TTS_ALERTS_ENABLED === 'true') {
    const alertTypes = (process.env.TTS_ALERT_TYPES || 'follow,cheer,sub,resub,giftsub').split(',').map(s => s.trim());
    if (alertTypes.includes(type)) {
      const ttsMessages = {
        follow:  `${vars.user} just followed!`,
        cheer:   `${vars.user} cheered ${vars.bits} bits!`,
        sub:     `${vars.user} just subscribed!`,
        resub:   `${vars.user} resubscribed for ${vars.months} months!`,
        giftsub: `${vars.user} gifted ${vars.count} subs!`,
      };
      speakTTS(ttsMessages[type] || type);
    }
  }

  const triggers = getEventTriggers();
  const t = triggers[type];
  if (!t || !t.enabled) return;
  if (t.response && t.response.trim()) {
    const msg = t.response
      .replace(/\{user\}/g,    vars.user    ?? '')
      .replace(/\{bits\}/g,    String(vars.bits    ?? ''))
      .replace(/\{months\}/g,  String(vars.months  ?? ''))
      .replace(/\{count\}/g,   String(vars.count   ?? ''))
      .replace(/\{tier\}/g,    vars.tier    ?? '')
      .replace(/\{message\}/g, vars.message ?? '');
    await sendChatMessage(msg).catch(err =>
      addLog('system', 'trigger', `Chat response failed for ${type}: ${err.message}`, false)
    );
  }
  if (t.sound && t.sound.trim()) {
    await cmdSound('trigger', t.sound.trim()).catch(err =>
      addLog('system', 'trigger', `Sound failed for ${type}: ${err.message}`, false)
    );
  }
  if (t.script && t.script.trim()) {
    try {
      const allowlist = (process.env.SCRIPT_ALLOWLIST || '').split(',').map(s => s.trim()).filter(Boolean);
      const { execFile } = require('child_process');
      const path = require('path');
      const scriptPath = path.resolve(t.script.trim());
      const scriptDir  = path.dirname(scriptPath);
      if (!allowlist.some(a => scriptPath.startsWith(path.resolve(a)))) {
        addLog('system', 'trigger', `Script blocked (not allowlisted): ${scriptPath}`, false);
        return;
      }
      const args = [type, vars.user ?? '', String(vars.bits ?? ''), String(vars.months ?? ''), String(vars.count ?? ''), vars.tier ?? ''];
      execFile(scriptPath, args, { cwd: scriptDir, timeout: 10000 }, (err, stdout) => {
        if (err) addLog('system', 'trigger', `Script error (${type}): ${err.message}`, false);
        else if (stdout.trim()) addLog('system', 'trigger', `Script output (${type}): ${stdout.trim()}`);
      });
    } catch (err) {
      addLog('system', 'trigger', `Script launch failed (${type}): ${err.message}`, false);
    }
  }
}

app.get('/api/triggers', (req, res) => {
  res.json({ triggers: getEventTriggers() });
});

app.post('/api/dev/reset', (req, res) => {
  const fs = require('fs');
  // Clear all known keys from process.env
  [...PERSIST_KEYS, ...SETTINGS_KEYS].forEach(k => delete process.env[k]);
  // Wipe the .env file
  try { fs.writeFileSync(dotenvPath, '', 'utf8'); } catch {}
  addLog('system', 'dev', 'All settings wiped — restart or re-enter credentials to reconnect.');
  res.json({ ok: true });
});

app.post('/api/triggers/test', async (req, res) => {
  const type = req.body.type;
  const testVars = {
    follow:  { user: 'TestUser' },
    cheer:   { user: 'TestUser', bits: 100,  message: 'PogChamp!' },
    sub:     { user: 'TestUser', tier: 'Tier 1' },
    resub:   { user: 'TestUser', tier: 'Tier 1', months: 6, message: 'Love the stream!' },
    giftsub: { user: 'TestUser', count: 5, tier: 'Tier 1' },
  };
  if (!testVars[type]) return res.status(400).json({ error: 'Unknown trigger type' });
  await fireTrigger(type, testVars[type]);
  addLog('system', 'trigger', `Test trigger fired: ${type}`);
  res.json({ ok: true });
});

app.post('/api/triggers', (req, res) => {
  const { triggers } = req.body;
  if (!triggers || typeof triggers !== 'object') return res.status(400).json({ error: 'Invalid' });
  const current = getEventTriggers();
  for (const [type, val] of Object.entries(triggers)) {
    if (!current[type]) continue;
    if (typeof val.enabled  === 'boolean') current[type].enabled  = val.enabled;
    if (typeof val.response === 'string')  current[type].response = val.response;
    if (typeof val.sound    === 'string')  current[type].sound    = val.sound;
    if (typeof val.script   === 'string')  current[type].script   = val.script;
  }
  process.env.EVENT_TRIGGERS = JSON.stringify(current);
  persistSettings();
  addLog('system', 'settings', 'Event triggers updated');
  res.json({ ok: true });
});

app.get('/api/redeems', (req, res) => res.json({ redeems: state.redeemActions }));
app.post('/api/redeems', (req, res) => {
  const { redeems } = req.body;
  if (typeof redeems !== 'object') return res.status(400).json({ error: 'Invalid' });
  state.redeemActions = redeems;
  process.env.REDEEM_ACTIONS = JSON.stringify(redeems);
  persistSettings();
  addLog('system', 'settings', 'Redeem actions updated');
  res.json({ ok: true });
});

// --- OBS Control API ---
app.get('/api/obs/scenes', async (req, res) => {
  if (!state.obs.connected) return res.status(503).json({ error: 'OBS not connected' });
  try {
    const { scenes, currentProgramSceneName } = await obs.call('GetSceneList');
    res.json({ scenes: scenes.map(s => s.sceneName).reverse(), current: currentProgramSceneName });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/obs/scene', async (req, res) => {
  if (!state.obs.connected) return res.status(503).json({ error: 'OBS not connected' });
  const { scene } = req.body;
  if (!scene) return res.status(400).json({ error: 'scene required' });
  try {
    await obs.call('SetCurrentProgramScene', { sceneName: scene });
    broadcast({ event: 'obs_scene', scene });
    addLog('obs', 'scene', `Switched to "${scene}"`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/obs/sources', async (req, res) => {
  if (!state.obs.connected) return res.status(503).json({ error: 'OBS not connected' });
  try {
    const { scenes, currentProgramSceneName } = await obs.call('GetSceneList');
    const scene = scenes.find(s => s.sceneName === currentProgramSceneName) || scenes[scenes.length - 1];
    if (!scene) return res.json({ sources: [], scene: null });
    const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: scene.sceneName });
    res.json({
      scene: scene.sceneName,
      sources: sceneItems.map(i => ({ id: i.sceneItemId, name: i.sourceName, enabled: i.sceneItemEnabled }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/obs/source', async (req, res) => {
  if (!state.obs.connected) return res.status(503).json({ error: 'OBS not connected' });
  const { scene, id, enabled } = req.body;
  if (!scene || id == null) return res.status(400).json({ error: 'scene and id required' });
  try {
    await obs.call('SetSceneItemEnabled', { sceneName: scene, sceneItemId: id, sceneItemEnabled: enabled });
    broadcast({ event: 'obs_source', scene, id, enabled });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/obs/status', async (req, res) => {
  if (!state.obs.connected) return res.status(503).json({ error: 'OBS not connected' });
  try {
    const [streamStatus, recordStatus] = await Promise.all([
      obs.call('GetStreamStatus'),
      obs.call('GetRecordStatus'),
    ]);
    res.json({
      streaming: streamStatus.outputActive,
      streamTime: streamStatus.outputTimecode,
      recording: recordStatus.outputActive,
      recordTime: recordStatus.outputTimecode,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/obs/stream', async (req, res) => {
  if (!state.obs.connected) return res.status(503).json({ error: 'OBS not connected' });
  const { action } = req.body; // 'start' | 'stop' | 'toggle'
  try {
    if (action === 'start')       await obs.call('StartStream');
    else if (action === 'stop')   await obs.call('StopStream');
    else if (action === 'toggle') await obs.call('ToggleStream');
    addLog('obs', 'stream', `Stream ${action}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/obs/record', async (req, res) => {
  if (!state.obs.connected) return res.status(503).json({ error: 'OBS not connected' });
  const { action } = req.body; // 'start' | 'stop' | 'toggle'
  try {
    if (action === 'start')       await obs.call('StartRecord');
    else if (action === 'stop')   await obs.call('StopRecord');
    else if (action === 'toggle') await obs.call('ToggleRecord');
    addLog('obs', 'record', `Recording ${action}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/commands', (req, res) => res.json({ commands: state.commands }));
app.post('/api/commands', (req, res) => {
  const { commands } = req.body;
  if (typeof commands !== 'object') return res.status(400).json({ error: 'Invalid' });
  for (const [key, val] of Object.entries(commands)) {
    if (state.commands[key]) {
      if (typeof val.enabled === 'boolean') state.commands[key].enabled = val.enabled;
      if (PERMISSION_LEVELS.includes(val.permission)) state.commands[key].permission = val.permission;
      if (Array.isArray(val.sources)) state.commands[key].sources = val.sources;
      if (typeof val.response === 'string') state.commands[key].response = val.response;
    }
  }
  process.env.COMMANDS_CONFIG = JSON.stringify(state.commands);
  persistSettings();
  broadcast({ event: 'commands_update', commands: state.commands });
  relayClient.commandsChanged();
  addLog('system', 'settings', 'Command config updated');
  res.json({ ok: true });
});

app.get('/api/custom-commands', (req, res) => res.json({ commands: state.customCommands }));
app.post('/api/custom-commands', (req, res) => {
  const { commands } = req.body;
  if (typeof commands !== 'object') return res.status(400).json({ error: 'Invalid' });
  state.customCommands = {};
  for (const [key, val] of Object.entries(commands)) {
    const name = key.toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!name) continue;
    const match = ['command','contains','starts'].includes(val.match) ? val.match : 'command';
    state.customCommands[name] = {
      enabled:    typeof val.enabled === 'boolean' ? val.enabled : true,
      permission: PERMISSION_LEVELS.includes(val.permission) ? val.permission : 'everyone',
      sources:    Array.isArray(val.sources) ? val.sources : ['chat'],
      response:   typeof val.response === 'string' ? val.response : '',
      description: typeof val.description === 'string' ? val.description : '',
      match,
      trigger:    match !== 'command' && typeof val.trigger === 'string' ? val.trigger : '',
    };
  }
  process.env.CUSTOM_COMMANDS = JSON.stringify(state.customCommands);
  persistSettings();
  broadcast({ event: 'custom_commands_update', commands: state.customCommands });
  relayClient.commandsChanged();
  addLog('system', 'settings', 'Custom commands updated');
  res.json({ ok: true });
});

// --- Plugin API ---
app.get('/api/plugins', (req, res) => {
  const plugins = Array.from(loadedPlugins.values()).map(({ manifest, filePath, enabled }) => ({
    id:          manifest.id,
    name:        manifest.name,
    version:     manifest.version  || '1.0.0',
    description: manifest.description || '',
    author:      manifest.author   || '',
    panel:       manifest.panel    || null,
    enabled,
    file:        require('path').basename(filePath)
  }));
  res.json({ plugins });
});

app.post('/api/plugins/:id/toggle', (req, res) => {
  const entry = loadedPlugins.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Plugin not found' });
  entry.enabled = !entry.enabled;
  pluginStore[`__enabled_${req.params.id}`] = entry.enabled;
  savePluginStore();
  // Remove commands registered by this plugin then reload
  for (const [cmd, cfg] of Object.entries(state.pluginCommands)) {
    if (cfg.pluginId === req.params.id) delete state.pluginCommands[cmd];
  }
  pluginEvents.removeAllListeners();
  loadPlugin(entry.filePath);
  broadcast({ event: 'plugins_update' });
  res.json({ ok: true, enabled: entry.enabled });
});

app.post('/api/plugins/upload', (req, res) => {
  const { filename, content } = req.body;
  if (!filename || !content) return res.status(400).json({ error: 'Missing filename or content' });
  if (!filename.endsWith('.js')) return res.status(400).json({ error: 'Only .js files are allowed' });
  const safeName = require('path').basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = require('path').join(PLUGINS_DIR, safeName);
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    const manifest = loadPlugin(filePath);
    if (!manifest) { fs.unlinkSync(filePath); return res.status(400).json({ error: 'Plugin failed to load — check format' }); }
    broadcast({ event: 'plugins_update' });
    res.json({ ok: true, id: manifest.id, name: manifest.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/plugins/:id', (req, res) => {
  const entry = loadedPlugins.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Plugin not found' });
  try { fs.unlinkSync(entry.filePath); } catch {}
  for (const [cmd, cfg] of Object.entries(state.pluginCommands)) {
    if (cfg.pluginId === req.params.id) delete state.pluginCommands[cmd];
  }
  loadedPlugins.delete(req.params.id);
  delete pluginStore[req.params.id];
  delete pluginStore[`__enabled_${req.params.id}`];
  savePluginStore();
  pluginEvents.removeAllListeners();
  // Re-register remaining enabled plugins' events
  for (const { manifest, filePath, enabled } of loadedPlugins.values()) {
    if (enabled) { try { const m = require(filePath); m.register(createPluginApi(manifest.id)); } catch {} }
  }
  broadcast({ event: 'plugins_update' });
  addLog('plugin', 'unload', `Removed: ${entry.manifest.name}`);
  res.json({ ok: true });
});

app.get('/api/state', (req, res) => res.json({
  obs: state.obs, jellyfin: state.jellyfin, twitch: state.twitch, log: state.log,
  mediaMode: process.env.MEDIA_CONTROL_MODE || 'os',
  srMode: process.env.SONG_REQUEST_MODE || 'chat',
  srRedeemName: process.env.SONG_REQUEST_REDEEM_NAME || '',
  srEnabled: process.env.SONG_REQUEST_ENABLED !== 'false'
}));

const SETTINGS_KEYS = [
  'JELLYFIN_URL','JELLYFIN_API_KEY','JELLYFIN_USERNAME','JELLYFIN_PASSWORD','JELLYFIN_DEVICE_ID',
  'OBS_HOST','OBS_PORT','OBS_PASSWORD','LISTENER_PORT','MOD_PORT','MOD_ENABLED','SCRIPT_ALLOWLIST','TWITCH_CLIENT_ID',
  'TWITCH_CLIENT_SECRET','MEDIA_CONTROL_MODE','CIDER_TOKEN','SONG_REQUEST_MODE','SONG_REQUEST_REDEEM_NAME',
  'SONG_REQUEST_ENABLED','SONG_REQUEST_APPROVAL','SONG_REQUEST_FILTERS','CIDER_STOREFRONT','MOD_TOKEN',
  'TWITCH_BOT_USERNAME','TWITCH_BOT_OAUTH','TWITCH_OAUTH','TWITCH_CHANNEL',
  'ALERT_MODE','ALERT_OBS_SOURCE','ALERT_OBS_DURATION','OVERLAYS_ENABLED','NOWPLAYING_CONFIG','OVERLAY_MODE',
  'SEVENTV_ENABLED','BTTV_ENABLED',
  'SPOTIFY_CLIENT_ID','SPOTIFY_ACCESS_TOKEN','SPOTIFY_REFRESH_TOKEN','SPOTIFY_TOKEN_EXPIRY',
  'TTS_ENABLED','TTS_VOICE','TTS_RATE',
  'TTS_CHAT_ENABLED','TTS_CHAT_PERMISSION','TTS_CHAT_SAY_NAME','TTS_CHAT_MAX_LENGTH',
  'TTS_BITS_THRESHOLD',
  'TTS_REDEMPTIONS_ENABLED','TTS_REDEMPTION_NAMES',
  'TTS_ALERTS_ENABLED','TTS_ALERT_TYPES',
  'RELAY_ENABLED','RELAY_URL','RELAY_DEFER_COMMANDS',
];

app.get('/settings', (req, res) => {
  const settings = {};
  for (const key of SETTINGS_KEYS) {
    if (process.env[key] !== undefined) settings[key] = process.env[key];
  }
  res.json(settings);
});

app.post('/settings', (req, res) => {
  const allowed = SETTINGS_KEYS;
  const updated = []; // keys whose value actually changed
  for (const [key, value] of Object.entries(req.body)) {
    if (!allowed.includes(key)) continue;
    const current = process.env[key] ?? '';
    if (current !== value) {
      process.env[key] = value;
      updated.push(key);
    }
  }
  if (updated.length) addLog('system', 'settings', `Changed: ${updated.join(', ')}`);
  if (updated.some(k => k.startsWith('OBS_'))) {
    state.obs.connected = false; state.obs.reconnecting = false;
    obs.disconnect().catch(() => {}); setTimeout(connectOBS, 500);
  }
  if (updated.some(k => k.startsWith('JELLYFIN_'))) {
    state.jellyfin.connected = false; jellyfinToken = null; jellyfinUserId = null; jellyfinBaseUrl = null;
    checkJellyfinConnection();
  }
  if (updated.some(k => k.startsWith('TWITCH_'))) {
    twitchAuthFailed = false;  // clear auth-failure latch so reconnect is allowed with new credentials
    if (twitchWs) { twitchWs.removeAllListeners(); twitchWs.terminate(); twitchWs = null; }
    if (twitchKeepaliveTimer) { clearTimeout(twitchKeepaliveTimer); twitchKeepaliveTimer = null; }
    if (process.env.TWITCH_OAUTH) setTimeout(connectTwitchEventSub, 500);
  }
  if (updated.some(k => k === 'SEVENTV_ENABLED' || k === 'BTTV_ENABLED')) {
    // Bust the emote cache so the next overlay fetch picks up the new setting
    sevenTvCacheTime           = 0;
    sevenTvCacheHadBroadcaster = false;
  }
  if (updated.includes('MEDIA_CONTROL_MODE')) nowPlayingStartPolling();
  if (updated.some(k => k.startsWith('RELAY_'))) relayClient.reload();
  if (updated.includes('MOD_ENABLED') || updated.includes('MOD_PORT')) {
    const enabled = process.env.MOD_ENABLED !== 'false';
    if (!enabled && modServer.listening) {
      modWss.clients.forEach(c => c.terminate());
      modServer.close(() => addLog('system', 'mod', 'Mod server stopped'));
    } else if (enabled && !modServer.listening) {
      const port = parseInt(process.env.MOD_PORT) || MOD_PORT;
      modServer.listen(port, () => addLog('system', 'mod', `Mod server started on port ${port}`));
    }
  }
  if (updated.length) persistSettings();
  res.json({ ok: true, updated });
});

wss.on('connection', (ws) => {
  // Whatever is playing right now, so a source that connected mid-song is not
  // blank until the next track change.
  ws.send(JSON.stringify(nowPlayingPayload(nowPlayingCurrent)));
  ws.send(JSON.stringify({
    event: 'init',
    obs: state.obs, jellyfin: state.jellyfin, twitch: state.twitch, log: state.log,
    mediaMode: process.env.MEDIA_CONTROL_MODE || 'os',
    srMode: process.env.SONG_REQUEST_MODE || 'chat',
    srRedeemName: process.env.SONG_REQUEST_REDEEM_NAME || '',
    srEnabled: process.env.SONG_REQUEST_ENABLED !== 'false',
    queue: state.queue, wishlist: state.wishlist,
    commands: state.commands,
    customCommands: state.customCommands,
    relay: relayClient.status(),
    plugins: Array.from(loadedPlugins.values()).map(({ manifest, enabled }) => ({
      id: manifest.id, name: manifest.name, version: manifest.version || '1.0.0',
      description: manifest.description || '', author: manifest.author || '',
      panel: manifest.panel || null, enabled
    })),
    alertMode: process.env.ALERT_MODE || 'browser_source',
    alertObsSource: process.env.ALERT_OBS_SOURCE || '',
    alertObsDuration: parseInt(process.env.ALERT_OBS_DURATION) || 5000,
    alertBrowserSourceUrl: `http://localhost:${PORT}/alerts`,
    devMode: DEV_MODE,
    botUsername: process.env.TWITCH_BOT_USERNAME || '',
  }));

  // Handle incoming commands from WebSocket clients (e.g. Macro Deck plugin)
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg.action) return;

    try {
      switch (msg.action) {
        case 'obs_scene':
          if (msg.scene && state.obs.connected) {
            await obs.call('SetCurrentProgramScene', { sceneName: msg.scene });
            broadcast({ event: 'obs_scene', scene: msg.scene });
            addLog('obs', 'ws:scene', `Switched to "${msg.scene}"`);
          }
          break;
        case 'obs_stream':
          if (state.obs.connected) {
            if (msg.start === true)       await obs.call('StartStream');
            else if (msg.start === false) await obs.call('StopStream');
            else                          await obs.call('ToggleStream');
            addLog('obs', 'ws:stream', msg.start != null ? (msg.start ? 'started' : 'stopped') : 'toggled');
          }
          break;
        case 'obs_record':
          if (state.obs.connected) {
            if (msg.start === true)       await obs.call('StartRecord');
            else if (msg.start === false) await obs.call('StopRecord');
            else                          await obs.call('ToggleRecord');
            addLog('obs', 'ws:record', msg.start != null ? (msg.start ? 'started' : 'stopped') : 'toggled');
          }
          break;
        case 'obs_source':
          if (state.obs.connected && msg.scene && msg.id != null) {
            await obs.call('SetSceneItemEnabled', { sceneName: msg.scene, sceneItemId: msg.id, sceneItemEnabled: !!msg.enabled });
            broadcast({ event: 'obs_source', scene: msg.scene, id: msg.id, enabled: !!msg.enabled });
          }
          break;
        case 'chat_send':
          if (msg.text) await sendChatMessage(msg.text, msg.sender || 'auto');
          break;
        case 'command': {
          // Execute any built-in or custom command as broadcaster, bypassing chat
          const fakeEvent = { badges: [{ set_id: 'broadcaster' }] };
          const text = `!${(msg.cmd || '').replace(/^!/, '')}${msg.args ? ' ' + msg.args : ''}`;
          await dispatchCommand(fakeEvent, 'chat', msg.user || 'MacroDeck', text);
          break;
        }
        default:
          break;
      }
    } catch (err) {
      addLog('system', 'ws:cmd', `Error handling "${msg.action}": ${err.message}`, false);
    }
  });
});

// --- Twitch OAuth flow ---
// Uses Authorization Code + PKCE flow (no client secret needed).
// A built-in Client ID is baked in; users can override it in Advanced settings.
//
// Redirect URIs to register in dev.twitch.tv:
//   http://localhost:3773/twitch/auth/callback  ← dedicated auth port (primary)
//   http://localhost:3000/twitch/auth/callback  ← fallbacks (in case port 3773 is blocked)
//   http://localhost:3001/twitch/auth/callback
//   http://localhost:3002/twitch/auth/callback
//
// Flow:
//   1. POST /twitch/auth/start (or /bot/start) → opens system browser
//   2. Twitch redirects to GET /twitch/auth/callback?code=xxx&state=xxx
//   3. Server exchanges code → token via PKCE (no secret required)
//   4. Server fetches username, auto-saves channel / bot-username, broadcasts via WebSocket
//   5. Dashboard updates status and saves tokens

const TWITCH_SCOPES = [
  'user:read:chat',
  'user:write:chat',
  'channel:bot',
  'channel:read:redemptions',
  'user:read:whispers',
  'whispers:read',
  'moderator:read:chat_messages',
  'moderator:read:followers',
  'bits:read',
  'channel:read:subscriptions'
].join(' ');

const TWITCH_BOT_SCOPES = 'user:write:chat';

// Dedicated auth port — always used as the primary redirect URI.
// Falls back to LISTENER_PORT if this port can't be bound.
const AUTH_PORT = 3773;
let authServerPort = null;

// Pending flows keyed by state token: { type, clientId, redirectUri, pkceVerifier, expiresAt }
const pendingOAuthFlows = new Map();

// Clean up expired flows every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pendingOAuthFlows) {
    if (val.expiresAt < now) pendingOAuthFlows.delete(key);
  }
}, 600000);

function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}
function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function openBrowser(url) {
  const { exec } = require('child_process');
  const platform = require('os').platform();
  const safe = url.replace(/"/g, '\\"');
  const cmd = platform === 'win32' ? `start "" "${safe}"` :
              platform === 'darwin' ? `open "${safe}"` : `xdg-open "${safe}"`;
  exec(cmd, (err) => {
    if (err) addLog('system', 'twitch', `Could not open browser: ${err.message}`, false);
  });
}

function getRedirectUri() {
  // Prefer the dedicated auth port; fall back to the main app port if auth server didn't start.
  const port = authServerPort || process.env.LISTENER_PORT || PORT;
  return `http://localhost:${port}/twitch/auth/callback`;
}

function startOAuthFlow(clientId, scopes, flowType, res) {
  const redirectUri = getRedirectUri();
  const stateToken = crypto.randomBytes(16).toString('hex');
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;

  const flow = { type: flowType, clientId, redirectUri, expiresAt: Date.now() + 600000 };

  const params = {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes,
    state: stateToken
  };

  if (!clientSecret) {
    // No secret — use PKCE (always the case for the built-in client ID)
    flow.pkceVerifier = generateCodeVerifier();
    params.code_challenge = generateCodeChallenge(flow.pkceVerifier);
    params.code_challenge_method = 'S256';
  }

  pendingOAuthFlows.set(stateToken, flow);

  const authUrl = `https://id.twitch.tv/oauth2/authorize?` + new URLSearchParams(params);
  // Open the system browser on behalf of the user (desktop installs)
  openBrowser(authUrl);
  addLog('system', 'twitch', `OAuth: opened browser (${flowType})`);
  // Also return authUrl so the frontend can show a fallback link
  res.json({ ok: true, redirectUri, authUrl });
}

app.get('/twitch/auth/info', (req, res) => {
  res.json({ redirectUri: getRedirectUri() });
});

app.post('/twitch/auth/start', (req, res) => {
  startOAuthFlow(getEffectiveClientId(), TWITCH_SCOPES, 'broadcaster', res);
});

app.post('/twitch/auth/bot/start', (req, res) => {
  startOAuthFlow(getEffectiveClientId(), TWITCH_BOT_SCOPES, 'bot', res);
});

// Shared OAuth callback handler — mounted on both the main app and the dedicated auth server
async function handleOAuthCallback(req, res) {
  const pageStyle = `<style>
    body { font-family: -apple-system, sans-serif; background: #111113; color: #f5f5f7;
           display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #1c1c1e; border: 1px solid #3a3a3c; border-radius: 12px;
            padding: 28px 36px; text-align: center; max-width: 420px; }
    h2 { margin: 0 0 8px; font-size: 18px; }
    p  { margin: 0; font-size: 13px; color: #aeaeb2; }
    .ok   { color: #32d74b; font-size: 32px; }
    .fail { color: #ff453a; font-size: 32px; }
  </style>`;

  function page(icon, title, msg) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Cha0s Stream</title>${pageStyle}</head>
      <body><div class="card"><div>${icon}</div><h2>${title}</h2><p>${msg}</p></div></body></html>`;
  }

  const { code, state, error, error_description } = req.query;

  if (error) {
    addLog('system', 'twitch', `OAuth denied: ${error}`, false);
    return res.send(page('❌', 'Authorization cancelled', error_description || error));
  }
  if (!code || !state) {
    return res.send(page('❌', 'Missing parameters', 'No code or state in the redirect. Please try again.'));
  }

  const flow = pendingOAuthFlows.get(state);
  if (!flow) {
    return res.send(page('❌', 'Session expired', 'This authorization link has expired. Please try again from the app.'));
  }
  if (flow.expiresAt < Date.now()) {
    pendingOAuthFlows.delete(state);
    return res.send(page('❌', 'Session expired', 'The authorization timed out. Please try again.'));
  }
  pendingOAuthFlows.delete(state);

  try {
    const clientSecret = process.env.TWITCH_CLIENT_SECRET;
    const bodyParams = new URLSearchParams({
      client_id: flow.clientId,
      code,
      grant_type: 'authorization_code',
      redirect_uri: flow.redirectUri
    });
    if (clientSecret) {
      bodyParams.set('client_secret', clientSecret);
    } else if (flow.pkceVerifier) {
      bodyParams.set('code_verifier', flow.pkceVerifier);
    }

    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: bodyParams
    });
    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.access_token) {
      const msg = tokenData.message || `HTTP ${tokenRes.status}`;
      addLog('system', 'twitch', `OAuth token exchange failed: ${msg}`, false);
      return res.send(page('❌', 'Token exchange failed', msg + '<br><br>Check your Client ID in Advanced settings.'));
    }

    // Fetch the username for the account that just authorized
    let username = '';
    try {
      const userRes = await fetch('https://api.twitch.tv/helix/users', {
        headers: {
          'Authorization': `Bearer ${tokenData.access_token}`,
          'Client-Id': flow.clientId
        }
      });
      if (userRes.ok) {
        const userData = await userRes.json();
        username = userData.data?.[0]?.login || '';
      }
    } catch {}

    const oauthToken = `oauth:${tokenData.access_token}`;

    if (flow.type === 'bot') {
      process.env.TWITCH_BOT_OAUTH = oauthToken;
      if (username) { process.env.TWITCH_BOT_USERNAME = username; }
      persistSettings();
      addLog('system', 'twitch', `Bot OAuth token acquired${username ? ` (${username})` : ''}`);
      broadcast({ event: 'oauth_bot_token', token: oauthToken, username });
      res.send(page('✅', 'Bot authorized!', `Logged in as <strong>${username || 'unknown'}</strong>. You can close this tab.`));
    } else {
      process.env.TWITCH_OAUTH = oauthToken;
      if (username) { process.env.TWITCH_CHANNEL = username; }
      persistSettings();
      addLog('system', 'twitch', `OAuth token acquired${username ? ` (${username})` : ''}`);
      broadcast({ event: 'oauth_token', token: oauthToken, username });
      // Reconnect EventSub with the fresh token
      if (twitchWs) { twitchWs.removeAllListeners(); twitchWs.terminate(); twitchWs = null; }
      if (twitchKeepaliveTimer) { clearTimeout(twitchKeepaliveTimer); twitchKeepaliveTimer = null; }
      setTimeout(connectTwitchEventSub, 500);
      res.send(page('✅', 'Authorized!', `Logged in as <strong>${username || 'unknown'}</strong>. You can close this tab.`));
    }
  } catch (err) {
    addLog('system', 'twitch', `OAuth callback error: ${err.message}`, false);
    res.send(page('❌', 'Error', err.message));
  }
}

// Mount callback on main app (handles fallback ports 3000–3002 for browser usage)
app.get('/twitch/auth/callback', handleOAuthCallback);

// --- Spotify OAuth routes ---
app.get('/api/spotify/auth', (req, res) => {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  if (!clientId) return res.status(400).send('SPOTIFY_CLIENT_ID not set. Add it in Settings → Spotify.');
  const redirectUri = `http://localhost:${PORT}/api/spotify/callback`;
  const params = new URLSearchParams({
    client_id:     clientId,
    response_type: 'code',
    redirect_uri:  redirectUri,
    scope:         SPOTIFY_SCOPES,
    show_dialog:   'true',
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

app.get('/api/spotify/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.send(`<script>window.close()</script>Spotify auth failed: ${error || 'no code'}`);
  const clientId    = process.env.SPOTIFY_CLIENT_ID;
  const redirectUri = `http://localhost:${PORT}/api/spotify/callback`;
  try {
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri:  redirectUri,
        client_id:     clientId,
      }),
    });
    const data = await tokenRes.json();
    if (!data.access_token) throw new Error(data.error_description || 'Token exchange failed');
    process.env.SPOTIFY_ACCESS_TOKEN  = data.access_token;
    process.env.SPOTIFY_REFRESH_TOKEN = data.refresh_token;
    process.env.SPOTIFY_TOKEN_EXPIRY  = String(Date.now() + (data.expires_in - 60) * 1000);
    persistSettings();
    broadcast({ event: 'spotify_connected' });
    addLog('system', 'spotify', 'Spotify connected');
    if (mediaMode() === 'spotify') nowPlayingStartPolling();
    res.send('<html><body style="font-family:sans-serif;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><h2>✓ Spotify connected! You can close this tab.</h2></body></html>');
  } catch (err) {
    res.send(`<script>window.close()</script>Error: ${err.message}`);
  }
});

/**
 * Forget a connected account.
 *
 * Clears the stored credentials and tears down whatever they were driving.
 * Only the token is dropped - channel and bot username are left alone, since
 * they are also plain settings a user may have typed themselves.
 */
app.post('/api/twitch/disconnect/:which', (req, res) => {
  const which = req.params.which;
  if (which === 'broadcaster') {
    process.env.TWITCH_OAUTH = '';
    persistSettings();
    // Drop the socket rather than waiting for Twitch to reject the dead token.
    if (twitchWs) { twitchWs.removeAllListeners(); twitchWs.terminate(); twitchWs = null; }
    if (twitchKeepaliveTimer) { clearTimeout(twitchKeepaliveTimer); twitchKeepaliveTimer = null; }
    state.twitch.connected = false;
    broadcast({ event: 'status', service: 'twitch', connected: false, paused: false });
    broadcast({ event: 'twitch_disconnected', which });
    addLog('system', 'twitch', 'Broadcaster account disconnected');
  } else if (which === 'bot') {
    // The bot is only ever a sender; nothing is subscribed on its behalf, so
    // there is no socket to tear down. sendChatMessage falls back to the
    // broadcaster on its own once these are empty.
    process.env.TWITCH_BOT_OAUTH = '';
    process.env.TWITCH_BOT_USERNAME = '';
    persistSettings();
    broadcast({ event: 'twitch_disconnected', which });
    addLog('system', 'twitch', 'Bot account disconnected — messages will send as the broadcaster');
  } else {
    return res.status(400).json({ error: 'Unknown account' });
  }
  res.json({ ok: true });
});

app.post('/api/cider/disconnect', (req, res) => {
  process.env.CIDER_TOKEN = '';
  persistSettings();
  if (mediaMode() === 'cider') nowPlayingStopPolling();
  addLog('system', 'cider', 'Cider token cleared');
  res.json({ ok: true });
});

app.post('/api/spotify/disconnect', (req, res) => {
  process.env.SPOTIFY_ACCESS_TOKEN  = '';
  process.env.SPOTIFY_REFRESH_TOKEN = '';
  process.env.SPOTIFY_TOKEN_EXPIRY  = '';
  persistSettings();
  if (mediaMode() === 'spotify') nowPlayingStopPolling();
  broadcast({ event: 'spotify_disconnected' });
  addLog('system', 'spotify', 'Spotify disconnected');
  res.json({ ok: true });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Exit 0 on purpose. electron/main.js restarts the listener on any non-zero
    // exit, so throwing here produced an unhandled 'error', a stack trace, and
    // a re-fork every 3 seconds forever - against a port that was never going
    // to free up. The usual cause is a second copy of the app already running.
    console.error(`Port ${PORT} is already in use. Another copy of Cha0s Stream is probably running - close it, or change the listener port in Settings.`);
    process.exit(0);
  }
  console.error(`Listener server error: ${err.message}`);
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`Listener running on http://localhost:${PORT}`);
  nowPlayingStartPolling();
});

// --- Dedicated OAuth auth server (port 3773) ---
// Skipped when running inside Electron — main.js owns the OAuth flow there and
// spins up its own one-time server on port 3773 per-auth-attempt, which is far
// more reliable than a persistent server that can be lost on listener restarts.
if (!process.env.ELECTRON_MODE) {
  const authApp = express();
  const authServer = http.createServer(authApp);
  authApp.get('/twitch/auth/callback', handleOAuthCallback);
  authServer.listen(AUTH_PORT, () => {
    authServerPort = AUTH_PORT;
    console.log(`Auth server running on http://localhost:${AUTH_PORT}`);
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Auth port ${AUTH_PORT} already in use — OAuth will fall back to main app port`);
    }
  });
}

// --- Mod server ---
const modApp = express();
modApp.use(express.json());

// --- Mod queue auth ---
// This page is documented as something you share with mods over Tailscale or a
// Cloudflare Tunnel, and it binds every interface - so it has never been merely
// local. It carried no authentication at all, while its socket accepts a
// `command` action that dispatches with broadcaster badges. Anyone who reached
// the port could switch scenes, stop the stream, or talk in chat as the
// broadcaster.
//
// A shared token is the smallest thing that closes that. It is generated on
// first use and travels in the URL, because the people using this are opening a
// link on a phone, not typing headers.
function modToken() {
  if (!process.env.MOD_TOKEN) {
    process.env.MOD_TOKEN = crypto.randomBytes(24).toString('hex');
    persistSettings();
    addLog('system', 'mod', 'Generated a mod queue token — re-share the mod URL from Settings');
  }
  return process.env.MOD_TOKEN;
}

/** Constant-time compare, so the token cannot be guessed a character at a time. */
function modTokenValid(given) {
  const want = modToken();
  if (typeof given !== 'string' || given.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want));
}

modApp.use((req, res, next) => {
  const given = req.query.token || req.get('x-mod-token') || '';
  if (modTokenValid(String(given))) return next();
  res.status(401).type('html').send(
    '<body style="font-family:system-ui;background:#111113;color:#f5f5f7;display:flex;align-items:center;'
    + 'justify-content:center;height:100vh;margin:0;text-align:center">'
    + '<div><h2>Not authorised</h2><p style="color:#aeaeb2">Open the mod queue using the full link from '
    + 'the streamer&rsquo;s Settings &rarr; Mod Queue.</p></div></body>');
});

const modServer = http.createServer(modApp);
modWss = new WebSocketServer({ server: modServer, verifyClient: (info, done) => {
  // The upgrade request skips the express middleware above, so it is checked here.
  let token = '';
  try { token = new URL(info.req.url, 'http://x').searchParams.get('token') || ''; } catch {}
  if (modTokenValid(token)) return done(true);
  addLog('system', 'mod', 'Rejected an unauthorised mod queue connection', false);
  done(false, 401, 'Unauthorized');
} });
modWss.on('error', (err) => console.error(`Mod WebSocket server error: ${err.message}`));

modWss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    event: 'init',
    queue: state.queue,
    wishlist: state.wishlist,
    jellyfin: state.jellyfin
  }));
});

modApp.get('/api/queue', (req, res) => res.json({ queue: state.queue, wishlist: state.wishlist }));

modApp.post('/api/queue/:id/approve', async (req, res) => {
  const { status, body } = await approveQueueEntry(req.params.id, 'mod');
  res.status(status).json(body);
});

modApp.post('/api/queue/:id/skip', (req, res) => {
  const { status, body } = skipQueueEntry(req.params.id, 'mod');
  res.status(status).json(body);
});

modApp.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Cha0s Stream — Mod Queue</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #111113; --surface: #1c1c1e; --surface2: #2c2c2e;
    --border: #3a3a3c; --text: #f5f5f7; --text2: #aeaeb2; --text3: #6e6e73;
    --accent: #0a84ff; --green: #32d74b; --red: #ff453a; --yellow: #ffd60a;
    --radius: 12px;
  }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-height: 100vh; }
  header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 14px 20px; display: flex; align-items: center; gap: 10px; position: sticky; top: 0; z-index: 10; }
  header h1 { font-size: 16px; font-weight: 600; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--red); flex-shrink: 0; }
  .dot.live { background: var(--green); }
  .ws-label { font-size: 11px; color: var(--text3); }
  .jellyfin-status { margin-left: auto; font-size: 11px; color: var(--text3); display: flex; align-items: center; gap: 6px; }
  .jellyfin-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--red); }
  .jellyfin-dot.ok { background: var(--green); }
  main { max-width: 640px; margin: 0 auto; padding: 20px 16px; }
  section { margin-bottom: 28px; }
  .section-title { font-size: 11px; font-weight: 600; color: var(--text3); text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 10px; }
  .empty { padding: 20px; text-align: center; font-size: 13px; color: var(--text3); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  .request-item { display: flex; align-items: center; gap: 12px; padding: 13px 14px; border-bottom: 1px solid var(--border); }
  .request-item:last-child { border-bottom: none; }
  .request-item.approved { opacity: 0.45; }
  .request-info { flex: 1; min-width: 0; }
  .request-song { font-size: 14px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .request-meta { font-size: 11px; color: var(--text3); margin-top: 3px; }
  .request-actions { display: flex; gap: 7px; flex-shrink: 0; }
  .btn { border: none; border-radius: 8px; font-size: 12px; font-weight: 600; padding: 7px 14px; cursor: pointer; transition: opacity 0.15s; }
  .btn:active { opacity: 0.7; }
  .btn:disabled { opacity: 0.35; cursor: default; }
  .btn-approve { background: var(--green); color: #000; }
  .btn-deny   { background: var(--surface2); color: var(--text2); border: 1px solid var(--border); }
  .status-badge { font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 20px; flex-shrink: 0; }
  .badge-pending  { background: rgba(255,214,10,0.15); color: var(--yellow); }
  .badge-approved { background: rgba(50,215,75,0.15); color: var(--green); }
  .wishlist-item { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 13px; }
  .wishlist-item:last-child { border-bottom: none; }
  .wishlist-song { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .wishlist-user { font-size: 11px; color: var(--text3); flex-shrink: 0; }
  summary { cursor: pointer; font-size: 11px; font-weight: 600; color: var(--text3); text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 10px; user-select: none; list-style: none; display: flex; align-items: center; gap: 6px; }
  summary::before { content: '▶'; font-size: 9px; transition: transform 0.15s; }
  details[open] summary::before { transform: rotate(90deg); }
</style>
</head>
<body>
<header>
  <div class="dot" id="ws-dot"></div>
  <h1>Mod Queue</h1>
  <span class="ws-label" id="ws-label">connecting</span>
  <div class="jellyfin-status">
    <div class="jellyfin-dot" id="jf-dot"></div>
    <span id="jf-label">Jellyfin</span>
  </div>
</header>
<main>
  <section>
    <div class="section-title">Song Requests</div>
    <div id="queue-container"><div class="empty">No pending requests.</div></div>
  </section>
  <details>
    <summary>Wishlist</summary>
    <div id="wishlist-container"><div class="empty">Wishlist is empty.</div></div>
  </details>
</main>
<script>
  let queue = [], wishlist = [];

  function timeAgo(iso) {
    const s = Math.floor((Date.now() - new Date(iso)) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    return Math.floor(s / 3600) + 'h ago';
  }

  function renderQueue() {
    const el = document.getElementById('queue-container');
    const items = queue.filter(e => e.status !== 'skip');
    if (!items.length) { el.innerHTML = '<div class="empty">No pending requests.</div>'; return; }
    el.innerHTML = '<div class="card">' + items.map(e => {
      const song = e.resolvedItem ? (e.resolvedItem.artist + ' — ' + e.resolvedItem.name) : e.query;
      const approved = e.status === 'approved';
      return \`<div class="request-item \${approved ? 'approved' : ''}" id="qi-\${e.id}">
        <div class="request-info">
          <div class="request-song" title="\${song}">\${song}</div>
          <div class="request-meta">by \${e.user} · \${timeAgo(e.addedAt)}</div>
        </div>
        <span class="status-badge \${approved ? 'badge-approved' : 'badge-pending'}">\${approved ? 'Queued' : 'Pending'}</span>
        \${!approved ? \`<div class="request-actions">
          <button class="btn btn-approve" onclick="approve('\${e.id}', this)">✓ Approve</button>
          <button class="btn btn-deny"   onclick="deny('\${e.id}', this)">✕ Deny</button>
        </div>\` : ''}
      </div>\`;
    }).join('') + '</div>';
  }

  function renderWishlist() {
    const el = document.getElementById('wishlist-container');
    if (!wishlist.length) { el.innerHTML = '<div class="empty">Wishlist is empty.</div>'; return; }
    el.innerHTML = '<div class="card">' + wishlist.map(e =>
      \`<div class="wishlist-item"><span class="wishlist-song">\${e.query}</span><span class="wishlist-user">\${e.user}</span></div>\`
    ).join('') + '</div>';
  }

  async function approve(id, btn) {
    btn.disabled = true; btn.textContent = '…';
    try {
      const r = await fetch('/api/queue/' + id + '/approve', { method: 'POST' });
      if (!r.ok) { const d = await r.json(); alert(d.error || 'Failed'); btn.disabled = false; btn.textContent = '✓ Approve'; }
    } catch (e) { alert('Network error'); btn.disabled = false; btn.textContent = '✓ Approve'; }
  }

  async function deny(id, btn) {
    btn.disabled = true; btn.textContent = '…';
    try {
      await fetch('/api/queue/' + id + '/skip', { method: 'POST' });
    } catch (e) { alert('Network error'); btn.disabled = false; btn.textContent = '✕ Deny'; }
  }

  function connect() {
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://')
      + location.host + '/?token=' + encodeURIComponent(new URLSearchParams(location.search).get('token') || ''));
    ws.onopen = () => {
      document.getElementById('ws-dot').classList.add('live');
      document.getElementById('ws-label').textContent = 'live';
    };
    ws.onclose = () => {
      document.getElementById('ws-dot').classList.remove('live');
      document.getElementById('ws-label').textContent = 'reconnecting';
      setTimeout(connect, 3000);
    };
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.event === 'init') {
        queue = data.queue || []; wishlist = data.wishlist || [];
        const jfOk = data.jellyfin?.connected;
        document.getElementById('jf-dot').classList.toggle('ok', !!jfOk);
        document.getElementById('jf-label').textContent = jfOk ? 'Jellyfin connected' : 'Jellyfin offline';
        renderQueue(); renderWishlist();
      } else if (data.event === 'queue_add') {
        queue.push(data.entry); renderQueue();
      } else if (data.event === 'queue_update') {
        const idx = queue.findIndex(e => e.id === data.entry.id);
        if (idx !== -1) queue[idx] = data.entry; renderQueue();
      } else if (data.event === 'queue_remove') {
        queue = queue.filter(e => e.id !== data.id); renderQueue();
      } else if (data.event === 'wishlist_add') {
        wishlist.unshift(data.entry); renderWishlist();
      } else if (data.event === 'wishlist_remove') {
        wishlist = wishlist.filter(e => e.id !== data.id); renderWishlist();
      } else if (data.event === 'status' && data.service === 'jellyfin') {
        document.getElementById('jf-dot').classList.toggle('ok', data.connected);
        document.getElementById('jf-label').textContent = data.connected ? 'Jellyfin connected' : 'Jellyfin offline';
      }
    };
  }
  connect();
</script>
</body>
</html>`);
});

relayClient.init({
  state,
  broadcast,
  addLog,
  dispatchCommand,
  approveQueueEntry,
  skipQueueEntry,
  setReplyInterceptor,
});

if (process.env.MOD_ENABLED !== 'false') {
  modServer.listen(MOD_PORT, () => console.log(`Mod queue running on http://localhost:${MOD_PORT}`))
    .on('error', (err) => {
      // Optional feature: warn and carry on rather than taking the app down.
      if (err.code === 'EADDRINUSE') console.error(`Mod queue port ${MOD_PORT} already in use — mod queue disabled for this session.`);
      else console.error(`Mod queue error: ${err.message}`);
    });
}
