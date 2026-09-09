'use strict';

// Run: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { isHomeChannel, normalizeLogin, parseChannelList } = require('../chat-channels');

test('our own channel is home', () => {
  assert.ok(isHomeChannel('12345', '12345'));
});

test('a guest channel is not home, so commands must not fire there', () => {
  assert.ok(!isHomeChannel('99999', '12345'));
});

test('ids compare as strings — Twitch sends them both ways', () => {
  assert.ok(isHomeChannel(12345, '12345'));
  assert.ok(isHomeChannel('12345', 12345));
});

test('an unresolved home id degrades to single-channel behaviour', () => {
  assert.ok(isHomeChannel('12345', null));
  assert.ok(isHomeChannel('12345', ''));
  assert.ok(isHomeChannel(undefined, undefined));
});

test('a missing event id is not treated as home once we know our own', () => {
  assert.ok(!isHomeChannel(undefined, '12345'));
  assert.ok(!isHomeChannel(null, '12345'));
  assert.ok(!isHomeChannel('', '12345'));
});

test('logins are lowercased and stripped of the usual paste noise', () => {
  assert.equal(normalizeLogin('Forsen'), 'forsen');
  assert.equal(normalizeLogin('  #forsen  '), 'forsen');
  assert.equal(normalizeLogin('https://www.twitch.tv/forsen'), 'forsen');
  assert.equal(normalizeLogin('twitch.tv/forsen?x=1'), '');  // no protocol, not a login
  assert.equal(normalizeLogin('https://twitch.tv/forsen/videos'), 'forsen');
});

test('invalid logins are rejected rather than passed to Twitch', () => {
  assert.equal(normalizeLogin('abc'), '');            // too short
  assert.equal(normalizeLogin('a'.repeat(26)), '');   // too long
  assert.equal(normalizeLogin('bad-name'), '');       // hyphen is not legal
  assert.equal(normalizeLogin('sql; drop'), '');
  assert.equal(normalizeLogin(''), '');
  assert.equal(normalizeLogin(null), '');
});

test('the stored list is deduped, normalized, and never contains home', () => {
  const raw = JSON.stringify(['Forsen', '#forsen', 'nymn', 'jontem_gamerttv', 'x']);
  assert.deepEqual(parseChannelList(raw, 'Jontem_GamerTTV'), ['forsen', 'nymn']);
});

test('a corrupt or non-array stored list degrades to empty, not a crash', () => {
  assert.deepEqual(parseChannelList('not json', 'home'), []);
  assert.deepEqual(parseChannelList('{"a":1}', 'home'), []);
  assert.deepEqual(parseChannelList('', 'home'), []);
  assert.deepEqual(parseChannelList(undefined, 'home'), []);
});
