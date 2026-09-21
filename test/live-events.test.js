'use strict';

// Run: npm test
//
// The dashboard learns about changes from events the server broadcasts, and the
// two ends name their fields separately in two big files. When they drift nothing
// throws where you can see it: the page just ends up holding undefined. That is
// how custom commands became undeletable for as long as the feature existed (the
// server sent `commands`, the page read `customCommands`).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'listener.js'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// The fields a server broadcast of this event carries.
function sentFields(event) {
  const m = server.match(new RegExp(`broadcast\\(\\{\\s*event:\\s*'${event}'\\s*,([^}]*)\\}\\)`));
  assert.ok(m, `server never broadcasts ${event}`);
  return m[1].split(',').map(f => f.split(':')[0].trim()).filter(Boolean);
}

// The data.* fields the page's handler for this event reads.
function readFields(event) {
  const start = page.indexOf(`data.event === '${event}'`);
  assert.ok(start >= 0, `page never handles ${event}`);
  const branch = page.slice(start, page.indexOf('} else if', start + 1));
  return [...branch.matchAll(/data\.([A-Za-z_]\w*)/g)].map(m => m[1]).filter(f => f !== 'event');
}

test('custom_commands_update: the page reads what the server sends', () => {
  const sent = sentFields('custom_commands_update');
  for (const field of readFields('custom_commands_update')) {
    assert.ok(sent.includes(field), `page reads data.${field}, server sends ${sent.join(', ')}`);
  }
});
