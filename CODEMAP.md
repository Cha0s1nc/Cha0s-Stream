# CODEMAP

Orientation for the Cha0s Stream codebase. Line numbers are as of `f85a309`
(branch `dev`). If they've drifted, grep the symbol names.

## Shape of the thing

Electron desktop app. Two processes:

- **`electron/main.js`** (783 lines) - the shell. Owns the window, the
  `electron-store` settings file, auto-update, and the Twitch OAuth flow
  (implicit/token grant, its own callback server on a fixed port). Forks the
  listener as a child and restarts it on non-zero exit. Settings are pushed to
  the child as env vars; the child sends `{type:'persist', patch}` back up when
  it changes one.
- **`listener.js`** (3845 lines) - everything else. HTTP + WebSocket servers,
  Twitch EventSub client, OBS control, Jellyfin/Cider/Spotify now-playing,
  chat command dispatch, song requests, alerts/overlays, plugin host. This is
  the file you'll spend your time in.

Standalone mode: `npm run listener` runs `listener.js` with no Electron, OAuth
uses PKCE + a dedicated auth port (3773), settings persist to `.env`.

## listener.js map

### Boot / config
- `4-26` - `PERSIST_KEYS`: every setting that survives a restart. Add here when
  you add a setting.
- `28-80` - `persistEnv()` / `persistSettings()`: write settings back. Under
  Electron, IPC to main; standalone, rewrite `.env`.
- `89-92` - built-in Twitch client ID + `getEffectiveClientId()` override.
- `99-120` - express app, `server` (http), `wss` (WebSocketServer on the same
  server). `PORT` 3000, `MOD_PORT` 3030. **`server.listen(PORT)` binds all
  interfaces** - the dashboard on 3000 is not localhost-only.
- `132-150` - `DEFAULT_COMMANDS`: the built-in chat command table. `permission`
  one of `everyone|subscriber|vip|moderator|broadcaster`. `run` and
  `killswitch` ship disabled + broadcaster-only.
- `152-164` - `state`: the single in-memory store. `queue`, `wishlist`, `log`,
  `commands`, `customCommands`, connection status per service.

### Plugin host
- `189-272` - plugin loader. `createPluginApi()` (208) is the sandbox surface
  handed to each plugin: `addCommand`, `sendChat`, raw `obs`, `jellyfin()`,
  `store`, `getSetting`/`setSetting`. Plugins are `require()`d Node modules -
  full trust, no isolation.

### Broadcast / log / permissions
- `275-288` - `broadcast(data)`: JSON to every client on both `wss` and
  `modWss`. This is how the dashboard and the mod queue stay live.
- `290-295` - `addLog(type, command, detail, ok)`: prepend to `state.log`
  (capped 100), broadcast as `{event:'log'}`. **This is the only audit trail.**
- `300-309` - `checkPermission(chatEvent, required)`: badge-based. Broadcaster
  = chatter id matches broadcaster id.

### Media / song requests
- `477-499` - `approveQueueEntry(id, via)`: the shared approve path. Resolves
  the entry, calls `mediaAdapter().queueNext()`, marks `approved`, logs
  `Approved (via)`. Called by both the dashboard route and the mod-queue route.
- `726-791` - now-playing polling loop + `nowPlayingPayload()`.
- `1894-1995` - song request intake, filters (`SONG_REQUEST_FILTERS`),
  approval mode (`SONG_REQUEST_APPROVAL`: `approve` = queue for review,
  `open` = auto-queue).
- `mediaAdapter()` / `mediaMode()` - dispatch to jellyfin/cider/spotify/os.

### Chat command dispatch
- `1169-1258` - `dispatchCommand(permEvent, source, user, text)`: the single
  choke point. Keyword matches first, then `!`-prefixed builtin/custom/plugin
  commands. `source` is `chat|whisper|redemption_input`.
- `1243-1257` - the builtin `switch`. `cmdRun` (1254) and `cmdKillswitch`
  (1255) live here.
- `1765-1798` - `cmdRun`: fetches a script URL, host must be in
  `SCRIPT_ALLOWLIST`, then `exec`s it. This is the RCE surface the portal doc
  is scared of.
- `1267+` - `sendChatMessage(text, sender)`: `broadcaster|bot|auto`.

### Twitch EventSub
- `1041` - `twitchWs = new WebSocket('wss://eventsub.wss.twitch.tv/ws')`.
  Keepalive, reconnect, subscription registration. Chat messages arrive here
  and are handed to `dispatchCommand`.
- `3241-3252` - `TWITCH_SCOPES` (listener, standalone/PKCE path).
  `electron/main.js:593` has its own copy for the Electron token-grant path.
  **Neither includes `moderation:read` / `user:read:moderated_channels`.**
- `3256-3326` - PKCE OAuth flow, `pendingOAuthFlows` map, `startOAuthFlow()`.
- `3328-3494` - auth info/start/callback routes + Spotify OAuth.

### Main dashboard socket (port 3000, `wss`)
- `3140-3222` - `wss.on('connection')`. Sends a big `init` payload, then
  `ws.on('message')` handles inbound **actions** from clients (Macro Deck
  plugin, etc.):
  - `obs_scene`, `obs_stream`, `obs_record`, `obs_source`, `chat_send`
  - **`command` (3208-3214)** - builds a fake chat event with a
    `broadcaster` badge and calls `dispatchCommand`. Anything that reaches
    this socket runs commands as the broadcaster, `run`/`killswitch`
    included. The socket has **no auth**. This is the "narrow it" prerequisite
    in the portal doc.

