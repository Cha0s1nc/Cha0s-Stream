# cha0s-stream

A stream management app that bridges Twitch events to OBS, Jellyfin, alerts, and more. Built with Node.js and Electron, featuring a live dashboard to monitor connections, commands, and song requests in real time.

---

## Features

- OBS WebSocket integration — scene switching, source toggling, recording control
- Jellyfin playback control and now playing info
- OS media key control with system-level now playing detection (Spotify, Apple Music, etc.)
- Song request queue with viewer-facing chat responses
- Custom chat commands with per-command permission and source settings
- Alert system — browser source overlay or OBS source flash for follows, cheers, subs, resubsubs, and gift subs
- Event triggers — auto-respond to Twitch events with chat messages, sounds, or scripts
- Mod queue page — a separate lightweight UI for mods to approve/deny song requests
- Sound playback via local files or URLs
- Shell script execution via allowlisted domains
- Plugin system — drop a `.js` file in `plugins/` to extend the app
- Live dashboard with command log, service status, and song request queue
- Built-in settings UI — no config files required for the desktop app
- Cross-platform — Mac (`.dmg`), Windows (`.exe`), Linux (`.AppImage` / `.deb`)

---

## Installation

Download the latest release for your platform from the [Releases](https://github.com/Cha0s1nc/cha0s-stream/releases) page.

- **Mac** — open the `.dmg` and drag the app to your Applications folder
- **Windows** — run the `.exe` installer
- **Linux** — run the `.AppImage` directly, or install the `.deb` on Debian/Ubuntu

On first launch, click the **Settings** tab and fill in your credentials. The app connects automatically and checks for updates on startup.

> **Mac note:** Releases are not notarized with Apple. You have to use **System Settings** to allow the app to open after trying to launch it once.

---

## Configuration

All settings are configured from within the app under the **Settings** tab. Changes are saved immediately.

### Jellyfin

| Setting | Description |
|---------|-------------|
| Server URL | Your Jellyfin server address, e.g. `http://x.x.x.x:8096` |
| API Key | Generated in Jellyfin under **Dashboard → API Keys** |
| Username | Jellyfin username to filter sessions by — leave blank to match any user |
| Device ID | Leave blank unless you want to pin to a specific device |

### OBS WebSocket

| Setting | Description |
|---------|-------------|
| Host | The machine running OBS — use a Tailscale IP if OBS is on a different machine |
| Port | Default is `4455` |
| Password | Set in OBS under **Tools → WebSocket Server Settings** |

> OBS 28 or newer is required — WebSocket is built in.

### Twitch

| Setting | Description |
|---------|-------------|
| Client ID / Secret | From your app at [dev.twitch.tv](https://dev.twitch.tv) |
| Channel | Your Twitch channel name |
| Broadcaster Token | Click **Authorize** to complete the OAuth flow |
| Bot Username | Your bot account's Twitch username (optional) |
| Bot Token | Click **Authorize Bot** to complete the bot OAuth flow (optional) |

### Media Control

Two modes are available under **Settings → Media Control**:

- **Jellyfin** (default) — sends play/pause/skip commands directly to the active Jellyfin session. `!song` reads now playing from Jellyfin.
- **OS Keys** — sends system media key presses. `!song` reads now playing from the system (Spotify, Apple Music on Mac; Windows media controls on Windows; `playerctl` on Linux).

### Mod Queue

| Setting | Description |
|---------|-------------|
| Mod Queue | Toggle the mod queue page on/off |
| Mod Queue Port | Port for the mod queue page — default `3001` |

The mod queue page is a lightweight UI accessible at `http://<ip>:3001` that lets mods approve or deny song requests in real time without access to the full dashboard.

### Listener

| Setting | Description |
|---------|-------------|
| Port | Port the app runs on — default `3000` |

---

## Commands

All commands are configurable from the **Commands** tab. Each command has its own enable toggle, permission level, and source settings (chat, whisper, redemption input).

### Built-in Commands

| Command | Default Permission | Description |
|---------|-------------------|-------------|
| `!song` | Everyone | Shows what's currently playing |
| `!sr <query>` | Everyone | Requests a song by name |
| `!play` | Moderator | Resumes playback |
| `!pause` | Moderator | Pauses playback |
| `!next` | Moderator | Skips to next track |
| `!prev` | Moderator | Goes to previous track |
| `!scene <name>` | Moderator | Switches OBS scene |
| `!source <name> on\|off` | Moderator | Toggles an OBS source |
| `!sound <name>` | Moderator | Plays a sound file |
| `!record start\|stop` | Moderator | Starts or stops OBS recording |
| `!run <url>` | Broadcaster | Runs a script from an allowlisted URL |
| `!killswitch` | Broadcaster | Stops stream and recording immediately |

### Custom Commands

Custom commands can be added from the **Commands** tab. Each has a trigger word, permission level, source settings, and a response template. Responses support the `{user}` variable.

Examples:
```
!discord  →  Join our Discord at discord.gg/yourlink
!socials  →  Follow @cha0s on everything!
!hug      →  @{user} sends a hug to the chat ❤️
```

---

## Alerts

The alert system fires on follows, cheers, subs, resubsubs, and gift subs. Two delivery modes are available under **Settings → Alerts**:

- **Browser Source** — add `http://localhost:3000/alerts` as a Browser Source in OBS. Alerts appear as an overlay automatically.
- **OBS Source** — flashes a named OBS source visible for a configurable duration.

Each alert type has its own toggle, accent color, and message template. Sounds can be attached to individual alert types.

---

## Event Triggers

Under **Commands → Event Triggers**, you can configure automatic chat responses, sounds, and scripts that fire when Twitch events occur. Each trigger type (follow, cheer, sub, resub, gift sub) can be enabled independently.

---

## Song Requests

When `!sr` is enabled, viewers can request songs from your Jellyfin library. Requests appear in the **Requests** tab and on the mod queue page.

Song requests can also be triggered via a Twitch channel point redemption — set the redemption name under **Settings → Song Requests**.

---

## Mod Queue

The mod queue page runs on a separate port (default `3001`) and shows only the song request queue with approve/deny controls. It's designed to be shared with mods via [Tailscale](https://tailscale.com) or exposed through a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).

Access it at `http://<ip>:3001`. The page updates live via WebSocket.

---

## Sounds

Sounds can be triggered with `!sound <name>`, via channel point redemptions, or attached to alerts and event triggers.

```
!sound airhorn           → plays sounds/airhorn.mp3
!sound https://...       → streams from URL directly
```

Upload sound files directly from **Settings → Sounds**, or drop them into the `sounds/` folder next to the app.

---

## Plugins

Drop a `.js` file into the `plugins/` folder (or use **Plugins → Import Plugin**) to extend the app. Plugins can register chat commands, react to stream events, and render a live panel in the Plugins tab.

See [PLUGINS.md](PLUGINS.md) for the full plugin development guide.

---

## Building from Source

### Prerequisites

- Node.js v18 or newer
- npm

### Setup

```bash
git clone https://github.com/Cha0s1nc/cha0s-stream.git
cd cha0s-stream
npm install
```

### Run in dev mode

```bash
npm run electron
```

### Build installers

```bash
npm run build:mac      # Mac .dmg
npm run build:win      # Windows .exe installer
npm run build:linux    # Linux .AppImage and .deb
npm run build:all      # All platforms
```

> **Linux build deps:** `sudo apt install fakeroot dpkg` may be required for the `.deb` target.

Output goes to the `dist/` folder.

---

## Releases

Builds are done manually and attached to [GitHub Releases](https://github.com/Cha0s1nc/cha0s-stream/releases).

---

## Related

- [DEPRECATED] [cha0s_b0t](https://github.com/Cha0s1nc/cha0s_b0t) — The original Twitch bot this app grew out of
