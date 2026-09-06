'use strict';

// Run: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { trackMatchesEntry, reconcile } = require('../queue-lifecycle');

const entry = (id, item, status = 'approved') => ({ id, status, resolvedItem: item });
const ITEM = { id: 'jf-123', name: 'Ghost Town', artist: 'Kanye West' };

test('matches on id when both sides carry one', () => {
  assert.ok(trackMatchesEntry({ id: 'jf-123', title: 'wrong', artist: 'wrong' }, entry('r1', ITEM)));
  assert.ok(!trackMatchesEntry({ id: 'jf-999', title: 'Ghost Town', artist: 'Kanye West' }, entry('r1', ITEM)));
});

test('falls back to name and artist for backends with no id', () => {
  const noId = { name: 'Ghost Town', artist: 'Kanye West' };
  assert.ok(trackMatchesEntry({ title: ' ghost town ', artist: 'KANYE WEST' }, entry('r1', noId)));
  assert.ok(!trackMatchesEntry({ title: 'Ghost Town', artist: 'Someone Else' }, entry('r1', noId)));
});

test('never matches an unresolved request or an empty track', () => {
  assert.ok(!trackMatchesEntry({ title: 'x', artist: 'y' }, entry('r1', null)));
  assert.ok(!trackMatchesEntry(null, entry('r1', ITEM)));
  assert.ok(!trackMatchesEntry({ title: '', artist: '' }, entry('r1', { name: '', artist: '' })));
});

test('a pending request is not considered playing even if it matches', () => {
  const q = [entry('r1', ITEM, 'pending')];
  assert.deepEqual(reconcile(q, { id: 'jf-123' }, null), { playingId: null, retiredId: null });
});

test('retires only once the player moves off the track', () => {
  const q = [entry('r1', ITEM)];
  const on = reconcile(q, { id: 'jf-123' }, null);
  assert.deepEqual(on, { playingId: 'r1', retiredId: null });
  // Still playing on the next tick: nothing retires yet.
  assert.deepEqual(reconcile(q, { id: 'jf-123' }, on.playingId), { playingId: 'r1', retiredId: null });
  // Player moved to something nobody requested.
  assert.deepEqual(reconcile(q, { id: 'jf-777' }, on.playingId), { playingId: null, retiredId: 'r1' });
});

test('stopping the player retires the track that was playing', () => {
  assert.deepEqual(reconcile([entry('r1', ITEM)], null, 'r1'), { playingId: null, retiredId: 'r1' });
});

test('idle stays idle, so nothing is retired twice', () => {
  assert.deepEqual(reconcile([], null, null), { playingId: null, retiredId: null });
});
