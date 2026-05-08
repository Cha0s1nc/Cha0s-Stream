# cha0s_listener

An app that bridges Twitch chat commands to OBS and Jellyfin. Built with Node.js and Electron, featuring a live dashboard to monitor connections and commands in real time. Also available as a Docker container for headless server deployments.

---

## Features

- OBS WebSocket integration — scene switching, source toggling, recording control
- Jellyfin playback control and now playing info
- OS media key control with system-level now playing detection (Spotify, Apple Music, etc.)
- Song request queue with viewer-facing chat responses
- Custom chat commands with per-command permission and source settings
- Mod queue page — a separate lightweight UI for mods to approve/deny song requests
- Sound playback via local files or URLs
- Shell script execution via allowlisted domains
- Live dashboard with command log, service status, and song request queue
- Built-in settings UI — no `.env` file required for the desktop app
- Cross-platform — Mac (`.dmg`), Windows (`.exe`), Linux (`.AppImage` / `.deb`)
- Docker support for headless server deployments with auto-updates via Watchtower

---

## Installation

### Desktop App

Download the latest release for your platform from the [Releases](https://github.com/Cha0s1nc/cha0s_listener/releases) page.

- **Mac** — open the `.dmg` and drag the app to your Applications folder
- **Windows** — run the `.exe` installer
- **Linux** — run the `.AppImage` directly, or install the `.deb` on Debian/Ubuntu

On first launch, click the **Settings** tab and fill in your credentials. The app connects automatically and checks for updates on startup.

> **Mac note:** Releases are unsigned. Right-click the app and choose **Open** the first time to bypass Gatekeeper.

### Docker

For running on a server without a desktop environment:

```bash
# 1. Create a directory for the listener
mkdir cha0s_listener && cd cha0s_listener

# 2. Download the compose file
curl -O https://raw.githubusercontent.com/Cha0s1nc/cha0s_listener/main/docker-compose.yml

# 3. Create an empty .env for settings persistence
touch .env

# 4. (Optional) Create a sounds folder
mkdir sounds

# 5. Start
docker compose up -d
```

The dashboard will be available at `http://<server-ip>:3000`.

Watchtower is included in the compose file and will automatically pull and restart the container whenever a new release is published, typically within 5 minutes.

---

## Configuration

All settings are configured from within the app under the **Settings** tab. Changes are saved immediately and also written back to `.env` on disk, so they survive restarts and Docker container restarts.

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

> **Docker note:** If OBS is running on the same host as Docker, uncomment `extra_hosts` in `docker-compose.yml` and set OBS Host to `host.docker.internal`.

### Twitch

| Setting | Description |
|---------|-------------|
| Client ID / Secret | From your app at [dev.twitch.tv](https://dev.twitch.tv) |
| Channel | Your Twitch channel name |
| Broadcaster Token | Click **Authorize** to complete the OAuth flow |
| Bot Username | Your bot account's Twitch username |
| Bot Token | Click **Authorize Bot** to complete the bot OAuth flow |

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
| Port | Port the listener runs on — default `3000`. Must match `LISTENER_URL` in the bot's `.env` |

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

Custom commands can be added from the **Commands** tab. Each custom command has a trigger word, permission level, source settings, and a response template. Responses support the `{user}` variable.

Examples:
```
!discord  →  Join our Discord at discord.gg/yourlink
!socials  →  Follow @cha0s on everything!
!hug      →  @{user} sends a hug to the chat ❤️
```

---

## Song Requests

When `!sr` is enabled, viewers can request songs from your Jellyfin library. Requests appear in the **Requests** tab on the dashboard and on the mod queue page.

Two approval modes are available under **Settings → Song Requests**:

- **Auto-approve** — requests are added to the Jellyfin queue immediately
- **Manual** — requests wait in the queue for a mod or broadcaster to approve or deny

Song requests can also be triggered via a Twitch channel point redemption — set the redemption name under **Settings → Song Requests → Redemption Name**.

---

## Mod Queue

The mod queue page runs on a separate port (default `3001`) and shows only the song request queue with approve/deny controls. It's designed to be shared with mods via [Tailscale](https://tailscale.com) or exposed through a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) with Cloudflare Access for authentication.

Access it at `http://<ip>:3001`. The page updates live via WebSocket.

---

## Sounds

Sounds can be triggered with `!sound <name>` or via channel point redemptions.

```
!sound airhorn           → plays sounds/airhorn.mp3
!sound https://...       → streams from URL directly
```

Place `.mp3` or `.wav` files in the `sounds/` folder next to the app (or the mounted Docker volume).

---

## Dashboard

The live dashboard shows:

- **Service status** — OBS, Jellyfin, and Twitch connection indicators
- **Now Playing** — current track, updated every 15 seconds
- **Command log** — every incoming command with timestamp, type, and success/failure
- **Requests** — song request queue with approve/deny controls
- **Commands** — per-command configuration
- **Settings** — all configuration in one place

---

## Networking

The listener needs to be reachable by the bot. If they're on different machines, [Tailscale](https://tailscale.com) is the easiest way to connect them. Set `LISTENER_URL` in the bot's `.env` to the Tailscale IP of the machine running the listener:

```env
LISTENER_URL=http://x.x.x.x:3000
```

---

## Building from Source

### Prerequisites

- Node.js v18 or newer
- npm

### Setup

```bash
git clone https://github.com/Cha0s1nc/cha0s_listener.git
cd cha0s_listener
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

### Build Docker image locally

```bash
docker build -t cha0s_listener .
```

---

## Releases

Electron builds are done manually and attached to [GitHub Releases](https://github.com/Cha0s1nc/cha0s_listener/releases). The Docker image is built and pushed to `ghcr.io/cha0s1nc/cha0s_listener` automatically on each new tag via GitHub Actions.

---

## Related

-  [DEPERECATED]  [cha0s_b0t](https://github.com/Cha0s1nc/cha0s_b0t) — The Twitch bot that sends commands to this listener
