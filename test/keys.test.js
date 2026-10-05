'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const { tempDir } = require('./tmpdir');

const {
  Keymap, configPath, readTerminfo, rawSpec, LYNX_KEY_DEFINITIONS,
} = require('../src/keys');
const { parseBrowseMap } = require('../src/lynx_config');
const { runKeyWizard, wizardRows } = require('../src/key_wizard');

test('interface profiles keep their defaults and saved files separate', () => {
  const home = '/home/reader';
  const env = { XDG_CONFIG_HOME: '/config' };
  assert.equal(configPath(env, home), '/config/tawb/keys.json');
  assert.equal(configPath(env, home, 'lynx'), '/config/tawb/keys-lynx.json');

  const ordinary = new Keymap({ terminfo: {}, load: false });
  const lynx = new Keymap({ terminfo: {}, profile: 'lynx', load: false });
  assert.equal(ordinary.actionFor('g'), 'top');
  assert.equal(lynx.actionFor('g'), 'goto');
  assert.equal(lynx.actionFor('G'), 'location-edit');
  assert.equal(lynx.actionFor('\\'), 'source-view');
  assert.equal(lynx.actionFor('\x1b[D'), 'history-back');
  assert.equal(lynx.actionFor('\x1b[C'), 'activate');
  assert.equal(lynx.actionFor(' '), 'next-screen');
  assert.equal(lynx.actionFor('b'), 'previous-screen');
  assert.equal(lynx.actionFor('\x1b[B'), 'next-focusable');
  assert.equal(lynx.actionFor('\x1b[A'), 'previous-focusable');
  assert.equal(lynx.actionFor('k'), 'keyboard-wizard');
  assert.equal(lynx.actionFor('0'), 'link-number');
  assert.equal(lynx.editingActionFor('\x01'), 'edit-line-start');
  assert.equal(lynx.editingActionFor('\x0e'), 'edit-next-word');
  assert.equal(lynx.editingActionFor('\x10'), 'edit-previous-word');
});

test('effective standard, vi, and Emacs Lynx maps drive their familiar keys', () => {
  const imported = (name) => parseBrowseMap(fs.readFileSync(
    path.join(__dirname, 'fixtures', `lynx-keymap-${name}.txt`), 'utf8')).bindings;

  const standard = new Keymap({
    terminfo: {}, profile: 'lynx', load: false, bindings: imported('standard'),
  });
  assert.equal(standard.actionFor('G'), 'location-edit');
  assert.equal(standard.actionFor('0'), 'link-number');
  assert.equal(standard.actionFor('l'), 'list-links');
  assert.equal(standard.actionFor('\x1bOP'), 'help',
    'an imported function-key binding resolves through the Lynx vocabulary');

  const vi = new Keymap({
    terminfo: {}, profile: 'lynx', load: false, bindings: imported('vi'),
  });
  assert.equal(vi.actionFor('h'), 'history-back');
  assert.equal(vi.actionFor('j'), 'next-focusable');
  assert.equal(vi.actionFor('k'), 'previous-focusable');
  assert.equal(vi.actionFor('l'), 'activate');
  assert.equal(vi.actionFor('L'), 'list-links');

  const emacs = new Keymap({
    terminfo: {}, profile: 'lynx', load: false, bindings: imported('emacs'),
  });
  assert.equal(emacs.actionFor('\x02'), 'history-back');
  assert.equal(emacs.actionFor('\x06'), 'activate');
  assert.equal(emacs.actionFor('\x0e'), 'next-focusable');
  assert.equal(emacs.actionFor('\x10'), 'previous-focusable');
});

