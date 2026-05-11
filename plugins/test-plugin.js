/**
 * test-plugin.js — Cha0s Listener Test Plugin
 *
 * Tests the full plugin API:
 *   - Registers a !hello command
 *   - Listens to chat and redeem events
 *   - Uses the persistent store
 *   - Broadcasts data to the dashboard panel
 *   - Shows a live counter panel in the Plugins tab
 */

module.exports = {
  id: 'test-plugin',
  name: 'Test Plugin',
  version: '1.0.0',
  description: 'Verifies the plugin API — adds !hello, counts chat messages, and logs redeems.',
  author: 'cha0s',

  panel: `
    <div style="display:flex;flex-direction:column;gap:10px;">
      <div style="display:flex;gap:24px;">
        <div>
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);margin-bottom:2px;">Chat Events</div>
          <div id="tp-chat-count" style="font-size:22px;font-weight:700;color:var(--accent);">0</div>
        </div>
        <div>
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);margin-bottom:2px;">Redeems Seen</div>
          <div id="tp-redeem-count" style="font-size:22px;font-weight:700;color:var(--accent);">0</div>
        </div>
      </div>
      <div id="tp-last" style="font-size:12px;color:var(--text3);">Waiting for events…</div>
    </div>
    <script>
      (function() {
        let chatCount = 0, redeemCount = 0;

        window.addEventListener('plugin_data', function(e) {
          if (e.detail.pluginId !== 'test-plugin') return;
          const d = e.detail.data;

          if (d.type === 'chat') {
            chatCount++;
            document.getElementById('tp-chat-count').textContent = chatCount;
            document.getElementById('tp-last').textContent =
              'Last chat: ' + d.user + ': ' + d.text;
          } else if (d.type === 'redeem') {
            redeemCount++;
            document.getElementById('tp-redeem-count').textContent = redeemCount;
            document.getElementById('tp-last').textContent =
              'Last redeem: ' + d.user + ' → ' + d.title;
          }
        });
      })();
    </script>
  `,

  register(api) {
    // --- !hello command ---
    api.addCommand('hello', {
      permission: 'everyone',
      sources: ['chat', 'whisper'],
      description: 'Says hello back to the user',
      handler: async ({ user }) => {
        await api.sendChat(`👋 Hey @${user}!`);
        api.log(`Said hello to ${user}`);
      }
    });

    // --- !teststore command (broadcaster only) — tests persistent store ---
    api.addCommand('teststore', {
      permission: 'broadcaster',
      sources: ['chat'],
      description: 'Tests the plugin store — increments a counter each time',
      handler: async ({ user }) => {
        const count = (api.store.get('counter') || 0) + 1;
        api.store.set('counter', count);
        await api.sendChat(`🔢 Store test: counter is now ${count}`);
        api.log(`Store counter: ${count}`);
      }
    });

    // --- Listen for chat events ---
    api.on('chat', ({ user, text }) => {
      api.broadcast({ type: 'chat', user, text });
    });

    // --- Listen for redeem events ---
    api.on('redeem', ({ title, user, input }) => {
      api.broadcast({ type: 'redeem', user, title, input });
      api.log(`Redeem: ${user} → ${title}${input ? ` (${input})` : ''}`);
    });

    api.log('Test plugin loaded ✓');
  }
};
