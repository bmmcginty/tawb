'use strict';

// The dialog the browser drew for itself, as the reader meets it on the
// terminal, differenced between the JavaScript original and the Crystal port.
//
// The question itself comes from the accessibility bus (see
// `native_prompt_crystal.test.js` for that half). What is compared here is
// everything after the question arrives: the lines it becomes, what moving and
// pressing do, which button is pressed and which is not, and what a reader is
// told afterwards. The dialog is scripted on both sides, because the screen
// does not know where its question came from and should not have to.

const test = require('node:test');
const assert = require('node:assert');
const { readerImplementations } = require('./crystal_impl');

const implementations = readerImplementations(require('../src/index'), require('../src/keys'));
const skip = implementations.length < 2 ? 'the Crystal runtime is not enabled' : false;
const PAGE = 'https://example.test/store';

const DOWN = '\u001b[B';
const ESCAPE = '\u001b';

const blocks = [
  { text: 'uBlock Origin Lite', item: { role: 'heading' } },
  { text: 'Add to Chrome', item: { role: 'button', name: 'Add to Chrome' } },
];

function state(overrides = {}) {
  return {
    rows: 24,
    cols: 80,
    mode: 'browse',
    interface: 'default',
    title: 'Chrome Web Store',
    cursor: 1,
    col: 0,
    scroll: 0,
    statusMsg: '',
    drawn: {},
    linkAddress: false,
    lines: [
      { text: 'uBlock Origin Lite', blockIndex: 0 },
      { text: 'Add to Chrome', blockIndex: 1 },
    ],
    keys: { bindings: { 'browser-question': ['Alt+Q'] } },
    core: {
      source: 'ax',
      blocks,
      popup: null,
      popupAt: -1,
      live: { enabled: true, dirty: false, refreshing: false, snapshotCostMs: 0 },
    },
    ...overrides,
  };
}

// Chrome's install confirmation, as the accessibility bus answers it: the
// heading, what the extension will be able to do, an option to tick, and two
// buttons of which Cancel is the one Chrome itself has ready.
const INSTALL = {
  role: 'alert',
  title: 'Add "uBlock Origin Lite"?',
  lines: [
    'Add "uBlock Origin Lite"?',
    'It can:',
    'Read and change all your data on all websites',
  ],
  buttons: [
    { name: 'Cancel', focused: true, isDefault: true },
    { name: 'Add extension' },
  ],
  toggles: [{ name: 'Allow it in private windows' }],
  fields: [],
};

const SAVE_PASSWORD = {
  role: 'alert',
  title: 'Save password?',
  lines: ['Save password?'],
  buttons: [{ name: 'Never' }, { name: 'Save', focused: true, isDefault: true }],
  toggles: [],
  fields: [
    { name: 'Username', value: 'reader' },
    { name: 'Password', value: 'MASKED' },
  ],
};

// A GTK file chooser as the accessibility bus describes one: what it is
// browsing, a location field that can be typed into, the widget's own
// show-location action, and the two answers.
const CHOOSER = {
  role: 'file chooser',
  title: 'Choose Download Folder',
  lines: ['Places'],
  buttons: [{ name: 'Cancel' }, { name: 'Open', focused: true, isDefault: true }],
  toggles: [],
  fields: [{ name: 'Location', value: '/home/reader', editable: true }],
  actions: [{ name: 'Enter Location' }],
};

async function both(name, initial, actions, page = { url: PAGE, title: 'Chrome Web Store' }) {
  const out = [];
  for (const implementation of implementations) {
    const spec = JSON.parse(JSON.stringify({ state: initial, actions, page }));
    out.push(await (implementation.drawAsync
      ? implementation.drawAsync(spec)
      : implementation.draw(spec)));
  }
  assert.deepEqual(out[1].state, out[0].state, name);
  assert.deepEqual(out[1].results, out[0].results, name);
  return out[0];
}