test('imported Lynx defaults reset cleanly and expose unsupported commands', () => {
  const keys = new Keymap({
    terminfo: {}, profile: 'lynx', load: false,
    bindings: { quit: ['x'] }, unsupported: ['SHELL'],
  });
  assert.equal(keys.actionFor('x'), 'quit');
  keys.assign('quit', '~');
  keys.reset();
  assert.equal(keys.actionFor('x'), 'quit');
  assert.equal(keys.actionFor('~'), null);
  assert.ok(wizardRows(keys).some((row) => row.type === 'unsupported' && /SHELL/.test(row.label)));
  // The unsupported commands come after a heading, so the list reads as an
  // inventory rather than as rows a key could be put on.
  const rows = wizardRows(keys);
  const heading = rows.findIndex((row) => row.type === 'heading');
  const first = rows.findIndex((row) => row.type === 'unsupported');
  assert.ok(heading >= 0, 'no heading before the unsupported commands');
  assert.ok(heading < first, 'the heading does not precede the commands');
  assert.ok(rows.slice(first).every((row) => row.type !== 'action'));
});

test('the version-one default key file still loads without conversion', () => {
  const directory = tempDir('tawb-old-keys-');
  const file = path.join(directory, 'keys.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, actions: { quit: ['x'] } }));

  const keys = new Keymap({ terminfo: {}, file });
  assert.equal(keys.actionFor('x'), 'quit');
  assert.equal(keys.actionFor('q'), null);
  assert.equal(keys.actionFor('j'), 'next-line');
});

test('an old Lynx key file wins over a new built-in action on the same key', () => {
  const directory = tempDir('tawb-old-lynx-keys-');
  const file = path.join(directory, 'keys-lynx.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, actions: { quit: ['x'] } }));
  const keys = new Keymap({ terminfo: {}, profile: 'lynx', file });
  assert.equal(keys.actionFor('x'), 'quit');
  assert.equal(keys.byId.get('reload-no-cache').bindings.includes('x'), false);
});

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
  assert.equal(keys.actionFor('\x14'), 'new-tab');
  assert.equal(keys.actionFor('\x1bd'), 'download-link');
  // Alt of the click key: m clicks the line, Alt+M puts the pointer on it
  // without pressing, which is how a dropdown menu is opened.
  assert.equal(keys.actionFor('m'), 'real-click');
  assert.equal(keys.actionFor('\x1bm'), 'hover-line');
  // Browsing and editing are separate keyboards on the same key, the way
  // Ctrl+D already is: Alt+D downloads a link while reading a page and
  // deletes the next word while a field is being edited.
  assert.equal(keys.editingActionFor('\x1bd'), 'edit-delete-word');
  assert.equal(keys.nameForSequence('\x1b[999~'), 'PageDown');
  assert.equal(keys.nameForSequence('\x1b[1;3D'), 'Alt+ArrowLeft');
  assert.equal(keys.actionFor('\x1b[15~'), 'reload-page');
  assert.equal(keys.nameForSequence('\x1b[15~'), 'F5');
});

test('function keys are named only for the Lynx profile', () => {
  const ordinary = new Keymap({ terminfo: {}, load: false });
  assert.equal(ordinary.nameForSequence('\x1bOQ'), rawSpec('\x1bOQ'));
  assert.deepEqual(ordinary.sequencesFor('F2'), []);

  const lynx = new Keymap({ terminfo: {}, profile: 'lynx', load: false });
  assert.equal(lynx.nameForSequence('\x1bOQ'), 'F2');
  assert.deepEqual(lynx.sequencesFor('F2'), ['\x1bOQ', '\x1b[12~', '\x1b[[B']);
  assert.equal(lynx.actionFor('\x1bOP'), null, 'having a name is not a binding');
});

