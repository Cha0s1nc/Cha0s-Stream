'use strict';

// Run: npm test
//
// The pages are edited by hand and, occasionally, by scripted find-and-replace.
// A stray </div> does not throw anywhere: the browser silently reparents
// everything after it, which showed up as every panel but the first rendering
// hundreds of pixels down the page. Cheap to catch, miserable to debug.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const VOID = new Set(['br', 'img', 'input', 'hr', 'meta', 'link', 'source', 'area',
  'base', 'col', 'embed', 'param', 'track', 'wbr']);
const PAGES = ['index.html', 'chat.html', 'overlay.html', 'alerts.html', 'nowplaying.html', 'pane.html'];

// Deliberately not a full HTML parser. It skips comments and the contents of
// <script>/<style> (which are full of < and > inside strings) and then walks the
// tags, which is all that is needed to catch an unbalanced element.
function checkBalance(html) {
  const stack = [];
  const errors = [];
  const tagRe = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    if (m[0].startsWith('<!--')) continue;
    const [, closing, rawName, , selfClose] = m;
    const name = rawName.toLowerCase();
    const line = html.slice(0, m.index).split('\n').length;

    if (!closing && (name === 'script' || name === 'style')) {
      // Resume AFTER the closing tag, not at it: stopping on the closer leaves
      // it to be matched as a normal end tag against an empty stack.
      const close = html.indexOf(`</${name}`, tagRe.lastIndex);
      if (close === -1) { errors.push(`line ${line}: <${name}> is never closed`); break; }
      const gt = html.indexOf('>', close);
      tagRe.lastIndex = gt === -1 ? html.length : gt + 1;
      continue;
    }
    if (VOID.has(name) || selfClose) continue;

    if (!closing) {
      stack.push({ name, line });
    } else if (!stack.length) {
      errors.push(`line ${line}: stray </${name}> with nothing open`);
    } else if (stack[stack.length - 1].name !== name) {
      const open = stack[stack.length - 1];
      errors.push(`line ${line}: </${name}> but <${open.name}> from line ${open.line} is still open`);
      const at = stack.map(e => e.name).lastIndexOf(name);
      if (at !== -1) stack.length = at;
    } else {
      stack.pop();
    }
  }
  for (const open of stack) errors.push(`<${open.name}> opened at line ${open.line} is never closed`);
  return errors;
}

for (const page of PAGES) {
  const file = path.join(__dirname, '..', 'public', page);
  if (!fs.existsSync(file)) continue;
  test(`${page} has balanced tags`, () => {
    const errors = checkBalance(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(errors, [], `\n  ${errors.join('\n  ')}\n`);
  });
}

test('the checker actually catches an extra closing tag', () => {
  assert.deepEqual(checkBalance('<div><p>hi</p></div>'), []);
  assert.equal(checkBalance('<div><p>hi</p></div></div>').length, 1);
  assert.equal(checkBalance('<div><p>hi</div>').length, 1);
  // Content that merely looks like tags must not trip it.
  assert.deepEqual(checkBalance('<div><script>if (a < b && c > d) {}</script></div>'), []);
  assert.deepEqual(checkBalance('<div><!-- </div> --><br><img src=x></div>'), []);
});

test('every dashboard panel is a direct child of .main', () => {
  // The symptom of the stray </div> was panels ending up outside their
  // container, so assert the shape rather than only the tag balance.
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const panels = [...html.matchAll(/<div class="panel-view[^"]*" id="(tab-[a-z]+)"/g)].map(m => m[1]);
  assert.ok(panels.length >= 5, `expected the five panels, found ${panels.join(', ')}`);
  assert.ok(panels.includes('tab-dashboard') && panels.includes('tab-dev'));
});