test('a dialog becomes the lines it says and the choices it offers', { skip }, async () => {
  const result = await both('dialog blocks', state(), [
    { op: 'dialogBlocks', dialog: INSTALL },
  ]);
  // The words first, then what the dialog is about, then a gap, then the
  // option, then a gap, then the answers. The option comes before the answers
  // because an option changes what answering means.
  assert.deepEqual(result.results[0].value, [
    { text: 'Add "uBlock Origin Lite"?', button: null, toggle: null },
    { text: 'It can:', button: null, toggle: null },
    { text: 'Read and change all your data on all websites', button: null, toggle: null },
    { text: '', button: null, toggle: null },
    { text: '[ ] Allow it in private windows', button: null, toggle: 'Allow it in private windows' },
    { text: '', button: null, toggle: null },
    { text: 'Cancel', button: 'Cancel', toggle: null },
    { text: 'Add extension', button: 'Add extension', toggle: null },
  ]);
});

test('a save-password prompt shows what it is about to keep', { skip }, async () => {
  const result = await both('credential blocks', state(), [
    { op: 'dialogBlocks', dialog: SAVE_PASSWORD },
  ]);
  // Otherwise the prompt says "Username" twice and never says whose password
  // it is keeping. The password arrives already masked, because the browser
  // masks it.
  assert.deepEqual(result.results[0].value.map((block) => block.text), [
    'Save password?',
    'Username: reader',
    'Password: MASKED',
    '',
    'Never',
    'Save',
  ]);
});

test('a dialog with nothing to press says so rather than offering nothing', { skip }, async () => {
  const result = await both('empty dialog blocks', state(), [
    {
      op: 'dialogBlocks',
      dialog: {
        role: 'dialog', title: 'Working', lines: ['Working'],
        buttons: [], toggles: [], fields: [],
      },
    },
  ]);
  assert.deepEqual(result.results[0].value.map((block) => block.text), [
    'Working',
    '(the browser offers nothing to press)',
  ]);
});

test('the reader moves to an answer and presses it', { skip }, async () => {
  const result = await both('press the chosen button', state(), [
    {
      op: 'answerDialog',
      dialog: INSTALL,
      // Down past the three lines, the gap, the option and the second gap to
      // Cancel, once more to Add extension, then Enter.
      keys: [DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, '\r'],
    },
  ]);
  assert.deepEqual(result.results[0].value.pressed, ['Add extension']);
  assert.deepEqual(result.results[0].value.toggled, []);
  // Answered, so there is nothing left to come back to.
  assert.equal(result.results[0].value.pending, false);
  assert.equal(result.state.mode, 'browse');
  // And the reader is back where they were on the page, not at the top of it.
  assert.equal(result.state.cursor, 1);
  assert.equal(result.state.title, 'Chrome Web Store');
  assert.match(result.state.statusMsg, /Pressed "Add extension"/);
});

test('Escape presses nothing and leaves the question open', { skip }, async () => {
  const result = await both('escape leaves it alone', state(), [
    { op: 'answerDialog', dialog: INSTALL, keys: [ESCAPE] },
  ]);
  // Escaping used to press whichever button the dialog had focused, on the
  // grounds that the focused button was the browser's own safe answer - and on
  // Chrome's install prompt it is, since that prompt focuses Cancel. Then the
  // save-password prompt turned up, which focuses Save: escaping would have
  // saved a password the reader was walking away from.
  assert.deepEqual(result.results[0].value.pressed, []);
  assert.equal(result.results[0].value.pending, true);
  assert.equal(result.state.mode, 'browse');
  assert.match(result.state.statusMsg, /nothing was pressed/);
  // The key to come back with is read from the keymap rather than written out,
  // because the key is configurable.
  assert.match(result.state.statusMsg, /Alt\+Q/);
});

