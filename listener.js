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
  'SCRIPT_ALLOWLIST','MEDIA_CONTROL_MODE',
  'SONG_REQUEST_MODE','SONG_REQUEST_REDEEM_NAME','SONG_REQUEST_ENABLED',
  'COMMANDS_CONFIG','CUSTOM_COMMANDS','REDEEM_ACTIONS',
  'ALERT_MODE','ALERT_OBS_SOURCE','ALERT_OBS_DURATION','ALERT_CUSTOM_CONFIG',
  'CHAT_OVERLAY_CONFIG','OVERLAY_MODE',
  'SEVENTV_ENABLED','BTTV_ENABLED',
  'EVENT_TRIGGERS'
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

const PORT = process.env.LISTENER_PORT || 3000;
const MOD_PORT = process.env.MOD_PORT || 3001;

// modWss is created later — declared here so broadcast() can reach it
let modWss = null;
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
    setSetting: (key, value) => { process.env[key] = value; persistEnv(); }
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

async function authenticateJellyfin() {
  const JELLYFIN_URL = process.env.JELLYFIN_URL;
  const username = process.env.JELLYFIN_USERNAME;
  const password = process.env.JELLYFIN_PASSWORD;
  const apiKey = process.env.JELLYFIN_API_KEY;

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
  }
}

async function jellyfinRequest(path, method = 'GET', body = null) {
  const JELLYFIN_URL = process.env.JELLYFIN_URL;
  if (!jellyfinToken) await authenticateJellyfin();
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
  const commands = {
    play:      { darwin: `osascript -e 'tell application "System Events" to key code 100'`, win32: `powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]179)"`, linux: `xdotool key XF86AudioPlay` },
    pause:     { darwin: `osascript -e 'tell application "System Events" to key code 100'`, win32: `powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]179)"`, linux: `xdotool key XF86AudioPlay` },
    next:      { darwin: `osascript -e 'tell application "System Events" to key code 101'`, win32: `powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]176)"`, linux: `xdotool key XF86AudioNext` },
    prev:      { darwin: `osascript -e 'tell application "System Events" to key code 98'`,  win32: `powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]177)"`, linux: `xdotool key XF86AudioPrev` }
  };
  const cmd = commands[action]?.[platform];
  if (!cmd) throw new Error(`OS media key not supported for ${action} on ${platform}`);
  return new Promise((resolve, reject) => exec(cmd, err => err ? reject(err) : resolve()));
}

// --- Spotify ---
const SPOTIFY_SCOPES = 'user-read-currently-playing user-read-playback-state user-modify-playback-state';
let spotifyPollTimer = null;
let spotifyCurrentTrack = null; // { title, artist, id, isPlaying }

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
    persistEnv();
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
      isPlaying: data.is_playing,
    };
  } catch { return null; }
}

function spotifyStartPolling() {
  if (spotifyPollTimer) return;
  spotifyPollTimer = setInterval(async () => {
    if ((process.env.MEDIA_CONTROL_MODE || 'os') !== 'spotify') return;
    const track = await spotifyGetCurrentTrack();
    const changed = track?.id !== spotifyCurrentTrack?.id || track?.isPlaying !== spotifyCurrentTrack?.isPlaying;
    spotifyCurrentTrack = track;
    if (changed) broadcast({ event: 'now_playing', track: track ? `${track.artist} — ${track.title}` : null, isPlaying: track?.isPlaying ?? false });
  }, 8000);
}

function spotifyStopPolling() {
  if (spotifyPollTimer) { clearInterval(spotifyPollTimer); spotifyPollTimer = null; }
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
async function handleChatMessage(event) {
  const user = event?.chatter_user_name || 'unknown';
  const text = event?.message?.text || '';
  pluginEvents.emit('chat', { user, text, event });
  broadcast({
    event:     'chat',
    user,
    color:     event?.color || '',
    badges:    (event?.badges || []).map(b => b.set_id),
    message:   text,
    fragments: (event?.message?.fragments || []).map(f => ({
      type:    f.type,
      text:    f.text,
      emoteId: f.emote?.id || null,
    })),
    ts:        Date.now(),
  });
  await dispatchCommand(event, 'chat', user, text);
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

async function dispatchCommand(permEvent, source, user, text) {
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

  if (!text.startsWith('!')) return;

  const parts = text.slice(1).split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);
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
  }

  // Always-on watermark — not in DEFAULT_COMMANDS, cannot be disabled
  if (cmd === 'info') await cmdInfo();
}

