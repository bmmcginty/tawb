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
  assert.equal(keys.actionFor('\x1b-'), 'history-back');
  assert.equal(keys.actionFor('\x1b+'), 'history-forward');
  assert.equal(keys.actionFor('\x1b[1;3D'), null);
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

test('the cursor follows every prompt that consumes the next key', async () => {
  const keymap = new Keymap({ terminfo: {}, load: false });
  const output = new PassThrough();
  output.rows = 12;
  output.columns = 200;
  const writes = [];
  const write = output.write.bind(output);
  output.write = (chunk) => { writes.push(String(chunk)); return write(chunk); };

  const queued = ['\r', 'j', 'n', 'q', 'n'];
  const beforeKey = [];
  const reader = {
    next: () => {
      beforeKey.push(writes.at(-1));
      return Promise.resolve(queued.shift());
    },
  };

  await runKeyWizard({ input: new PassThrough(), output, keymap, reader });

  const replacement = 'Press the replacement for Quit; Backspace unbinds it.';
  const conflict = 'j is assigned to Next line; rebind to Quit? y/n';
  const save = 'Save keyboard changes? y/n';
  assert.equal(beforeKey[1], `\x1b[12;${replacement.length + 1}H`);
  assert.equal(beforeKey[2], `\x1b[12;${conflict.length + 1}H`);
  assert.equal(beforeKey[4], `\x1b[12;${save.length + 1}H`);
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

// Silently taking a key away from something the reader still uses is the one
// edit in here they cannot see coming.
test('rebinding a key another action holds is confirmed first', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tweb-wizard-clash-'));
  const file = path.join(directory, 'keys.json');
  const keymap = new Keymap({ terminfo: {}, file, load: false });
  assert.equal(wizardRows(keymap)[0].action.id, 'quit');

  const output = new PassThrough();
  output.rows = 12;
  output.columns = 200;
  const writes = [];
  const write = output.write.bind(output);
  output.write = (chunk) => { writes.push(String(chunk)); return write(chunk); };

  //  Enter j n  refuses the swap, Enter j y  accepts it, Escape y  saves.
  const queued = ['\r', 'j', 'n', '\r', 'j', 'y', '\x1b', 'y'];
  const reader = { next: () => Promise.resolve(queued.shift()) };

  const saved = await runKeyWizard({ input: new PassThrough(), output, keymap, reader });
  assert.equal(saved, true);
  assert.equal(queued.length, 0);

  const painted = writes.join('');
  assert.ok(painted.includes('j is assigned to Next line; rebind to Quit? y/n'),
    'the question names the key, what holds it, and what would take it');
  assert.ok(painted.includes('Binding unchanged.'), 'refusing left the key where it was');
  assert.equal(keymap.actionFor('j'), 'quit', 'accepting moved the key');
  assert.deepEqual(keymap.byId.get('next-line').bindings, ['ArrowDown']);
});

test('a key nothing else holds is bound without a question', async () => {
  const keymap = new Keymap({ terminfo: {}, load: false });
  const output = new PassThrough();
  output.rows = 12;
  output.columns = 200;
  const writes = [];
  const write = output.write.bind(output);
  output.write = (chunk) => { writes.push(String(chunk)); return write(chunk); };

  const queued = ['\r', 'z', '\x1b', 'n'];
  const reader = { next: () => Promise.resolve(queued.shift()) };

  await runKeyWizard({ input: new PassThrough(), output, keymap, reader });
  assert.equal(queued.length, 0, 'no answer was consumed by a question that should not be asked');
  assert.ok(writes.join('').includes('z assigned to Quit.'));
});

// The wizard is where bindings get broken, so it has to survive the broken
// ones: a reader must never be able to strand themselves in this list.
test('the arrows, Enter and Escape work in the wizard whatever they are bound to', async () => {
  const keymap = new Keymap({ terminfo: {}, load: false });
  keymap.assign('refresh', '\x1b[B');   // Down now means something this list cannot do
  keymap.unbind('activate');
  keymap.unbind('quit');
  keymap.unbind('close-popup');

  const output = new PassThrough();
  output.rows = 12;
  output.columns = 200;
  const writes = [];
  const write = output.write.bind(output);
  output.write = (chunk) => { writes.push(String(chunk)); return write(chunk); };

  //  Down = to move and report, Enter Alt+Z to rebind there, Escape n to leave.
  const queued = ['\x1b[B', '=', '\r', '\x1bz', '\x1b', 'n'];
  const reader = { next: () => Promise.resolve(queued.shift()) };

  const saved = await runKeyWizard({ input: new PassThrough(), output, keymap, reader });
  assert.equal(saved, false, 'Escape reached the save question and n declined it');
  assert.equal(queued.length, 0);

  const painted = writes.join('');
  assert.ok(painted.includes('Item 2 of'), 'Down still moved the selection');
  assert.ok(painted.includes('Alt+Z assigned to Location bar.'), 'Enter still activated the row');
});