test('an option is ticked in place and the dialog stays up', { skip }, async () => {
  const result = await both('tick the option', state(), [
    {
      op: 'answerDialog',
      dialog: INSTALL,
      // Down to the option, Enter to tick it, Enter again to untick it, then
      // Escape without answering.
      keys: [DOWN, DOWN, DOWN, DOWN, '\r', '\r', ESCAPE],
    },
  ]);
  assert.deepEqual(result.results[0].value.pressed, [], 'an option was taken for an answer');
  assert.deepEqual(result.results[0].value.toggled, [
    'Allow it in private windows',
    'Allow it in private windows',
  ]);
  assert.match(result.state.statusMsg, /nothing was pressed/);
});

test('an option the browser will not change is reported, not pretended', { skip }, async () => {
  const result = await both('a refused option', state(), [
    {
      op: 'answerDialog',
      dialog: { ...INSTALL, toggleRefuses: ['Allow it in private windows'] },
      keys: [DOWN, DOWN, DOWN, DOWN, '\r', ESCAPE],
    },
  ]);
  assert.deepEqual(result.results[0].value.toggled, []);
  assert.match(result.state.statusMsg, /nothing was pressed/);
});

test('Enter on a line that is not an answer says which lines are', { skip }, async () => {
  const result = await both('enter on prose', state(), [
    { op: 'answerDialog', dialog: INSTALL, keys: ['\r', ESCAPE] },
  ]);
  assert.deepEqual(result.results[0].value.pressed, []);
  assert.equal(result.results[0].value.pending, true);
});

test('a press that leaves the dialog open keeps the reader in it', { skip }, async () => {
  const result = await both('a non-closing chooser control', state(), [
    {
      op: 'answerDialog',
      dialog: {
        role: 'file chooser', title: 'Choose Folder', lines: ['Places'],
        buttons: [{ name: 'Home' }, { name: 'Open' }], toggles: [], fields: [],
        staysOpenAfterPress: true,
      },
      // Home navigates and keeps the chooser open. Escape must still belong to
      // that chooser rather than becoming a key on the underlying web page.
      keys: [DOWN, DOWN, '\r', ESCAPE],
    },
  ]);
  assert.deepEqual(result.results[0].value.pressed, ['Home']);
  assert.equal(result.results[0].value.pending, true);
});

test('a press the browser did not act on leaves the question available', { skip }, async () => {
  const result = await both('a press the browser ignored', state(), [
    {
      op: 'answerDialog',
      dialog: { ...SAVE_PASSWORD, staysOpenAfterPress: true },
      keys: [DOWN, DOWN, DOWN, DOWN, '\r', ESCAPE],
    },
  ]);
  assert.deepEqual(result.results[0].value.pressed, ['Never']);
  assert.equal(result.results[0].value.pending, true);
});

test('a chooser offers its location field and its own directory action', { skip }, async () => {
  const result = await both('chooser blocks', state(), [
    { op: 'dialogBlocks', dialog: CHOOSER },
  ]);
  // The location field is a line a reader can stand on, and the chooser's own
  // show_location action is a line of its own rather than something a reader
  // has to discover by pressing the right button in the right order.
  assert.deepEqual(result.results[0].value.map((block) => block.text), [
    'Places',
    'Location: /home/reader',
    '',
    'Enter Location',
    '',
    'Cancel',
    'Open',
  ]);
});

test('a typed path goes into the chooser and keeps the reader there', { skip }, async () => {
  const result = await both('typing a path into a chooser', state(), [
    {
      op: 'answerDialog',
      dialog: { ...CHOOSER, staysOpenAfterField: true },
      // Down onto the location field, Enter to edit it, the path typed, Enter
      // to hand it to the chooser, then Escape without answering.
      keys: [
        DOWN, '\r', '\u000c',
        '/', 'h', 'o', 'm', 'e', '/', 'r', 'e', 'a', 'd', 'e', 'r', '/', 'D',
        'o', 'w', 'n', 'l', 'o', 'a', 'd', 's',
        '\r', ESCAPE,
      ],
    },
  ]);
  assert.deepEqual(result.results[0].value.entered, [
    { name: 'Location', text: '/home/reader/Downloads' },
  ]);
  // The chooser kept its claim: Escape was the chooser's Escape, not the
  // page's, so the question is still pending.
  assert.equal(result.results[0].value.pending, true);
  assert.equal(result.state.mode, 'browse');
});

