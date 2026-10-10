'use strict';

// A field's live text and caret, read from a real Firefox by both runtimes.
//
// The walker is one shared asset (crystal/assets/read_field_state.js,
// generated from src/core.js), so the page answers the same question however
// it is asked. What can still differ is everything around the walk: holding
// the element, getting the answer back, decoding it. The JavaScript oracle
// reads its own copy of the fixture in-process; the native runtime joins the
// same kept browser through its broker, opens its own copy, and reads that.
// The two must not disagree.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, removeTempDir } = require('../tmpdir');
const { openDriver } = require('../../src/driver');
const { readFieldState } = require('../../src/core');
const { callAsync } = require('../crystal_impl');

const enabled = process.env.TAWB_TEST_CRYSTAL_BROWSER === '1';
const check = (name, fn) => test(`Crystal: ${name}`, { skip: !enabled }, fn);

const FIXTURE = `<!doctype html><html><body>
<input value="hello world">
<input value="abcdef">
<textarea>first line
second line</textarea>
<div contenteditable="true"><p>one <b>bold</b> tail</p><p>two</p><br></div>
<div id="plain">just text</div>
<script>
  document.querySelectorAll('input')[1].setSelectionRange(3, 3);
  document.querySelector('textarea').setSelectionRange(6, 6);
  window.getSelection().collapse(document.querySelector('b').firstChild, 2);
</script>
</body></html>`;

const FIELDS = [
  { name: 'a native input nobody has focused', selector: 'input', index: 0 },
  { name: 'a native input with a caret placed in it', selector: 'input', index: 1 },
  { name: 'a textarea with a caret placed in it', selector: 'textarea', index: 0 },
  { name: 'an editing host whose caret is inside a nested node', selector: '[contenteditable]', index: 0 },
  { name: 'an element that is not a field at all', selector: '#plain', index: 0 },
];

check("a field's live text and caret read the same from both runtimes", async () => {
  const root = tempDir('tawb-crystal-fields-');
  const profile = path.join(root, 'profile');
  const pagePath = path.join(root, 'fields.html');
  fs.writeFileSync(pagePath, FIXTURE);
  const url = `file://${pagePath}`;

  const driver = await openDriver({ engine: 'firefox', profile, log: () => {} });
  try {
    // The JavaScript oracle, through the same door the reader uses.
    const page = await driver.context.newPage();
    await page.goto(url);
    const frame = page.mainFrame();
    const javascript = [];
    for (const field of FIELDS) {
      const handle = await frame.evaluateHandle(
        `document.querySelectorAll('${field.selector}')[${field.index}]`);
      try {
        javascript.push(await readFieldState(handle));
      } finally {
        await handle.dispose().catch(() => {});
      }
    }

    assert.deepEqual(javascript, [
      { text: 'hello world', caret: 0, native: true },
      { text: 'abcdef', caret: 3, native: true },
      { text: 'first line\nsecond line', caret: 6, native: true },
      { text: 'one bold tail\ntwo\n\n', caret: 6, native: true },
      { text: 'just text', caret: 9, native: false },
    ]);

    // The native runtime, joining the same browser as a second reader.
    const broker = JSON.parse(
      fs.readFileSync(path.join(profile, 'tawb-broker.json'), 'utf8'));
    const native = await callAsync('firefox.fields_scenario', {
      url: `ws://127.0.0.1:${broker.port}/session`,
      page: url,
      fields: FIELDS.map(({ selector, index }) => ({ selector, index })),
    });
    assert.deepEqual(native, javascript);
  } finally {
    await driver.close().catch(() => {});
    removeTempDir(root);
  }
});
