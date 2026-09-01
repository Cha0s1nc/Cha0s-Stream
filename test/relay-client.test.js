'use strict';

// Run: npm test
//
// Exercises relay-client.js against a hand-rolled relay socket: handshake,
// serial command.run drain, reply capture, and idempotency. No network, no
// dependency on the relay repo.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { WebSocketServer } = require('ws');

const realFetch = global.fetch;
global.fetch = async (url) => {
  if (String(url).includes('oauth2/validate')) {
    return { ok: true, json: async () => ({ user_id: '1', login: 'streamer', scopes: [] }) };
  }
  throw new Error('unexpected fetch ' + url);
};

process.env.TWITCH_OAUTH = 'oauth:testtoken';
process.env.RELAY_ENABLED = 'true';

const relay = require('../relay-client');

test.after(() => { global.fetch = realFetch; relay.stop(); });

test('handshake, serial command.run, reply capture, idempotency', async () => {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  await new Promise((r) => server.listen(0, r));
  process.env.RELAY_URL = `ws://127.0.0.1:${server.address().port}`;

  const dispatched = [];
  const deps = {
    state: {
      queue: [], wishlist: [],
      commands: { sr: { enabled: true, permission: 'everyone', sources: ['chat'] } },
      customCommands: {},
    },
    broadcast: () => {},
    addLog: () => {},
    approveQueueEntry: async () => ({ status: 200, body: { ok: true } }),
    skipQueueEntry: () => ({ status: 200, body: { ok: true } }),
    setReplyInterceptor: (fn) => { deps._interceptor = fn; },
    dispatchCommand: async (evt, source, user, text) => {
      dispatched.push({ user, text, badges: evt.badges });
      await new Promise((r) => setTimeout(r, 20)); // force overlap if not serial
      if (deps._interceptor) deps._interceptor(`done: ${text}`);
    },
  };

  const gotHandshake = new Promise((resolve) => {
    wss.once('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.role === 'agent') {
          resolve(msg);
          ws.send(JSON.stringify({ type: 'ready', login: 'streamer' }));
          ws._agent = ws;
        } else if (msg.type === 'action.result') {
          results.push(msg);
        }
      });
      wss._ws = ws;
    });
  });
  const results = [];

  relay.init(deps);

  const hs = await gotHandshake;
  assert.equal(hs.v, 1);
  assert.equal(hs.token, 'testtoken');
  assert.deepEqual(hs.commands.find((c) => c.trigger === 'sr'), { trigger: 'sr', level: 'everyone' });

  // two commands back to back + a repeat of the first id
  wss._ws.send(JSON.stringify({ type: 'command.run', id: 'a', trigger: 'sr', args: ['one'], user: 'bob', userLevel: 'everyone' }));
  wss._ws.send(JSON.stringify({ type: 'command.run', id: 'b', trigger: 'sr', args: ['two'], user: 'kim', userLevel: 'moderator' }));

  await new Promise((r) => setTimeout(r, 120));

  wss._ws.send(JSON.stringify({ type: 'command.run', id: 'a', trigger: 'sr', args: ['one'], user: 'bob', userLevel: 'everyone' }));
  await new Promise((r) => setTimeout(r, 60));

  // dispatchCommand ran once per unique id, in order
  assert.deepEqual(dispatched.map((d) => d.text), ['!sr one', '!sr two']);
  // moderator level produced a moderator badge
  assert.deepEqual(dispatched[1].badges, [{ set_id: 'moderator' }]);
  // every command answered, replies captured, repeat id reused the cached result
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(byId.a.reply, 'done: !sr one');
  assert.equal(byId.b.reply, 'done: !sr two');
  assert.equal(results.filter((r) => r.id === 'a').length, 2);

  wss.close();
  server.close();
  relay.stop();
});
