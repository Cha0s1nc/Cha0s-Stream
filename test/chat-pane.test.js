'use strict';

// Run: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resizePanes, defaultTabs, normalizeTabs, panesForMessage, channelsInTabs, PANE_MIN_PX,
} = require('../public/chat-pane.js');

test('dragging moves grow between the pair and conserves the total', () => {
  // Two equal 400px panes, drag the handle 100px right.
  const [a, b] = resizePanes(1, 1, 400, 400, 100);
  assert.ok(Math.abs((a + b) - 2) < 1e-9, 'total grow is conserved');
  assert.ok(a > b, 'the left pane grew');
  assert.ok(Math.abs(a - 1.25) < 1e-9);
});

test('a pane cannot be dragged below the minimum width', () => {
  const [a, b] = resizePanes(1, 1, 400, 400, -1000);
  const pxA = 800 * (a / (a + b));
  assert.ok(pxA >= PANE_MIN_PX - 1e-6, `left pane kept ${pxA}px`);
  assert.ok(Math.abs((a + b) - 2) < 1e-9);
});

test('unequal panes keep their combined share', () => {
  const [a, b] = resizePanes(3, 1, 600, 200, 50);
  assert.ok(Math.abs((a + b) - 4) < 1e-9);
  assert.ok(a > 3);
});

test('degenerate sizes are left alone rather than dividing by zero', () => {
  assert.deepEqual(resizePanes(1, 1, 0, 0, 50), [1, 1]);
  assert.deepEqual(resizePanes(0, 0, 400, 400, 50), [0, 0]);
  // Too narrow to hold two minimum-width panes: refuse instead of overlapping.
  assert.deepEqual(resizePanes(1, 1, 100, 100, 50), [1, 1]);
});

test('a corrupt or empty layout falls back to the default', () => {
  assert.deepEqual(normalizeTabs('not json', 'me'), defaultTabs('me'));
  assert.deepEqual(normalizeTabs('{}', 'me'), defaultTabs('me'));
  assert.deepEqual(normalizeTabs('[]', 'me'), defaultTabs('me'));
  assert.equal(defaultTabs('Me')[0].panes[0].channel, 'me');
});

test('unknown pane kinds and channel-less chat panes are dropped', () => {
  const tabs = normalizeTabs(JSON.stringify([{
    name: 'T',
    panes: [
      { kind: 'chat', channel: 'Forsen', grow: 2 },
      { kind: 'chat' },                 // no channel
      { kind: 'browser', url: 'x' },    // unknown kind
      { kind: 'events', grow: 'oops' }, // bad grow
    ],
  }]), 'me');
  assert.equal(tabs.length, 1);
  assert.deepEqual(tabs[0].panes, [
    { kind: 'chat', channel: 'forsen', grow: 2 },
    { kind: 'events', grow: 1 },
  ]);
});

test('a tab left with no valid panes does not survive', () => {
  assert.deepEqual(normalizeTabs(JSON.stringify([{ name: 'Empty', panes: [{ kind: 'nope' }] }]), 'me'),
    defaultTabs('me'));
});

test('a message routes to every pane showing that channel', () => {
  const panes = [
    { kind: 'chat', channel: 'forsen' },
    { kind: 'events' },
    { kind: 'chat', channel: 'forsen' },
    { kind: 'chat', channel: 'nymn' },
  ];
  assert.deepEqual(panesForMessage(panes, 'forsen'), [0, 2]);
  assert.deepEqual(panesForMessage(panes, 'FORSEN'), [0, 2]);
  assert.deepEqual(panesForMessage(panes, 'nobody'), []);
});

test('channelsInTabs lists each channel once across every tab', () => {
  const tabs = [
    { name: 'a', panes: [{ kind: 'chat', channel: 'forsen' }, { kind: 'events' }] },
    { name: 'b', panes: [{ kind: 'chat', channel: 'forsen' }, { kind: 'chat', channel: 'nymn' }] },
  ];
  assert.deepEqual(channelsInTabs(tabs), ['forsen', 'nymn']);
});
