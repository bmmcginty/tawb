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
  assert.equal(keys.nameForSequence('\x1b[999~'), 'PageDown');
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

test('the wizard exits only through its final row and ignores other save answers', async () => {
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

  await runKeyWizard({ input, output, keymap, KeyReaderClass: FakeReader });
  assert.ok(fs.existsSync(file));
  assert.equal(queued.length, 0, 'the unrelated answer was consumed and ignored');
  assert.equal(writes.filter((chunk) => chunk === '\x1b[2J').length, 1,
    'only the initial screen is cleared');
  assert.equal(afterDown.join('').includes('\x1b[2K'), false, 'Down only moves the cursor');
  assert.equal(afterUp.join('').includes('\x1b[2K'), false, 'Up only moves the cursor');
});
