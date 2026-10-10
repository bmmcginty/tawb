'use strict';

// The keyboard wizard, differenced between the JavaScript original and the
// Crystal port: the same rows in the same order with the same words, the
// same prompts, and the same byte-level writes to a recorded terminal, both
// driven by the same scripted keys.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { tempDir } = require('./tmpdir');
const { keyWizardImplementations } = require('./crystal_impl');

const implementations = keyWizardImplementations(
  require('../src/keys'),
  require('../src/key_wizard'),
  require('../src/input'),
);

const writesOf = (result, key) => result.writes
  .filter((write) => write.key === key).map((write) => write.text).join('');
const painted = (result) => result.writes.map((write) => write.text).join('');

for (const implementation of implementations) {
  test(`${implementation.name}: the keyboard screen names Lynx functions for the Lynx interface`, () => {
    const rows = implementation.rows({ profile: 'lynx' });
    const list = rows.find((row) => row.actionId === 'list-links');
    assert.match(list.text, /^LIST — .*, l$/);
    // The extensions are named too, so they are findable rather than anonymous.
    const cycle = rows.find((row) => row.actionId === 'cycle-view');
    assert.match(cycle.text, /^TAWB_CYCLE_VIEW — /);

    // The ordinary interface has no such vocabulary and its rows are unchanged.
    const ordinary = implementation.rows({});
    const quit = ordinary.find((row) => row.actionId === 'quit');
    assert.match(quit.text, /^Quit, /);
  });

  test(`${implementation.name}: each keyboard screen offers only its own interface's actions`, () => {
    const offered = (rows) => new Set(rows
      .filter((row) => row.type === 'action').map((row) => row.actionId));
    const ordinaryIds = offered(implementation.rows({}));
    const lynxIds = offered(implementation.rows({ profile: 'lynx' }));
    for (const id of ['help', 'main-menu', 'options', 'document-info', 'list-links', 'source-view']) {
      assert.equal(ordinaryIds.has(id), false, `${id} is offered by the default wizard`);
      assert.equal(lynxIds.has(id), true, `${id} is missing from the Lynx wizard`);
    }
  });

  test(`${implementation.name}: unsupported imported commands are an inventory, not rows`, () => {
    const rows = implementation.rows({ profile: 'lynx', unsupported: ['SHELL'] });
    const heading = rows.find((row) => row.type === 'heading');
    assert.equal(heading.label, 'Lynx commands with no TAWB equivalent (cannot be bound):');
    const unsupported = rows.find((row) => row.type === 'unsupported');
    assert.equal(unsupported.label, 'Imported Lynx command SHELL, unsupported');
    const first = rows.findIndex((row) => row.type === 'unsupported');
    assert.ok(rows.slice(first).every((row) => row.type !== 'action'));
    // The screen ends with the reset and exit rows, whatever was imported.
    assert.deepEqual(rows.slice(-2).map((row) => row.type), ['reset', 'exit']);
  });

  test(`${implementation.name}: the wizard does not ask about a key held only by the other keyboard`, async () => {
    const file = path.join(tempDir(`tweb-wizard-keyboards-${implementation.name}-`), 'keys.json');
    const result = await implementation.run({
      file, rows: 12, cols: 200, probe: ['\x01'], editingProbe: ['\x01'],
      keys: ['\r', '\x01', '\x01', 'y'],
    });

    assert.equal(result.saved, true);
    assert.equal(painted(result).includes('is assigned to'), false,
      'no clash was reported for a key the other keyboard holds');
    const byId = Object.fromEntries(result.actions.map((action) => [action.id, action.bindings]));
    assert.deepEqual(byId.quit, ['Ctrl+A']);
    assert.deepEqual(byId['edit-line-start'], ['Ctrl+A']);
    assert.equal(result.probes['\x01'], 'quit');
    assert.equal(result.editingProbes['\x01'], 'edit-line-start');
  });

  test(`${implementation.name}: the wizard names the interface whose keys it edits`, async () => {
    for (const [profile, heading] of [['default', 'Keyboard bindings'], ['lynx', 'Lynx keyboard bindings']]) {
      const result = await implementation.run({ profile, rows: 12, cols: 200, keys: ['\x1b', 'n'] });
      assert.ok(painted(result).includes(heading), `${profile} wizard heading`);
    }
  });

  test(`${implementation.name}: the wizard asks about saving on its final row and ignores other answers`, async () => {
    const file = path.join(tempDir(`tweb-wizard-${implementation.name}-`), 'keys.json');
    const rows = await implementation.rows({ file });
    assert.equal(rows.at(-1).type, 'exit');

    const keys = [
      '\x1b[B', '\x1b[A',
      ...Array.from({ length: rows.length - 1 }, () => '\x1b[B'),
      '\r', 'x', 'Y',
    ];
    const result = await implementation.run({ file, rows: 12, cols: 80, keys });

    assert.equal(result.saved, true);
    assert.equal(result.fileExists, true);
    assert.equal(painted(result).split('\x1b[2J').length - 1, 1,
      'only the initial screen is cleared');
    assert.equal(result.writes[0].text, '\x1b[?1049h', 'the wizard preserves the screen underneath');
    assert.ok(result.writes.some((write) => write.text === '\x1b[?1049l'),
      'the previous screen is restored on exit');
    // Key 1 is the first Down, key 2 the Up: both only move the cursor.
    assert.equal(writesOf(result, 1).includes('\x1b[2K'), false, 'Down only moves the cursor');
    assert.equal(writesOf(result, 2).includes('\x1b[2K'), false, 'Up only moves the cursor');
  });

  test(`${implementation.name}: the wizard shares the session screen when it does not own one`, async () => {
    const result = await implementation.run({ rows: 12, cols: 80, altScreen: false, keys: ['\x1b', 'n'] });
    assert.equal(painted(result).includes('\x1b[?1049'), false,
      'a wizard sharing the session screen must not switch buffers');
    assert.ok(result.writes.some((write) => write.text === '\x1b[r'),
      'the shared screen still drops any scroll region');
  });

  test(`${implementation.name}: the cursor follows every prompt that consumes the next key`, async () => {
    const result = await implementation.run({
      rows: 12, cols: 200, keys: ['\r', 'j', 'n', 'q', 'n'],
    });
    const replacement = 'Press the replacement for Quit; Backspace unbinds it.';
    const conflict = 'j is assigned to Next line; rebind to Quit? y/n';
    const save = 'Save keyboard changes? y/n';
    // Writes made while a key was being processed are tagged with the number
    // of that key, counting from one; the cursor move is the last of them.
    const lastWrite = (key) => {
      const list = result.writes.filter((write) => write.key === key);
      return list.length ? list.at(-1).text : '';
    };
    assert.equal(lastWrite(1), `\x1b[12;${replacement.length + 1}H`);
    assert.equal(lastWrite(2), `\x1b[12;${conflict.length + 1}H`);
    assert.equal(lastWrite(4), `\x1b[12;${save.length + 1}H`);
  });

  test(`${implementation.name}: declining to save restores the bindings used before the wizard`, async () => {
    const rows = await implementation.rows({});
    const before = await implementation.run({ rows: 12, cols: 80, keys: [] });
    const keys = [
      '\r', 'x',
      ...Array.from({ length: rows.length - 1 }, () => '\x1b[B'),
      '\r', 'n',
    ];
    const result = await implementation.run({ rows: 12, cols: 80, keys });
    assert.equal(result.saved, false);
    assert.deepEqual(result.actions, before.actions);
  });

  test(`${implementation.name}: the wizard is driven by the browsing keys themselves`, async () => {
    const file = path.join(tempDir(`tweb-wizard-keys-${implementation.name}-`), 'keys.json');
    const rows = await implementation.rows({ file });

    //  G bottom, = report position, Home back to the first row, = again,
    //  then q leaves the way it leaves the browser.
    const result = await implementation.run({
      file, rows: 12, cols: 200, keys: ['G', '=', '\x1b[H', '=', 'q', 'y'],
    });
    assert.equal(result.saved, true);
    assert.equal(result.fileExists, true, 'q reached the same save question as the exit row');
    assert.ok(painted(result).includes(`Item ${rows.length} of ${rows.length}`), 'G reached the last row');
    assert.ok(painted(result).includes('Item 1 of ' + rows.length), 'Home returned to the first row');
  });

  test(`${implementation.name}: Escape leaves the wizard even where the keys to read it were unbound`, async () => {
    const before = await implementation.run({ rows: 12, cols: 80, unbindAll: true, keys: [] });
    const result = await implementation.run({
      rows: 12, cols: 80, unbindAll: true, keys: ['\x1b', 'n'],
    });
    assert.equal(result.saved, false);
    assert.deepEqual(result.actions, before.actions,
      'declining restored the bindings the wizard started with');
  });

  test(`${implementation.name}: rebinding a key another action holds is confirmed first`, async () => {
    const file = path.join(tempDir(`tweb-wizard-clash-${implementation.name}-`), 'keys.json');
    const rows = await implementation.rows({ file });
    assert.equal(rows[0].actionId, 'quit');

    //  Enter j n  refuses the swap, Enter j y  accepts it, Escape y  saves.
    const result = await implementation.run({
      file, rows: 12, cols: 200, probe: ['j'],
      keys: ['\r', 'j', 'n', '\r', 'j', 'y', '\x1b', 'y'],
    });
    assert.equal(result.saved, true);

    const screen = painted(result);
    assert.ok(screen.includes('j is assigned to Next line; rebind to Quit? y/n'),
      'the question names the key, what holds it, and what would take it');
    assert.ok(screen.includes('Binding unchanged.'), 'refusing left the key where it was');
    assert.equal(result.probes.j, 'quit', 'accepting moved the key');
    const byId = Object.fromEntries(result.actions.map((action) => [action.id, action.bindings]));
    assert.deepEqual(byId['next-line'], ['ArrowDown']);
  });
}
