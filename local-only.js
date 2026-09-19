'use strict';

// The dashboard on LISTENER_PORT can do anything the broadcaster can: its socket
// accepts `command` and dispatches it with broadcaster badges. Binding it to
// 127.0.0.1 keeps other machines out, but not other web pages: any site open in
// the streamer's browser can still reach localhost, and a WebSocket is not
// covered by CORS. So a request must also:
//
//   - name this machine in its Host header, which defeats DNS rebinding (an
//     attacker's domain re-pointed at 127.0.0.1 still sends its own name), and
//   - if a browser attached an Origin, come from one of this app's own pages.
//
// No Origin at all is allowed: that is a top-level page load, OBS, or a
// non-browser client such as the Macro Deck plugin, none of which a web page
// can forge.

const LOCAL_NAMES = new Set(['localhost', '127.0.0.1']);

function isLocalRequest(headers, port) {
  const host = String(headers.host || '');
  const i = host.lastIndexOf(':');
  const name = (i === -1 ? host : host.slice(0, i)).toLowerCase();
  if (!LOCAL_NAMES.has(name)) return false;

  const origin = headers.origin;
  if (origin === undefined) return true;
  return origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`;
}

module.exports = { isLocalRequest };
