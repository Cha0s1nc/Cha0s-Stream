'use strict';

// Run: npm test
//
// This is what stops a web page in the streamer's browser from driving the
// dashboard socket, which runs commands as the broadcaster.

const test = require('node:test');
const assert = require('node:assert/strict');
const { isLocalRequest } = require('../local-only');

const ok = (headers) => isLocalRequest(headers, 3000);

test('the app itself, OBS and local tools get through', () => {
  assert.equal(ok({ host: 'localhost:3000' }), true);
  assert.equal(ok({ host: '127.0.0.1:3000' }), true);
  assert.equal(ok({ host: 'localhost:3000', origin: 'http://localhost:3000' }), true);
  assert.equal(ok({ host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' }), true);
});

test('another web page is refused', () => {
  assert.equal(ok({ host: 'localhost:3000', origin: 'https://evil.example' }), false);
  assert.equal(ok({ host: 'localhost:3000', origin: 'null' }), false);
  assert.equal(ok({ host: 'localhost:3000', origin: 'http://localhost:5173' }), false);
});

test('a rebinding domain pointed at 127.0.0.1 is refused', () => {
  assert.equal(ok({ host: 'evil.example:3000' }), false);
  assert.equal(ok({ host: 'evil.example:3000', origin: 'http://evil.example:3000' }), false);
  assert.equal(ok({}), false);
});