### Mod queue (port 3030, `modApp` / `modServer` / `modWss`)
- `3585-3644` - the whole mod queue server.
  - `3600-3614` - `modToken()` (generate-on-first-use, persisted as
    `MOD_TOKEN`) + `modTokenValid()` (constant-time compare).
  - `3616-3624` - express middleware: `?token=` or `x-mod-token` header, else
    401 HTML.
  - `3627-3634` - `verifyClient` on the upgrade request (middleware doesn't
    run for WS upgrades).
  - `3637-3644` - `modWss.on('connection')`: sends `init`, **accepts no
    inbound messages**. All mod actions go over HTTP, not the socket.
- `3646-3656` - mod routes: `GET /api/queue`, `POST /api/queue/:id/approve`
  (→ `approveQueueEntry(id, 'mod')`), `POST /api/queue/:id/skip`.
- `3658-3826` - `GET /` serves the mod queue page as one inline HTML string
  (no build step, no framework).
- `2064-2077` - on the main app: `GET /api/mod/link` (returns URL with token),
  `POST /api/mod/link` (rotate token, terminate open sockets).

### HTTP route groups on the main app (port 3000)
- `2046-2220` - art, mod link, cider/cascade status, sounds, queue, jellyfin
  search, browser-source pages (`/alerts`, `/chat`, `/overlay`, `/nowplaying`).
- `2221-2716` - chat overlay config, badges, emotes (7TV/BTTV/FFZ), alerts.
- `2719-3066` - triggers, redeems, OBS scenes/sources/status, commands, custom
  commands, plugins, `/api/state`.
- `3085-3138` - `GET/POST /settings`: the settings page + save-all handler.
- `2092-2193` - control endpoints: `/media`, `/sound`, `/scene`, `/source`,
  `/recording`, `/killswitch`, `/run`, `/api/queue/*`. **Also unauthenticated,
  also on 0.0.0.0.**

## electron/main.js map
- `26-88` - `STORE_SCHEMA`: mirror of `PERSIST_KEYS` with defaults/types. Add
  here too when you add a setting.
- `90-119` - store construction (schema-validated, cleared on corruption) and
  `getConfig()`, which derives the listener's env from `STORE_SCHEMA`.
- `391-473` - `startListener()`: child fork, the `listenerProcess.on('message')`
  IPC `persist` handler (434-444), and the crash restart (447-472). The restart
  fires on any exit we did not ask for, signal deaths included; deliberate kills
  set `expectedExit` on the child first. `crashStreak` caps a startup crash loop
  at 5.
- `602-740` - Twitch OAuth (token grant, `shell.openExternal`, one-shot
  callback server on `OAUTH_CALLBACK_PORT` 611). `TWITCH_SCOPES` at 612.
- `742-763` - `ipcMain.handle('twitch-auth-start')`.

## public/
Single-file pages, no build. `index.html` (3504 lines) is the whole dashboard
SPA (vanilla JS). `nowplaying/overlay/alerts/chat.html` are browser sources.

## Guard relay (`relay-client.js`)

Outbound client to the Cha0s Stream Relay (separate repo `Cha0s-Stream-Server`,
deployed beside Cha0s Guard on OCI). Lets Guard be the single chat-command front
door so Guard and Stream stop double-answering `!` commands.

- `relay-client.js` - dial + jittered backoff, handshake with the broadcaster
  Twitch token + advertised command list, serial `command.run` execution,
  `queue.approve/skip/list`, `queue.snapshot` push. `init(deps)` is called near
  the end of `listener.js` (just before `modServer.listen`).
- `listener.js` wiring:
  - `const relayClient = require('./relay-client')` right after `let modWss`.
  - `sendChatMessage` (~1264): module global `replyInterceptor` +
    `setReplyInterceptor()`; when set, the reply is captured instead of sent to
    Helix (relay posts it via Guard).
  - `dispatchCommand(..., opts)` - `opts.keywordOnly` skips the `!` path.
  - `handleChatMessage` - `RELAY_DEFER_COMMANDS` + connected -> `keywordOnly`.
  - `broadcast()` - pushes `queue.snapshot` on `queue_*` / `wishlist_*` events.
  - `skipQueueEntry(id, via)` - extracted next to `approveQueueEntry`, shared by
    both skip routes and the relay.
  - command POST handlers call `relayClient.commandsChanged()`.
  - `/settings` POST calls `relayClient.reload()` on any `RELAY_*` change.
- Settings: `RELAY_ENABLED`, `RELAY_URL`, `RELAY_DEFER_COMMANDS` (in
  `PERSIST_KEYS`, `SETTINGS_KEYS`, `electron/main.js` `STORE_SCHEMA`, and the
  "Guard Relay" group in `public/index.html`).
- Test: `test/relay-client.test.js` (`npm test`).

## Conventions
- No build step anywhere. HTML is served as inline strings or static files.
- Settings are env vars end to end. New setting = add to `PERSIST_KEYS`
  (listener) + `STORE_SCHEMA` (main) + the `/settings` POST handler + the
  settings page HTML.
- `addLog()` for anything you want visible in the dashboard log.
- `broadcast()` reaches both dashboard and mod queue; there's no per-client
  targeting.