test('the shared terminfo table never asks for the Lynx-only function keys', () => {
  const asked = [];
  readTerminfo({
    env: { TERM: 'friend-terminal' },
    run: (_command, [capability]) => {
      asked.push(capability);
      return { status: 1, stdout: Buffer.alloc(0) };
    },
  });
  assert.ok(asked.includes('knp'));
  assert.ok(!asked.includes('kf2'));
  assert.equal(LYNX_KEY_DEFINITIONS.F2.cap, 'kf2');
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

// Browsing and editing are two keyboards on the same keys. A key they share
// costs neither of them anything, because neither action can be reached while
// the other keyboard is the one in use.
test('a key shared between the browsing and editing keyboards is not a conflict', () => {
  const keys = new Keymap({ terminfo: {}, load: false });

  // Alt+D downloads a link while reading and deletes the next word while
  // typing. Neither action is a clash for the other.
  assert.deepEqual(keys.conflicts('download-link', 'Alt+D'), []);
  assert.deepEqual(keys.conflicts('edit-delete-word', 'Alt+D'), []);

  // Ctrl+A belongs to an editing action alone, so a browsing action may take
  // Ctrl+A without the editing action being named or losing the key.
  assert.deepEqual(keys.conflicts('downloads', 'Ctrl+A'), []);
  const result = keys.assign('downloads', '\x01');
  assert.equal(result.binding, 'Ctrl+A');
  assert.equal(result.displaced, null);
  assert.deepEqual(keys.byId.get('edit-line-start').bindings, ['Ctrl+A']);
  assert.equal(keys.actionFor('\x01'), 'downloads');
  assert.equal(keys.editingActionFor('\x01'), 'edit-line-start');

  // Two actions on the same keyboard still take the key from each other.
  assert.deepEqual(
    keys.conflicts('download-link', 'h').map((action) => action.id), ['next-heading']);
  // line-start is one of the four movements a field shares with a line, so
  // line-start belongs to both keyboards and is answered a clash from both:
  // the downloads action just given Ctrl+A on the browsing keyboard, and
  // edit-line-start which has always held Ctrl+A on the editing keyboard.
  assert.deepEqual(
    keys.conflicts('line-start', 'Ctrl+A').map((action) => action.id).sort(),
    ['downloads', 'edit-line-start']);
});

test('the wizard does not ask about a key held only by the other keyboard', async () => {
  const directory = tempDir('tweb-wizard-keyboards-');
  const file = path.join(directory, 'keys.json');
  const keymap = new Keymap({ terminfo: {}, file, load: false });
  const output = new PassThrough();
  output.rows = 12;
  output.columns = 200;
  const writes = [];
  const write = output.write.bind(output);
  output.write = (chunk) => { writes.push(String(chunk)); return write(chunk); };

  // Quit is the first row. Replace its binding with Ctrl+A, which only
  // edit-line-start holds, then use the new binding to leave and save.
  const queued = ['\r', '\x01', '\x01', 'y'];
  const reader = { next: () => Promise.resolve(queued.shift()) };

  const saved = await runKeyWizard({ input: new PassThrough(), output, keymap, reader });

  assert.equal(saved, true);
  assert.equal(writes.join('').includes('is assigned to'), false,
    'no clash was reported for a key the other keyboard holds');
  assert.deepEqual(keymap.byId.get('quit').bindings, ['Ctrl+A']);
  assert.deepEqual(keymap.byId.get('edit-line-start').bindings, ['Ctrl+A']);
  assert.equal(keymap.actionFor('\x01'), 'quit');
  assert.equal(keymap.editingActionFor('\x01'), 'edit-line-start');
});

test('the wizard names the interface whose keys it edits', async () => {
  for (const [profile, heading] of [['default', 'Keyboard bindings'], ['lynx', 'Lynx keyboard bindings']]) {
    const keymap = new Keymap({ terminfo: {}, profile, load: false });
    const output = new PassThrough();
    output.rows = 12;
    output.columns = 200;
    const writes = [];
    const write = output.write.bind(output);
    output.write = (chunk) => { writes.push(String(chunk)); return write(chunk); };
    const queued = ['\x1b', 'n'];
    const reader = { next: () => Promise.resolve(queued.shift()) };
    await runKeyWizard({ input: new PassThrough(), output, keymap, reader });
    assert.ok(writes.join('').includes(heading), `${profile} wizard heading`);
  }
});

test('bindings are saved atomically and loaded over defaults', () => {
  const directory = tempDir('tweb-keys-');
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
  const directory = tempDir('tweb-wizard-');
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
  const directory = tempDir('tweb-wizard-keys-');
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
  const directory = tempDir('tweb-wizard-clash-');
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
