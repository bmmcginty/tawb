'use strict';

// The keymap, differenced between the JavaScript original and the Crystal
// port: the same profiles, the same files, the same presses, the same
// rebindings — every question the reader and the wizard ask about keys must
// have the same answer on both runtimes, and each runtime must be able to
// read the file the other one wrote.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { tempDir } = require('./tmpdir');
const { keymapImplementations } = require('./crystal_impl');
const keysModule = require('../src/keys');
const { Keymap, actionsFor, rawSpec } = keysModule;
const { parseBrowseMap } = require('../src/lynx_config');

const ORDINARY = { profile: 'default', terminfo: {}, load: false };
const LYNX = { profile: 'lynx', terminfo: {}, load: false };

for (const implementation of keymapImplementations(keysModule)) {
  const check = (name, fn) => test(`${implementation.name}: ${name}`, fn);

  // The keymap questions are stateless: each one rebuilds the keymap from
  // the spec it is given. A sequence of mutations therefore carries the
  // returned bindings forward, the way the reader's own keymap carries them.
  const carry = (spec, result) => {
    spec.bindings = Object.fromEntries(result.actions.map((action) => [action.id, action.bindings]));
    return spec;
  };

  check('the action table agrees for every profile', () => {
    for (const profile of ['default', 'lynx']) {
      assert.deepEqual(implementation.actionsFor(profile), actionsFor(profile).map((action) => ({
        id: action.id, label: action.label, defaults: action.defaults,
      })), profile);
    }
  });

  check('interface profiles keep their defaults and saved files separate', () => {
    assert.equal(implementation.configPath('/config', '/home/reader'), '/config/tawb/keys.json');
    assert.equal(implementation.configPath('/config', '/home/reader', 'lynx'), '/config/tawb/keys-lynx.json');

    assert.equal(implementation.actionFor(ORDINARY, 'g'), 'top');
    for (const [chunk, expected] of [
      ['g', 'goto'], ['G', 'location-edit'], ['\\', 'source-view'],
      ['\x1b[D', 'history-back'], ['\x1b[C', 'activate'], [' ', 'next-screen'],
      ['b', 'previous-screen'], ['\x1b[B', 'next-focusable'], ['\x1b[A', 'previous-focusable'],
      ['k', 'keyboard-wizard'], ['0', 'link-number'],
    ]) {
      assert.equal(implementation.actionFor(LYNX, chunk), expected, JSON.stringify(chunk));
    }
    assert.equal(implementation.editingActionFor(LYNX, '\x01'), 'edit-line-start');
    assert.equal(implementation.editingActionFor(LYNX, '\x0e'), 'edit-next-word');
    assert.equal(implementation.editingActionFor(LYNX, '\x10'), 'edit-previous-word');
  });

  check('effective standard, vi, and Emacs Lynx maps drive their familiar keys', () => {
    const imported = (name) => parseBrowseMap(fs.readFileSync(
      path.join(__dirname, 'fixtures', `lynx-keymap-${name}.txt`), 'utf8')).bindings;
    for (const [name, probes] of [
      ['standard', [['G', 'location-edit'], ['0', 'link-number'], ['l', 'list-links'],
        ['\x1bOP', 'context-help']]],
      ['vi', [['h', 'history-back'], ['j', 'next-focusable'], ['k', 'previous-focusable'],
        ['l', 'activate'], ['L', 'list-links']]],
      ['emacs', [['\x02', 'history-back'], ['\x06', 'activate'], ['\x0e', 'next-focusable'],
        ['\x10', 'previous-focusable']]],
    ]) {
      const spec = { profile: 'lynx', terminfo: {}, load: false, bindings: imported(name) };
      for (const [chunk, expected] of probes) {
        assert.equal(implementation.actionFor(spec, chunk), expected, `${name}: ${JSON.stringify(chunk)}`);
      }
    }
  });

  check('imported Lynx defaults reset cleanly and expose unsupported commands', () => {
    const spec = {
      profile: 'lynx', terminfo: {}, load: false,
      bindings: { 'list-links': ['x'] }, unsupported: ['SHELL'],
    };
    assert.equal(implementation.actionFor(spec, 'x'), 'list-links');
    assert.equal(implementation.assign(spec, 'list-links', '~').binding, '~');
    const list = implementation.reset(spec).actions.find((action) => action.id === 'list-links');
    assert.deepEqual(list.bindings, ['x']);
    assert.equal(implementation.actionFor(spec, '~'), null);
    const snapshot = implementation.snapshot(spec);
    assert.deepEqual(snapshot.unsupported, ['SHELL']);
    assert.equal(snapshot.function_names['list-links'], 'LIST');
  });

  check('the version-one default key file still loads without conversion', () => {
    const directory = tempDir('tawb-old-keys-crystal-');
    const file = path.join(directory, 'keys.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, actions: { quit: ['x'] } }));
    const spec = { profile: 'default', terminfo: {}, file };
    try {
      assert.equal(implementation.actionFor(spec, 'x'), 'quit');
      assert.equal(implementation.actionFor(spec, 'q'), null);
      assert.equal(implementation.actionFor(spec, 'j'), 'next-line');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  check('an old Lynx key file wins over a new built-in action on the same key', () => {
    const directory = tempDir('tawb-old-lynx-keys-crystal-');
    const file = path.join(directory, 'keys-lynx.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, actions: { 'list-links': ['x'] } }));
    const spec = { profile: 'lynx', terminfo: {}, file };
    try {
      assert.equal(implementation.actionFor(spec, 'x'), 'list-links');
      const reload = implementation.snapshot(spec).actions.find((action) => action.id === 'reload-no-cache');
      assert.equal(reload.bindings.includes('x'), false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  check('terminfo key sequences are added to the portable fallbacks', () => {
    const spec = { profile: 'default', load: false, terminfo: { PageDown: '\x1b[999~' } };
    assert.equal(implementation.actionFor(spec, '\x1b[999~'), 'next-screen');
    assert.equal(implementation.actionFor(spec, '\x1b[6~'), 'next-screen');
    assert.equal(implementation.actionFor(spec, '\x1b-'), 'history-back');
    assert.equal(implementation.actionFor(spec, '\x1b+'), 'history-forward');
    assert.equal(implementation.actionFor(spec, '\x1b[1;3D'), null);
    assert.equal(implementation.actionFor(spec, '\x1b?'), 'keyboard-wizard');
    assert.equal(implementation.actionFor(spec, '\x14'), 'new-tab');
    assert.equal(implementation.actionFor(spec, '\x1bd'), 'download-link');
    // Alt of the click key: m clicks the line, Alt+M puts the pointer on it
    // without pressing, which is how a dropdown menu is opened.
    assert.equal(implementation.actionFor(spec, 'm'), 'real-click');
    assert.equal(implementation.actionFor(spec, '\x1bm'), 'hover-line');
    // Browsing and editing are separate keyboards on the same key, the way
    // Ctrl+D already is: Alt+D downloads a link while reading a page and
    // deletes the next word while a field is being edited.
    assert.equal(implementation.editingActionFor(spec, '\x1bd'), 'edit-delete-word');
    assert.equal(implementation.nameForSequence(spec, '\x1b[999~'), 'PageDown');
    assert.equal(implementation.nameForSequence(spec, '\x1b[1;3D'), 'Alt+ArrowLeft');
    assert.equal(implementation.actionFor(spec, '\x1b[15~'), 'reload-page');
    assert.equal(implementation.nameForSequence(spec, '\x1b[15~'), 'F5');
  });

  check('the terminal answers the shared capabilities identically', async () => {
    const term = 'xterm';
    const expected = await implementation.readTerminfo(term);
    assert.deepEqual(await implementation.readTerminfo(term), expected);
    // The shared table never asks for the Lynx-only function keys, so a
    // terminal that answers everything answers the same names on both.
    assert.equal('F2' in expected, false);
  });

  check('function keys are named only for the Lynx profile', () => {
    assert.equal(implementation.nameForSequence(ORDINARY, '\x1bOQ'), rawSpec('\x1bOQ'));
    assert.deepEqual(implementation.sequencesFor(ORDINARY, 'F2'), []);
    assert.equal(implementation.nameForSequence(LYNX, '\x1bOQ'), 'F2');
    assert.deepEqual(implementation.sequencesFor(LYNX, 'F2'), ['\x1bOQ', '\x1b[12~', '\x1b[[B']);
    assert.equal(implementation.actionFor(LYNX, '\x1bOQ'), null, 'F2 is named but not bound');
    assert.equal(implementation.actionFor(LYNX, '\x1bOP'), 'context-help', 'F1 is DWIMHELP in Lynx');
  });

  check('replacing and adding bindings resolves conflicts', () => {
    const spec = { profile: 'default', terminfo: {}, load: false };
    const replaced = implementation.assign(spec, 'next-screen', 'x');
    assert.equal(replaced.binding, 'x');
    assert.equal(replaced.displaced, null);
    carry(spec, replaced);
    assert.equal(implementation.actionFor(spec, 'x'), 'next-screen');
    assert.equal(implementation.actionFor(spec, '\x1b[6~'), null);

    const added = implementation.assign(carry(spec, replaced), 'next-line', 'x', true);
    assert.equal(added.displaced, 'next-screen');
    carry(spec, added);
    assert.equal(implementation.actionFor(spec, 'x'), 'next-line');
    assert.deepEqual(added.actions.find((action) => action.id === 'next-screen').bindings, []);
  });

  check('a key shared between the browsing and editing keyboards is not a conflict', () => {
    // Alt+D downloads a link while reading and deletes the next word while
    // typing. Neither action is a clash for the other.
    assert.deepEqual(implementation.conflicts(ORDINARY, 'download-link', 'Alt+D'), []);
    assert.deepEqual(implementation.conflicts(ORDINARY, 'edit-delete-word', 'Alt+D'), []);

    // Ctrl+A belongs to an editing action alone, so a browsing action may
    // take Ctrl+A without the editing action being named or losing the key.
    assert.deepEqual(implementation.conflicts(ORDINARY, 'downloads', 'Ctrl+A'), []);
    const spec = { profile: 'default', terminfo: {}, load: false };
    const result = implementation.assign(spec, 'downloads', '\x01');
    assert.equal(result.binding, 'Ctrl+A');
    assert.equal(result.displaced, null);
    assert.deepEqual(result.actions.find((action) => action.id === 'edit-line-start').bindings, ['Ctrl+A']);
    const after = carry(spec, result);
    assert.equal(implementation.actionFor(after, '\x01'), 'downloads');
    assert.equal(implementation.editingActionFor(after, '\x01'), 'edit-line-start');

    // Two actions on the same keyboard still take the key from each other.
    assert.deepEqual(implementation.conflicts(after, 'download-link', 'h'), ['next-heading']);
    // line-start is one of the four movements a field shares with a line, so
    // line-start belongs to both keyboards and is answered a clash from both:
    // the downloads action just given Ctrl+A on the browsing keyboard, and
    // edit-line-start which has always held Ctrl+A on the editing keyboard.
    assert.deepEqual(implementation.conflicts(after, 'line-start', 'Ctrl+A').sort(),
      ['downloads', 'edit-line-start']);
  });

  check('bindings are saved atomically and loaded over defaults', () => {
    const directory = tempDir('tawb-keys-crystal-');
    const file = path.join(directory, 'keys.json');
    const spec = { profile: 'default', terminfo: {}, file, load: false };
    try {
      assert.equal(implementation.assign(spec, 'location-bar', '\x1bz').binding, 'Alt+Z');
      const rebound = implementation.assign(spec, 'location-bar', '\x1bz');
      const unbound = implementation.unbind(carry(spec, rebound), 'quit');
      implementation.save(carry(spec, unbound));

      const loaded = { profile: 'default', terminfo: {}, file };
      assert.equal(implementation.actionFor(loaded, '\x1bz'), 'location-bar');
      assert.equal(implementation.actionFor(loaded, '\x0c'), null);
      assert.equal(implementation.actionFor(loaded, 'q'), null);
      assert.equal(implementation.actionFor(loaded, 'j'), 'next-line',
        'unspecified future/default actions still load');
      assert.deepEqual(fs.readdirSync(directory), ['keys.json']);

      // The file this runtime wrote loads on the other one unchanged.
      const cross = new Keymap({ terminfo: {}, file });
      assert.equal(cross.actionFor('\x1bz'), 'location-bar');
      assert.equal(cross.actionFor('q'), null);
      assert.equal(cross.actionFor('j'), 'next-line');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  check('the Lynx keymap saves by function name, in its own file', () => {
    const directory = tempDir('tawb-lynx-keyfile-crystal-');
    const file = path.join(directory, 'keys-lynx.json');
    const spec = { profile: 'lynx', terminfo: {}, file, load: false };
    try {
      const first = implementation.assign(spec, 'list-links', 'x');
      const second = implementation.assign(carry(spec, first), 'cycle-view', '\x0f');
      const third = implementation.unbind(carry(spec, second), 'source-view');
      implementation.save(carry(spec, third));

      const written = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(written.version, 2);
      assert.deepEqual(written.functions.LIST, ['x']);
      assert.deepEqual(written.functions.TAWB_CYCLE_VIEW, ['Ctrl+O']);
      assert.deepEqual(written.functions.SOURCE, []);
      assert.equal(Object.hasOwn(written, 'actions'), false, 'an action-keyed document was written');

      const loaded = { profile: 'lynx', terminfo: {}, file };
      assert.equal(implementation.actionFor(loaded, 'x'), 'list-links');
      assert.equal(implementation.actionFor(loaded, '\x0f'), 'cycle-view');
      assert.equal(implementation.actionFor(loaded, '\\'), null, 'the saved unbinding did not arrive');

      // The file this runtime wrote loads on the other one unchanged.
      const cross = new Keymap({ terminfo: {}, profile: 'lynx', file });
      assert.equal(cross.actionFor('x'), 'list-links');
      assert.equal(cross.actionFor('\x0f'), 'cycle-view');
      assert.equal(cross.actionFor('\\'), null);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  check('a version-1 Lynx file is read and re-saved by function name', () => {
    const directory = tempDir('tawb-lynx-keyfile-old-crystal-');
    const file = path.join(directory, 'keys-lynx.json');
    fs.writeFileSync(file, JSON.stringify({
      version: 1, actions: { 'list-links': ['x'], 'source-view': ['y'] },
    }));
    const loaded = { profile: 'lynx', terminfo: {}, file };
    try {
      assert.equal(implementation.actionFor(loaded, 'x'), 'list-links');
      assert.equal(implementation.actionFor(loaded, 'y'), 'source-view');
      implementation.save(loaded);
      const written = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(written.version, 2);
      assert.deepEqual(written.functions.LIST, ['x']);
      assert.deepEqual(written.functions.SOURCE, ['y']);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  check('the keyboard screen labels come from the policy', () => {
    assert.deepEqual(implementation.snapshot(ORDINARY).labels,
      { keyboardTitle: 'Keyboard bindings' });
    assert.deepEqual(implementation.snapshot(LYNX).labels, {
      keyboardTitle: 'Lynx keyboard bindings',
      unsupportedHeading: 'Lynx commands with no TAWB equivalent (cannot be bound):',
      unsupportedPrefix: 'Imported Lynx command',
    });
  });
}
