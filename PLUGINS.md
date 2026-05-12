# Cha0s Listener — Plugin Development Guide

Plugins are plain Node.js modules that live in the `plugins/` folder. Drop a `.js` file in there, restart the listener, and it's loaded automatically. Plugins can register chat commands, react to stream events, persist data, send messages to chat, and render a live panel in the Plugins tab.

---

## File structure

```js
module.exports = {
  id:          'my-plugin',       // unique snake-case ID (required)
  name:        'My Plugin',       // display name (required)
  version:     '1.0.0',          // semver string (required)
  description: 'Does a thing.',  // one-line description shown in the UI
  author:      'cha0s',          // shown in the UI

  panel: `...html...`,           // optional — live panel HTML (see below)

  register(api) {
    // all setup goes here
  }
};
```

`register(api)` is called once when the plugin loads. Everything the plugin does — commands, event listeners, timers — should be set up here.

---

## API reference

### Commands

```js
api.addCommand('hello', {
  permission:  'everyone',            // who can trigger it (see permissions below)
  sources:     ['chat', 'whisper'],   // where it can be triggered
  description: 'Says hello back',     // shown in the Commands tab
  handler: async ({ user, args, text, event }) => {
    await api.sendChat(`👋 Hey @${user}!`);
  }
});
```

**`handler` parameters**

| Parameter | Description |
|-----------|-------------|
| `user`    | Twitch username of the person who triggered the command |
| `args`    | Everything after the command name (e.g. `"some query text"`) |
| `text`    | Full raw message text |
| `event`   | Raw Twitch EventSub event object |

**Permission levels** (most to least permissive)

| Value | Who can use it |
|-------|---------------|
| `'everyone'` | All viewers |
| `'subscriber'` | Subscribers, VIPs, mods, broadcaster |
| `'vip'` | VIPs, mods, broadcaster |
| `'moderator'` | Mods and broadcaster |
| `'broadcaster'` | Broadcaster only |

**Sources**

| Value | Description |
|-------|-------------|
| `'chat'` | Public channel chat |
| `'whisper'` | Whispers sent to the broadcaster account |
| `'redemption_input'` | Channel Point redemption text input |

To unregister a command later:

```js
api.removeCommand('hello');
```

---

### Events

```js
api.on('chat', ({ user, text, event }) => {
  // fires for every chat message
});

api.on('redeem', ({ title, user, input }) => {
  // fires when a Channel Point redemption comes in
  // title  — the redemption reward title
  // input  — viewer's text input (if the reward has a text field)
});
```

Remove a listener when you no longer need it:

```js
const handler = ({ user, text }) => { /* ... */ };
api.on('chat', handler);
// later:
api.off('chat', handler);
```

> **Note:** `setInterval` / `setTimeout` callbacks set up in `register()` keep running even after the plugin is toggled off in the UI. Guard time-sensitive work with a flag if needed.

---

### Sending chat

```js
await api.sendChat('Hello chat! PogChamp');
```

Uses the broadcaster's configured OAuth token and channel. Respects rate limits handled by the listener core.

---

### Logging

```js
api.log('Something happened');        // green ✓ in the activity log
api.log('Something broke', false);    // red ✗ in the activity log
```

Log entries appear in the Dashboard activity feed under the plugin's ID.

---

### Persistent store

Per-plugin key/value storage that survives restarts. Values can be any JSON-serialisable type.

```js
// Read
const count = api.store.get('counter') ?? 0;

// Write
api.store.set('counter', count + 1);
```

Data is stored in `plugin-store.json` in the project root, namespaced by plugin ID.

---

### OBS