// --- Chat response sender ---
async function sendChatMessage(text, sender = 'auto') {
  if (!text) return;
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

// --- Command implementations ---

async function cmdSong(user) {
  const mediaMode = process.env.MEDIA_CONTROL_MODE || 'os';
  if (mediaMode === 'spotify') {
    try {
      const track = await spotifyGetCurrentTrack();
      if (!track) { await sendChatMessage(`@${user} — Nothing is playing right now.`); return; }
      const song = `${track.artist} — ${track.title}`;
      addLog('system', '!song', `${user} → ${song} [Spotify]`);
      const tmpl = state.commands.song?.response;
      if (tmpl) await sendChatMessage(fillTemplate(tmpl, { user, song }));
    } catch (err) { addLog('system', '!song', err.message, false); }
    return;
  }
  if (mediaMode === 'os') {
    try {
      const song = await getOSNowPlaying();
      if (!song) {
        addLog('system', '!song', `${user} — nothing playing`);
        await sendChatMessage(`@${user} — Nothing is playing right now.`);
        return;
      }
      addLog('system', '!song', `${user} → ${song}`);
      const tmpl = state.commands.song?.response;
      if (tmpl) await sendChatMessage(fillTemplate(tmpl, { user, song }));
    } catch (err) { addLog('system', '!song', err.message, false); }
    return;
  }
  try {
    const session = await getActiveSession();
    if (!session) {
      addLog('jellyfin', '!song', `${user} — nothing playing`);
      await sendChatMessage(`@${user} — Nothing is playing right now.`);
      return;
    }
    const item = session.NowPlayingItem;
    const artist = item.Artists?.[0] || item.AlbumArtist || 'Unknown Artist';
    const song = `${artist} — ${item.Name}`;
    addLog('jellyfin', '!song', `${user} → ${song}`);
    const tmpl = state.commands.song?.response;
    if (tmpl) await sendChatMessage(fillTemplate(tmpl, { user, song }));
  } catch (err) { addLog('jellyfin', '!song', err.message, false); }
}

async function cmdSongRequest(user, query) {
  if (!query) return;
  await handleSongRequest(user, query, 'chat');
}

async function cmdMediaControl(user, action) {
  const mediaMode = process.env.MEDIA_CONTROL_MODE || 'os';
  const commandMap = { play: 'Unpause', pause: 'Pause', next: 'NextTrack', prev: 'PreviousTrack' };
  const resultMap  = { play: '▶️ Resumed', pause: '⏸ Paused', next: '⏭ Skipped to next', prev: '⏮ Back to previous' };
  const tmpl = state.commands[action]?.response;
  if (mediaMode === 'spotify') {
    const spotifyMap = { play: '/me/player/play', pause: '/me/player/pause', next: '/me/player/next', prev: '/me/player/previous' };
    const spotifyMethod = { play: 'PUT', pause: 'PUT', next: 'POST', prev: 'POST' };
    try {
      await spotifyApiCall(spotifyMap[action], spotifyMethod[action] || 'POST');
      addLog('system', `!${action}`, `${user} → Spotify`);
      if (tmpl) await sendChatMessage(fillTemplate(tmpl, { user, result: resultMap[action] || '' }));
    } catch (err) { addLog('system', `!${action}`, err.message, false); }
    return;
  }
  if (mediaMode === 'os') {
    try {
      await sendOSMediaKey(action);
      addLog('system', `!${action}`, `${user} → OS media key`);
      if (tmpl) await sendChatMessage(fillTemplate(tmpl, { user, result: resultMap[action] || '▶️ Done' }));
    } catch (err) { addLog('system', `!${action}`, err.message, false); }
  } else {
    try {
      const session = await getActiveSession();
      if (!session) { addLog('jellyfin', `!${action}`, `${user} — no active session`, false); return; }
      await jellyfinRequest(`/Sessions/${session.Id}/Playing/${commandMap[action]}`, 'POST');
      addLog('jellyfin', `!${action}`, `${user} → ${commandMap[action]}`);
      if (tmpl) await sendChatMessage(fillTemplate(tmpl, { user, result: resultMap[action] || '' }));
    } catch (err) { addLog('jellyfin', `!${action}`, err.message, false); }
  }
}

async function cmdScene(user, scene) {
  if (!state.obs.connected) { addLog('obs', '!scene', `${user} — OBS not connected`, false); return; }
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
  catch (err) { addLog('obs', '!scene', err.message, false); }
}

async function cmdSource(user, source, onoff) {
  if (!state.obs.connected) { addLog('obs', '!source', `${user} — OBS not connected`, false); return; }
  if (!source) {
    // No argument — list sources in the current scene
    try {
      const { currentProgramSceneName } = await obs.call('GetSceneList');
      const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: currentProgramSceneName });
      const names = sceneItems.map(i => `${i.sourceName}(${i.sceneItemEnabled ? 'on' : 'off'})`);
      await sendChatMessage(`Sources in "${currentProgramSceneName}": ${names.join(', ')} — use !source <name> on|off`);
      addLog('obs', '!source', `${user} — listed sources`);
    } catch (err) { addLog('obs', '!source', err.message, false); }
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
  } catch (err) { addLog('obs', '!source', err.message, false); }
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
  if (!state.obs.connected) { addLog('obs', '!record', `${user} — OBS not connected`, false); return; }
  try {
    if (action === 'start') { await obs.call('StartRecord'); addLog('obs', '!record', `${user} → started`); }
    else if (action === 'stop') { await obs.call('StopRecord'); addLog('obs', '!record', `${user} → stopped`); }
    else addLog('obs', '!record', `${user} — unknown action: ${action}`, false);
  } catch (err) { addLog('obs', '!record', err.message, false); }
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
  if (!state.obs.connected) { addLog('obs', '!killswitch', `${user} — OBS not connected`, false); return; }
  try {
    await obs.call('StopStream'); addLog('obs', '!killswitch', `${user} → stream stopped`);
    try { await obs.call('StopRecord'); addLog('obs', '!killswitch', 'Recording stopped'); } catch {}
  } catch (err) { addLog('obs', '!killswitch', err.message, false); }
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
async function handleSongRequest(user, query, source) {
  if (!query || process.env.SONG_REQUEST_ENABLED === 'false') return;
  addLog('jellyfin', '!sr', `${user} requested: ${query}`);
  let resolvedItem = null;
  try {
    if (jellyfinToken && process.env.JELLYFIN_URL) {
      const uid = jellyfinUserId;
      const searchPath = uid
        ? `/Users/${uid}/Items?searchTerm=${encodeURIComponent(query)}&IncludeItemTypes=Audio&Recursive=true&Limit=1&Fields=Id,Name,Artists,Album`
        : `/Items?searchTerm=${encodeURIComponent(query)}&IncludeItemTypes=Audio&Recursive=true&Limit=1&Fields=Id,Name,Artists,Album`;
      const result = await jellyfinRequest(searchPath);
      if (result?.Items?.length > 0) {
        const item = result.Items[0];
        resolvedItem = { id: item.Id, name: item.Name, artist: item.Artists?.[0] || item.AlbumArtist || '', album: item.Album || '' };
      }
    }
  } catch (err) { console.log('Song search error:', err.message); }

  if (!resolvedItem) {
    const entry = { id: `wish_${Date.now()}`, user, query, addedAt: new Date().toISOString() };
    state.wishlist.unshift(entry);
    if (state.wishlist.length > 200) state.wishlist.pop();
    broadcast({ event: 'wishlist_add', entry });
    addLog('jellyfin', '!sr', `"${query}" not in library — added to wishlist`, false);
    const tmpl = state.commands.sr?.response;
    if (tmpl) await sendChatMessage(fillTemplate(tmpl, { user, query, result: `"${query}" wasn't found in the library — added to the wishlist!` }));
  } else {
    const entry = { id: `req_${Date.now()}`, user, query, source, resolvedItem, status: 'pending', addedAt: new Date().toISOString() };
    state.queue.push(entry);
    broadcast({ event: 'queue_add', entry });
    addLog('jellyfin', '!sr', `Queued: ${resolvedItem.artist} — ${resolvedItem.name}`);
    const tmpl = state.commands.sr?.response;
    if (tmpl) await sendChatMessage(fillTemplate(tmpl, { user, query, result: `"${resolvedItem.artist} — ${resolvedItem.name}" added to the queue!` }));
  }
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

// --- HTTP Routes (kept for external compat) ---
app.post('/media', async (req, res) => {
  const { action } = req.body;
  if (action === 'song') {
    if ((process.env.MEDIA_CONTROL_MODE || 'os') === 'os') {
      try {
        const song = await getOSNowPlaying();
        return res.json(song ? { song } : { nothing: true });
      } catch (err) { return res.status(500).json({ error: err.message }); }
    }
    try {
      const session = await getActiveSession();
      if (!session) return res.json({ nothing: true });
      const item = session.NowPlayingItem;
      return res.json({ song: `${item.Artists?.[0] || item.AlbumArtist || 'Unknown'} — ${item.Name}` });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }
  const commandMap = { play: 'Unpause', pause: 'Pause', next: 'NextTrack', prev: 'PreviousTrack' };
  const command = commandMap[action];
  if (!command) return res.status(400).json({ error: `Unknown action: ${action}` });
  if (process.env.MEDIA_CONTROL_MODE === 'os') {
    try { await sendOSMediaKey(action); return res.json({ ok: true }); }
    catch (err) { return res.status(500).json({ error: err.message }); }
  }
  try {
    const session = await getActiveSession();
    if (!session) return res.status(404).json({ error: 'No active session' });
    await jellyfinRequest(`/Sessions/${session.Id}/Playing/${command}`, 'POST');
    return res.json({ ok: true });
  } catch (err) { return res.status(500).json({ error: err.message }); }
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
  const entry = state.queue.find(e => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  if (!entry.resolvedItem) return res.status(400).json({ error: 'No resolved item' });
  try {
    const session = await getActiveSession();
    if (!session) return res.status(404).json({ error: 'No active session' });
    await jellyfinRequest(`/Sessions/${session.Id}/Playing?playCommand=PlayNext&itemIds=${entry.resolvedItem.id}`, 'POST');
    entry.status = 'approved';
    broadcast({ event: 'queue_update', entry });
    addLog('jellyfin', 'queue', `Approved: ${entry.resolvedItem.artist} — ${entry.resolvedItem.name}`);
    res.json({ ok: true });
  } catch (err) { addLog('jellyfin', 'queue', `Approve failed: ${err.message}`, false); res.status(500).json({ error: err.message }); }
});

app.post('/api/queue/:id/skip', (req, res) => {
  const idx = state.queue.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const [entry] = state.queue.splice(idx, 1);
  broadcast({ event: 'queue_remove', id: entry.id });
  addLog('jellyfin', 'queue', `Skipped: ${entry.query}`);
  res.json({ ok: true });
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
  persistEnv();
  res.json({ ok: true });
});

// ── Combined overlay config (mode + alert + chat merged) ──────────────────────
app.get('/api/overlay/config', (req, res) => {
  let alertCfg = {};
  try { const r = process.env.ALERT_CUSTOM_CONFIG; if (r) alertCfg = JSON.parse(r); } catch {}
  res.json({
    mode:             process.env.OVERLAY_MODE || 'alerts',
    alert:            alertCfg,
    chat:             { ...CHAT_OVERLAY_DEFAULTS, ...(getChatOverlayConfig() || {}) },
    browserSourceUrl: `http://localhost:${PORT}/overlay`,
  });
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
  persistEnv();
  broadcast({ event: 'alerts_config_update', mode: process.env.ALERT_MODE, obsSource: process.env.ALERT_OBS_SOURCE, obsDuration: parseInt(process.env.ALERT_OBS_DURATION) || 5000 });
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
  persistEnv();
  addLog('system', 'settings', 'Event triggers updated');
  res.json({ ok: true });
});

app.get('/api/redeems', (req, res) => res.json({ redeems: state.redeemActions }));
app.post('/api/redeems', (req, res) => {
  const { redeems } = req.body;
  if (typeof redeems !== 'object') return res.status(400).json({ error: 'Invalid' });
  state.redeemActions = redeems;
  process.env.REDEEM_ACTIONS = JSON.stringify(redeems);
  persistEnv();
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
  persistEnv();
  broadcast({ event: 'commands_update', commands: state.commands });
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
  persistEnv();
  broadcast({ event: 'custom_commands_update', commands: state.customCommands });
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
  'TWITCH_CLIENT_SECRET','MEDIA_CONTROL_MODE','SONG_REQUEST_MODE','SONG_REQUEST_REDEEM_NAME',
  'SONG_REQUEST_ENABLED','TWITCH_BOT_USERNAME','TWITCH_BOT_OAUTH','TWITCH_OAUTH','TWITCH_CHANNEL',
  'ALERT_MODE','ALERT_OBS_SOURCE','ALERT_OBS_DURATION',
  'SPOTIFY_CLIENT_ID','SPOTIFY_ACCESS_TOKEN','SPOTIFY_REFRESH_TOKEN','SPOTIFY_TOKEN_EXPIRY',
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
    state.jellyfin.connected = false; jellyfinToken = null; jellyfinUserId = null;
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
  if (updated.includes('MEDIA_CONTROL_MODE')) {
    if (process.env.MEDIA_CONTROL_MODE === 'spotify' && spotifyIsConfigured()) {
      spotifyStartPolling();
    } else {
      spotifyStopPolling();
    }
  }
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
  if (updated.length) persistEnv();
  res.json({ ok: true, updated });
});

wss.on('connection', (ws) => {
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
      persistEnv();
      addLog('system', 'twitch', `Bot OAuth token acquired${username ? ` (${username})` : ''}`);
      broadcast({ event: 'oauth_bot_token', token: oauthToken, username });
      res.send(page('✅', 'Bot authorized!', `Logged in as <strong>${username || 'unknown'}</strong>. You can close this tab.`));
    } else {
      process.env.TWITCH_OAUTH = oauthToken;
      if (username) { process.env.TWITCH_CHANNEL = username; }
      persistEnv();
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
    persistEnv();
    broadcast({ event: 'spotify_connected' });
    addLog('system', 'spotify', 'Spotify connected');
    if ((process.env.MEDIA_CONTROL_MODE || 'jellyfin') === 'spotify') spotifyStartPolling();
    res.send('<html><body style="font-family:sans-serif;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><h2>✓ Spotify connected! You can close this tab.</h2></body></html>');
  } catch (err) {
    res.send(`<script>window.close()</script>Error: ${err.message}`);
  }
});

app.post('/api/spotify/disconnect', (req, res) => {
  process.env.SPOTIFY_ACCESS_TOKEN  = '';
  process.env.SPOTIFY_REFRESH_TOKEN = '';
  process.env.SPOTIFY_TOKEN_EXPIRY  = '';
  persistEnv();
  spotifyStopPolling();
  broadcast({ event: 'spotify_disconnected' });
  addLog('system', 'spotify', 'Spotify disconnected');
  res.json({ ok: true });
});

server.listen(PORT, () => {
  console.log(`Listener running on http://localhost:${PORT}`);
  if ((process.env.MEDIA_CONTROL_MODE || 'jellyfin') === 'spotify' && spotifyIsConfigured()) {
    spotifyStartPolling();
  }
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

const modServer = http.createServer(modApp);
modWss = new WebSocketServer({ server: modServer });

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
  const entry = state.queue.find(e => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  if (!entry.resolvedItem) return res.status(400).json({ error: 'No resolved item' });
  try {
    const session = await getActiveSession();
    if (!session) return res.status(404).json({ error: 'No active session' });
    await jellyfinRequest(`/Sessions/${session.Id}/Playing?playCommand=PlayNext&itemIds=${entry.resolvedItem.id}`, 'POST');
    entry.status = 'approved';
    broadcast({ event: 'queue_update', entry });
    addLog('jellyfin', 'queue', `Approved (mod): ${entry.resolvedItem.artist} — ${entry.resolvedItem.name}`);
    res.json({ ok: true });
  } catch (err) { addLog('jellyfin', 'queue', `Approve failed: ${err.message}`, false); res.status(500).json({ error: err.message }); }
});

modApp.post('/api/queue/:id/skip', (req, res) => {
  const idx = state.queue.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const [entry] = state.queue.splice(idx, 1);
  broadcast({ event: 'queue_remove', id: entry.id });
  addLog('jellyfin', 'queue', `Denied (mod): ${entry.query}`);
  res.json({ ok: true });
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
    const ws = new WebSocket('ws://' + location.host);
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

if (process.env.MOD_ENABLED !== 'false') {
  modServer.listen(MOD_PORT, () => console.log(`Mod queue running on http://localhost:${MOD_PORT}`));
}