test('a chooser directory action is activated without leaving the chooser', { skip }, async () => {
  const result = await both('activating a chooser action', state(), [
    {
      op: 'answerDialog',
      dialog: { ...CHOOSER, staysOpenAfterAction: true },
      // Down to the action, Enter to activate it, then Escape.
      keys: [DOWN, DOWN, DOWN, '\r', ESCAPE],
    },
  ]);
  assert.deepEqual(result.results[0].value.activated, ['Enter Location']);
  assert.equal(result.results[0].value.pending, true);
});

test('a press the browser refuses outright is not reported as answered', { skip }, async () => {
  const result = await both('a refused press', state(), [
    {
      op: 'answerDialog',
      dialog: { ...SAVE_PASSWORD, pressRefuses: ['Never'] },
      keys: [DOWN, DOWN, DOWN, DOWN, '\r', ESCAPE],
    },
  ]);
  assert.deepEqual(result.results[0].value.pressed, []);
  assert.equal(result.results[0].value.pending, true);
});

test('a keyboard that goes away leaves the browser holding its question', { skip }, async () => {
  const result = await both('the terminal went away', state(), [
    { op: 'answerDialog', dialog: INSTALL, keys: ['<eof>'] },
  ]);
  // The same thing that happens to a sighted user who walks away, and better
  // than answering on their behalf.
  assert.deepEqual(result.results[0].value.pressed, []);
  assert.equal(result.state.mode, 'browse');
});

test('every other key says what the two useful ones are', { skip }, async () => {
  const result = await both('an unhelpful key', state(), [
    { op: 'answerDialog', dialog: INSTALL, keys: ['q', ESCAPE] },
  ]);
  // A reader who presses `q` at a question the browser is holding open should
  // be told why nothing happened rather than left wondering whether the
  // terminal has stopped listening. And `q` must not quit.
  assert.deepEqual(result.results[0].value.pressed, []);
  assert.equal(result.results[0].value.pending, true);
});

test('the browser-question key goes back to a question that is still open', { skip }, async () => {
  const result = await both('reopen a pending question', state(), [
    {
      op: 'reopenDialog',
      dialog: {
        ...SAVE_PASSWORD,
        // The reader stepped away; meanwhile the browser changed what it says.
        reread: {
          ...SAVE_PASSWORD,
          fields: [
            { name: 'Username', value: 'someone else' },
            { name: 'Password', value: 'MASKED' },
          ],
        },
      },
      keys: [DOWN, DOWN, DOWN, DOWN, '\r'],
    },
  ]);
  assert.deepEqual(result.results[0].value.pressed, ['Never']);
  assert.match(result.state.statusMsg, /Pressed "Never"/);
});

test('a question that is no longer open is said to be gone, not reopened', { skip }, async () => {
  const result = await both('a question that went away', state(), [
    { op: 'reopenDialog', dialog: { ...INSTALL, stillOpen: false }, keys: [] },
  ]);
  assert.deepEqual(result.results[0].value.pressed, []);
  assert.equal(result.results[0].value.pending, false);
  assert.match(result.state.statusMsg, /no longer asking/);
  assert.equal(result.state.mode, 'browse');
});

test('the browser-question key with nothing pending says so', { skip }, async () => {
  const result = await both('nothing pending', state(), [
    { op: 'reopenDialog', dialog: INSTALL, pending: false, keys: [] },
  ]);
  assert.match(result.state.statusMsg, /not asking anything/);
  assert.equal(result.state.mode, 'browse');
});