`api.obs` is a live [`obs-websocket-js`](https://github.com/obs-websocket-community-projects/obs-websocket-js) instance connected to OBS. You can call any OBS WebSocket request directly:

```js
// Switch scene
await api.obs.call('SetCurrentProgramScene', { sceneName: 'BRB' });

// Toggle source visibility
const { sceneItemId } = await api.obs.call('GetSceneItemId', {
  sceneName: 'Live',
  sourceName: 'Webcam'
});
await api.obs.call('SetSceneItemEnabled', {
  sceneName: 'Live',
  sceneItemId,
  sceneItemEnabled: false
});
```

Check `api.obs` is connected before calling if your plugin is sensitive to OBS being offline.

---

### Jellyfin

```js
const nowPlaying = await api.jellyfin('/Sessions');
await api.jellyfin('/Items/12345/PlaybackInfo', 'POST', { body: 'data' });
```

`api.jellyfin(path, method = 'GET', body = null)` — makes an authenticated request to the configured Jellyfin server. Returns the parsed JSON response, or `null` on failure.

---

### Panel broadcast

Send data from your plugin's server-side `register()` code to the HTML panel running in the browser:

```js
api.broadcast({ type: 'update', value: 42 });
```

The panel receives it via a `plugin_data` window event (see the Panel section below).

---

## Panel (UI)

The `panel` property is an HTML string rendered inside the plugin's card in the Plugins tab. Inline `<script>` tags are supported and executed automatically after the HTML is injected.

### Receiving broadcast data

```html
<div id="my-value">—</div>

<script>
  window.addEventListener('plugin_data', function(e) {
    if (e.detail.pluginId !== 'my-plugin') return;  // always filter by ID
    const d = e.detail.data;

    if (d.type === 'update') {
      document.getElementById('my-value').textContent = d.value;
    }
  });
</script>
```

### CSS variables

The panel inherits the app's design tokens. Use these to stay consistent with the UI theme:

| Variable | Use |
|----------|-----|
| `var(--accent)` | Purple accent colour |
| `var(--text1)` | Primary text |
| `var(--text2)` | Secondary text |
| `var(--text3)` | Muted / label text |
| `var(--bg3)` | Slightly elevated background |
| `var(--surface)` | Card / panel surface |
| `var(--surface2)` | Slightly darker surface |
| `var(--border)` | Border colour |
| `var(--green)` | Status green |
| `var(--red)` | Status red |

### Example panel

```html
<div style="display:flex;flex-direction:column;gap:10px;">
  <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);">
    Total Events
  </div>
  <div id="my-count" style="font-size:28px;font-weight:700;color:var(--accent);">0</div>
</div>
<script>
  (function() {
    let count = 0;
    window.addEventListener('plugin_data', function(e) {
      if (e.detail.pluginId !== 'my-plugin') return;
      count++;
      document.getElementById('my-count').textContent = count;
    });
  })();
</script>
```

> Wrap your script in an IIFE `(function() { ... })()` to avoid leaking variables into the global scope.

---

## Complete example

```js
module.exports = {
  id:          'dice-roller',
  name:        'Dice Roller',
  version:     '1.0.0',
  description: 'Rolls dice on !roll. Tracks total rolls in the panel.',
  author:      'cha0s',

  panel: `
    <div style="display:flex;align-items:baseline;gap:8px;">
      <div id="dr-count" style="font-size:24px;font-weight:700;color:var(--accent);">0</div>
      <div style="font-size:12px;color:var(--text3);">total rolls</div>
    </div>
    <div id="dr-last" style="font-size:12px;color:var(--text2);margin-top:6px;">No rolls yet.</div>
    <script>
      (function() {
        window.addEventListener('plugin_data', function(e) {
          if (e.detail.pluginId !== 'dice-roller') return;
          const d = e.detail.data;
          document.getElementById('dr-count').textContent = d.total;
          document.getElementById('dr-last').textContent =
            d.user + ' rolled ' + d.sides + 'd — got ' + d.result;
        });
      })();
    </script>
  `,

  register(api) {
    let totalRolls = api.store.get('totalRolls') || 0;

    api.addCommand('roll', {
      permission:  'everyone',
      sources:     ['chat'],
      description: 'Roll a die (!roll or !roll 20)',
      handler: async ({ user, args }) => {
        const sides = Math.max(2, parseInt(args) || 6);
        const result = Math.floor(Math.random() * sides) + 1;
        totalRolls++;
        api.store.set('totalRolls', totalRolls);
        await api.sendChat(`🎲 @${user} rolled a d${sides} and got ${result}!`);
        api.broadcast({ total: totalRolls, user, sides, result });
        api.log(`${user} rolled d${sides}: ${result}`);
      }
    });

    api.log('Dice Roller loaded ✓');
  }
};
```

---

## Installation

1. Drop your `.js` file into the `plugins/` folder.
2. In the Plugins tab, click **＋ Import Plugin** — or restart the listener.
3. The plugin appears in the list and is enabled by default.
4. To remove it, click **Remove** in the plugin card (this also deletes the file).

---

## Tips

- **Keep `register()` synchronous** where possible. Async work is fine inside handlers and `api.on()` callbacks, but avoid unhandled promise rejections in the top-level `register()` call.
- **Namespace your store keys** if your plugin stores multiple values (e.g. `'stats.rolls'`, `'stats.wins'`).
- **Filter `plugin_data` by `pluginId`** in every panel script — all panels on the page share the same event bus.
- **Don't assume OBS or Jellyfin are connected.** Wrap calls in try/catch and use `api.log(msg, false)` to surface errors in the activity log.
