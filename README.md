# Cha0s Stream

A stream management app that bridges Twitch events to OBS, Jellyfin, Spotify, alerts, and more!

---

## Features

- **OBS Controls** — scene switching, source toggling, stream and recording control from the dashboard or via chat commands. Full OBS tab with live scene list and source toggles, plus an optional OBS column in the Twitch Stream panel.
- **Cascade integration** — direct playback control for the [Cascade](https://github.com/Cha0s1nc/Cascade-Project) Jellyfin music client via a local connection. `!play`, `!pause`, `!next`, and `!prev` work reliably without OS key simulation
- **Jellyfin playback** — play, pause, skip, previous, and now playing via the Jellyfin session API
- **Spotify integration** — connect via OAuth for `!song`, `!play`, `!pause`, `!next`, and `!prev` through the Spotify Web API (requires Spotify Premium)
- **OS media keys** — system-level playback control and now playing detection (Spotify, Apple Music on Mac; Windows media transport on Windows; `playerctl` on Linux)
- **Twitch chat overlays** — transparent browser source for live chat with 7TV, BTTV, and native Twitch emotes, badge pills, and per-message lifetime
- **Alert overlays** — browser source or OBS source flash for follows, cheers, subs, resubsubs, and gift subs with per-type colours, messages, and sounds
- **Combined overlay mode** — a single `/overlay` browser source that layers chat and alerts together, or use separate sources for each
- **Song request queue** — viewer `!sr` requests or channel point redemptions, with a live queue in the dashboard and mod queue page
- **Chat commands** — built-in commands with per-command permission levels and source settings (chat, whisper, redemption input)
- **Custom commands** — add your own trigger words with response templates and `{user}` variables
- **Event triggers** — auto-fire chat messages, sounds, or scripts on follows, cheers, subs, resubsubs, and gift subs
- **Plugin system** — drop a `.js` file into `plugins/` to add commands, react to events, and render a live panel in the dashboard
- **Macro Deck integration** — a native C# plugin that connects directly over WebSocket to trigger any command without going through Twitch chat
- **Sender toggle** — switch between sending chat as your bot account or as the broadcaster on the fly
- **Mod queue** — a lightweight page for mods to approve or deny song requests in real time
- **Sound playback** — local files, absolute paths, or remote URLs via `!sound` or channel point redeems
- **Verbose log** — filterable activity log with OBS, Jellyfin, Sound, and Error categories
- **Auto-updater** — checks for new releases on startup and installs in place (Mac)
- **Cross-platform** — Mac (`.dmg`), Windows (`.exe`), Linux (`.AppImage` / `.deb`)

---

## Installation

Download the latest release for your platform from the [Releases](https://github.com/Cha0s1nc/cha0s-stream/releases) page.

- **Mac** — open the `.dmg` and drag the app to your Applications folder
- **Windows** — run the `.exe` installer
- **Linux** — run the `.AppImage` directly, or install the `.deb` on Debian/Ubuntu

On first launch, open the **Settings** tab and connect your services. The app connects automatically on startup and checks for updates.

> **Mac note:** Releases are not notarized with Apple. You may need to go to **System Settings → Privacy & Security** to allow the app to open after the first launch attempt.

---

## Configuration

There's configuration in the **Settings** category in the sidebar, hopefully for easier setup than a manual .env file

### Twitch

Click **Connect Twitch** to authorize via browser. The app handles OAuth automatically — no client secret or developer app required. Optionally connect a separate bot account the same way.

If you need a custom client ID (e.g. to change the app name in auth prompts), expand **Advanced** to enter one.

### Jellyfin

| Setting | Description |
|---------|-------------|
| Server URL | e.g. `http://x.x.x.x:8096` |
| API Key | **Dashboard → API Keys** |
| Username | Filter sessions by this user — leave blank to match any |
| Password | Use instead of API key if preferred |
| Device ID | Leave blank unless you need to pin to a specific device |

### Spotify

Click **Connect Spotify** to authorize. You will need to create a free app at [developer.spotify.com](https://developer.spotify.com/dashboard) and add `http://localhost:4455/api/spotify/callback` as a redirect URI. Paste the Client ID into **Settings → Spotify → Advanced**.

> Spotify playback controls (`!play`, `!pause`, `!next`, `!prev`) require Spotify Premium. `!song` works without Premium.

### OBS WebSocket

| Setting | Description |
|---------|-------------|
| Host | Machine running OBS — use a Tailscale IP if OBS is remote |
| Port | Default `4455` |
| Password | **Tools → WebSocket Server Settings** in OBS |

OBS 28 or newer is required (WebSocket is built in).

### Media Control Mode

Four modes are available. Switch between them in Settings or by clicking the mode label in the status bar.

- **Cascade** — controls the [Cascade](https://github.com/Cha0s1nc/Cascade-Project) Jellyfin music client directly over a local connection. The most reliable option for Cascade users — no OS key simulation, no Jellyfin session API. The Cascade mode button only appears after Cascade has been detected running at least once
- **Jellyfin** — sends play/pause/skip commands to the active Jellyfin session via the API
- **OS Keys** — sends system media key presses
- **Spotify** — controls Spotify playback via the Web API (requires Spotify Premium for playback controls)

### Overlays

Under **Settings → Overlays**, choose a browser source mode:

- **Alerts** — use `/alerts` as your browser source
- **Chat** — use `/chat` as your browser source
- **Both** — use `/overlay` for a single combined source, or toggle **Use separate browser sources** to get individual `/alerts` and `/chat` URLs
- All modes are configurable with separate appearance settings for alerts and chat

### Emotes

Under **Settings → Twitch**, enable **7TV Emotes** and/or **BTTV Emotes** to render third-party emotes as images in chat overlays. Both are off by default.

### Mod Queue

| Setting | Description |
|---------|-------------|
| Enable Mod Queue | Toggle the mod page on or off |
| Mod Queue Port | Default `3001` |

The mod page runs at `http://<ip>:3001` and shows only the song request queue with approve/deny controls. Share it with mods via a tool like [Tailscale](https://tailscale.com) or something like a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).

> **Share the link from Settings, not just the address.** The mod page requires an access token that the link carries in its query string. Anyone holding that link can approve requests and act in your channel, so treat it like a password — and use **New link** in Settings to revoke it, which disconnects every open session immediately.

---

## Commands

All commands are configurable from the **Commands** tab. Each has an enable toggle, permission level, and source settings.

### Built-in Commands

| Command | Default Permission | Description |
|---------|-------------------|-------------|
| `!song` | Everyone | Shows what's currently playing |
| `!sr <query>` | Everyone | Requests a song |
| `!play` | Moderator | Resumes playback |
| `!pause` | Moderator | Pauses playback |
| `!next` | Moderator | Skips to next track |
| `!prev` | Moderator | Goes to previous track |
| `!scene [name]` | Moderator | Switches OBS scene — omit name to list available scenes |
| `!source [name] on\|off` | Moderator | Toggles an OBS source — omit name to list sources in current scene |
| `!sound <name>` | Moderator | Plays a sound file |
| `!record start\|stop` | Moderator | Starts or stops OBS recording |
| `!run <url>` | Broadcaster | Runs a script from an allowlisted URL |
| `!killswitch` | Broadcaster | Stops stream and recording immediately |

### Custom Commands

Add custom commands from the **Commands** tab with a trigger word, permission level, and response template. Responses support `{user}`.

```
!discord  →  Join our Discord at discord.gg/yourlink
!hug      →  {user} sends a hug to the chat ❤️
```

---

## Alerts

The alert system fires on follows, cheers, subs, resubsubs, and gift subs. Configure delivery under **Settings → Overlays → Alert Delivery**:

- **Browser Source** — add the browser source URL as a Browser Source in OBS
- **OBS Source** — flashes a named OBS source for a configurable duration
- **Both** — fires both simultaneously

Each alert type has its own colour, message template, and optional sound.

---

## Overlays

### Chat overlay

Add the chat browser source URL as a transparent Browser Source in OBS. Displays live Twitch chat with emotes, badges, and configurable appearance.

Appearance is configured under **Settings → Overlays → Chat** or via the visual **Overlay Editor** at [chaosinc.xyz](https://chaosinc.xyz/github/projects/cha0s-stream/overlay-editor).

### Alert overlay

Add the alerts browser source URL as a Browser Source in OBS. Fires animated alerts for follows, cheers, subs, resubsubs, and gift subs.

### Combined overlay

Use the `/overlay` URL to show both chat and alerts in a single browser source. Configure under **Settings → Overlays → Both**.

---

## OBS Controls

The **OBS Controls** tab in the dashboard shows:

- Stream and recording status with live timecodes
- Start/stop buttons for stream and recording (starting stream requires confirmation)
- Full scene list — click any scene to switch immediately
- Source list for the current scene with enable/disable toggles

An **OBS** button in the Twitch Stream panel header adds a third column with a compact scene switcher and stream/record controls alongside chat and events.

---

## Song Requests

Viewers request songs with `!sr <query>` or via a channel point redemption. Requests appear in the **Requests** tab and the mod queue page. The active queue and download wishlist are both visible and manageable from the dashboard.

---

## Plugins

Drop a `.js` file into the `plugins/` folder next to the app, or import one via **Plugins → Import Plugin**. Plugins can register chat commands, react to stream events, store state, and render a live panel in the Plugins tab.

See [PLUGINS.md](PLUGINS.md) for the plugin development guide.

---

## Sounds

Trigger sounds with `!sound <name>`, channel point redemptions, or attached to alerts and event triggers.

```
!sound airhorn           → plays sounds/airhorn.mp3
!sound https://...       → streams from URL
```

Upload files from **Settings → Sounds** or drop them into the `sounds/` folder next to the app.

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
npm start              # launch the app
npm run dev            # same, with the main-process inspector on :9229
npm run listener       # backend only, no window (reads .env instead of app settings)
npm run check          # syntax-check listener.js and electron/main.js
```

> Only one copy can hold the listener port (3000 by default) at a time. If a
> second one is already running, the app will say so and exit rather than
> starting. `npm run dev` and the VS Code debugger both want :9229, so run one
> or the other.

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

Builds are attached to [GitHub Releases](https://github.com/Cha0s1nc/cha0s-stream/releases).

---

## Related

- [DEPRECATED] [cha0s_b0t](https://github.com/Cha0s1nc/cha0s_b0t) — The original Twitch bot this project grew out of
