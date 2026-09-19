# Data & Privacy

Cha0s Stream is a desktop app that runs **on your own computer**. It is not a
hosted service. The author does not run it for you and, with the single opt-in
exception below, never receives your data or your viewers' data.

If you run Cha0s Stream, **you are the operator** of your own instance. You
decide what it connects to and what it does with what it sees, and any privacy
obligations you have to your viewers or moderators are yours, not the author's.

## What it handles, and where that data lives

Everything below stays **on your machine** unless a heading says otherwise:

- **Twitch chat** it reads and sends, including song requests (the requesting
  viewer's name and the track), the command/queue state, and your activity log.
- **Your credentials** — Twitch and Spotify OAuth tokens, OBS/Jellyfin/Cider
  connection details — stored locally (electron-store under Electron, or `.env`
  in standalone mode).
- **Overlays, alerts, sounds, plugins** and their settings.

## Services it talks to directly (between you and them, not through the author)

- **Twitch** and, if you connect it, **Spotify** — you authenticate with them
  directly; tokens are stored locally.
- **Your Jellyfin / Cider / OBS** — local or your own servers.
- **7TV / BTTV / FFZ** — for emote and badge images.
- **GitHub** — the auto-updater checks the Releases page and verifies downloads
  against their published SHA-256.

The author does not sit in the middle of any of these.

## The one exception: the Cha0s Guard relay (opt-in)

If **you** enable the Cha0s Guard integration, the app dials out to the
Cha0s Stream relay (`stream.chaosinc.xyz`, operated by the author) so that
[Cha0s Guard](https://github.com/Cha0s1nc/ModBot) can be the single chat-command
front door. While enabled:

- Your **broadcaster Twitch token** is sent to the relay, which validates it
  against Twitch to confirm the channel and then holds it **in memory only** to
  re-check revocation. It is **never written to disk**.
- **Chat commands** Guard forwards pass through the relay **in memory only**.
  Nothing is written to disk. The relay's operational log records the channel,
  the command and whether it worked, never the viewer's name or what they typed
  after the command.
- **The song request queue** (each track and the name of the viewer who asked
  for it) is sent through the relay to Cha0s Guard **only while one of your mods
  has Guard's Song Queue page open**, and the relay drops it when they close it.
- When a mod approves or skips a request, **their Discord username** comes back
  through the relay and is written to your activity log, so you can see who
  acted.

This is the only path by which anything leaves your machine to infrastructure
the author runs, it is **off by default**, and it is covered in full by the
[Cha0s Guard Privacy Policy](https://guard.chaosinc.xyz/privacy).

## Your viewers and mods

Because the app runs under your control, telling your viewers and moderators
what you collect (chat, song requests, etc.) and honouring their requests is
your responsibility as the operator. If you want a starting point, adapt the
Cha0s Guard Privacy Policy linked above to your own instance.

## No warranty

Cha0s Stream is free software under the GNU GPL v3. It is provided without
warranty of any kind. See [LICENSE](./LICENSE).

## Contact

Questions about the app: cha0s@chaosinc.xyz.
