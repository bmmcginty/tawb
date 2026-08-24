'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const { Keymap, readTerminfo } = require('../src/keys');
const { runKeyWizard, wizardRows } = require('../src/key_wizard');

test('terminfo key sequences are added to the portable fallbacks', () => {
  const calls = [];
  const terminfo = readTerminfo({
    env: { TERM: 'friend-terminal' },
    run: (_command, [capability]) => {
      calls.push(capability);
      return capability === 'knp'
        ? { status: 0, stdout: Buffer.from('\x1b[999~') }
        : { status: 1, stdout: Buffer.alloc(0) };
    },
  });
  const keys = new Keymap({ terminfo, load: false });
  assert.ok(calls.includes('knp'));
  assert.equal(keys.actionFor('\x1b[999~'), 'next-screen');
  assert.equal(keys.actionFor('\x1b[6~'), 'next-screen');
  assert.equal(keys.actionFor('\x1b[1;3D'), 'history-back');
  assert.equal(keys.actionFor('\x1b[3C'), 'history-forward');
  assert.equal(keys.actionFor('\x1b?'), 'keyboard-wizard');
  assert.equal(keys.nameForSequence('\x1b[999~'), 'PageDown');
  assert.equal(keys.nameForSequence('\x1b[1;3D'), 'Alt+ArrowLeft');
});

test('replacing and adding bindings resolves conflicts', () => {
  const keys = new Keymap({ terminfo: {}, load: false });
  const replaced = keys.assign('next-screen', 'x');
  assert.equal(replaced.binding, 'x');
  assert.equal(keys.actionFor('x'), 'next-screen');
  assert.equal(keys.actionFor('\x1b[6~'), null);

  const displaced = keys.assign('next-line', 'x', { add: true });
  assert.equal(displaced.displaced.id, 'next-screen');
  assert.equal(keys.actionFor('x'), 'next-line');
  assert.deepEqual(keys.byId.get('next-screen').bindings, []);
});

test('bindings are saved atomically and loaded over defaults', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tweb-keys-'));
  const file = path.join(directory, 'keys.json');
  const keys = new Keymap({ terminfo: {}, file, load: false });
  keys.assign('location-bar', '\x1bz');
  keys.unbind('quit');
  keys.save();

  const loaded = new Keymap({ terminfo: {}, file });
  assert.equal(loaded.actionFor('\x1bz'), 'location-bar');
  assert.equal(loaded.actionFor('\x0c'), null);
  assert.equal(loaded.actionFor('q'), null);
  assert.equal(loaded.actionFor('j'), 'next-line', 'unspecified future/default actions still load');
  assert.deepEqual(fs.readdirSync(directory), ['keys.json']);
});

test('the wizard asks about saving on its final row and ignores other answers', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tweb-wizard-'));
  const file = path.join(directory, 'keys.json');
  const keymap = new Keymap({ terminfo: {}, file, load: false });
  const rows = wizardRows(keymap);
  assert.equal(rows.at(-1).type, 'exit');

  const input = new PassThrough();
  const output = new PassThrough();
  output.rows = 12;
  output.columns = 80;
  const writes = [];
  const write = output.write.bind(output);
  output.write = (chunk) => { writes.push(String(chunk)); return write(chunk); };
  const queued = [
    '\x1b[B', '\x1b[A',
    ...Array.from({ length: rows.length - 1 }, () => '\x1b[B'),
    '\r', 'x', 'Y',
  ];
  let checkpoint = 0;
  let calls = 0;
  let afterDown = [];
  let afterUp = [];
  class FakeReader {
    next() {
      if (calls === 0) checkpoint = writes.length;
      if (calls === 1) { afterDown = writes.slice(checkpoint); checkpoint = writes.length; }
      if (calls === 2) afterUp = writes.slice(checkpoint);
      calls += 1;
      return Promise.resolve(queued.shift());
    }
    close() {}
  }

  const saved = await runKeyWizard({ input, output, keymap, KeyReaderClass: FakeReader });
  assert.equal(saved, true);
  assert.ok(fs.existsSync(file));
  assert.equal(queued.length, 0, 'the unrelated answer was consumed and ignored');
  assert.equal(writes.filter((chunk) => chunk === '\x1b[2J').length, 1,
    'only the initial screen is cleared');
  assert.equal(writes[0], '\x1b[?1049h', 'the wizard preserves the screen underneath');
  assert.ok(writes.includes('\x1b[?1049l'), 'the previous screen is restored on exit');
  assert.equal(afterDown.join('').includes('\x1b[2K'), false, 'Down only moves the cursor');
  assert.equal(afterUp.join('').includes('\x1b[2K'), false, 'Up only moves the cursor');
});

test('declining to save restores the bindings used before the wizard', async () => {
  const keymap = new Keymap({ terminfo: {}, load: false });
  const before = keymap.actions.map((action) => [action.id, [...action.bindings]]);
  const rows = wizardRows(keymap);
  const queued = [
    '\r', 'x',
    ...Array.from({ length: rows.length - 1 }, () => '\x1b[B'),
    '\r', 'n',
  ];
  const reader = { next: () => Promise.resolve(queued.shift()) };
  const input = new PassThrough();
  const output = new PassThrough();
  output.rows = 12;
  output.columns = 80;

  const saved = await runKeyWizard({ input, output, keymap, reader });
  assert.equal(saved, false);
  assert.deepEqual(keymap.actions.map((action) => [action.id, action.bindings]), before);
});

// A wizard that answered only to its own private keys was the one screen in
// the browser where the reader's own bindings did not work.
test('the wizard is driven by the browsing keys themselves', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tweb-wizard-keys-'));
  const file = path.join(directory, 'keys.json');
  const keymap = new Keymap({ terminfo: {}, file, load: false });
  const rows = wizardRows(keymap);

  const output = new PassThrough();
  output.rows = 12;
  output.columns = 200;
  const writes = [];
  const write = output.write.bind(output);
  output.write = (chunk) => { writes.push(String(chunk)); return write(chunk); };

  //  G bottom, = report position, Home back to the first row, = again,
  //  then q leaves the way it leaves the browser.
  const queued = ['G', '=', '\x1b[H', '=', 'q', 'y'];
  const reader = { next: () => Promise.resolve(queued.shift()) };

  const saved = await runKeyWizard({ input: new PassThrough(), output, keymap, reader });
  assert.equal(saved, true);
  assert.equal(queued.length, 0);
  assert.ok(fs.existsSync(file), 'q reached the same save question as the exit row');
  const painted = writes.join('');
  assert.ok(painted.includes(`Item ${rows.length} of ${rows.length}`), 'G reached the last row');
  assert.ok(painted.includes(`Item 1 of ${rows.length}`), 'Home returned to the first row');
});

test('Escape leaves the wizard even where the keys to read it were unbound', async () => {
  const keymap = new Keymap({ terminfo: {}, load: false });
  for (const action of keymap.actions) keymap.unbind(action.id);
  const before = keymap.actions.map((action) => [action.id, [...action.bindings]]);

  const queued = ['\x1b', 'n'];
  const reader = { next: () => Promise.resolve(queued.shift()) };
  const output = new PassThrough();
  output.rows = 12;
  output.columns = 80;

  const saved = await runKeyWizard({ input: new PassThrough(), output, keymap, reader });
  assert.equal(saved, false);
  assert.equal(queued.length, 0);
  assert.deepEqual(keymap.actions.map((action) => [action.id, action.bindings]), before,
    'declining restored the bindings the wizard started with');
});
