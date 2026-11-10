'use strict';

// The Printing Options screen and its one save option, differenced between the
// JavaScript original and the Crystal port. The model and the fixed screen are
// compared directly; the key stream is compared through the same small host
// event vocabulary on both sides.

const test = require('node:test');
const assert = require('node:assert');

const { call } = require('./crystal_impl');
const { Keymap } = require('../src/keys');
const { ScreenStack } = require('../src/screen_stack');
const printScreen = require('../src/lynx_print_screen');

const PAGE = { url: () => 'https://example.test/articles/one.html' };

function jsHost() {
  const events = [];
  const host = {
    events,
    status: '',
    writeLine(row, text) { events.push(`row ${row}:${text}`); },
    moveCursor(row, col) { events.push(`cursor ${row}:${col}`); },
    clearScreen() { events.push('clear'); },
    resetScrollRegion() { events.push('reset'); },
    relayout() {},
    render() {},
    clampCol() {},
    clampScroll() {},
    setStatus(state, message) { host.status = message; },
    keyIs(chunk, name) {
      return new Keymap({ terminfo: {}, profile: 'lynx', load: false }).isKey(chunk, name);
    },
    rows() { return 24; },
  };
  return host;
}

function jsKeys(keys) {
  const state = {
    mode: 'browse', title: 'The article', rows: 24,
    lines: [{ blockIndex: 0, text: 'First line' }],
    cursor: 0, col: 0, scroll: 0, printMenu: null,
    screens: new ScreenStack(), core: { live: { refreshing: false } },
    keys: new Keymap({ terminfo: {}, profile: 'lynx', load: false }),
  };
  const host = jsHost();
  printScreen.openPrint(host, state, PAGE);
  const results = [];
  for (const key of keys) {
    host.events.length = 0;
    const verdict = printScreen.handlePrintKey(host, key, state, PAGE);
    results.push({
      key,
      verdict,
      mode: state.mode,
      status: host.status,
      events: [...host.events],
    });
  }
  return { mode: state.mode, results };
}

test('the screen model agrees on every row and the option position', () => {
  const payload = {
    method: 'screen',
    url: PAGE.url(),
    lineCount: 132,
    rows: 24,
  };
  const crystal = call('lynx_print.scenario', payload);
  const lines = printScreen.screenLines({ url: payload.url, lineCount: payload.lineCount });
  assert.deepEqual(crystal.lines, lines.map((line) => line.text));
  assert.equal(crystal.optionRow, printScreen.optionRow(lines));
  assert.equal(crystal.pageLabel, printScreen.pageLabel(payload.lineCount));
});

test('the default filename agrees', () => {
  for (const [title, url] of [
    ['The article', PAGE.url()],
    ['A title', 'https://example.test/'],
    ['', 'https://example.test/'],
    ['Firefox - Wikipedia', 'https://en.wikipedia.org/wiki/Firefox'],
  ]) {
    const crystal = call('lynx_print.scenario', { method: 'filename', title, url });
    assert.equal(crystal, printScreen.saveFilename(title, url), `${title} ${url}`);
  }
});

test('the saved text agrees, markers and all', () => {
  const lines = [
    { text: 'First line', displayIndent: 2, displayPrefix: '[', displaySuffix: ']' },
    { text: 'Second line', displayIndent: 0, displayPrefix: '', displaySuffix: '' },
  ];
  const crystal = call('lynx_print.scenario', { method: 'text', lines });
  const expected = lines.map((line) => ' '.repeat(line.displayIndent)
    + line.displayPrefix + line.text + line.displaySuffix).join('\n') + '\n';
  assert.equal(crystal, expected);
});

test('the one-option keyboard agrees, including leaving the screen', () => {
  const keys = ['?', '\r', 'q'];
  const crystal = call('lynx_print.scenario', {
    method: 'keys', url: PAGE.url(), lineCount: 1, rows: 24, keys,
  });
  assert.deepEqual(crystal, jsKeys(keys));
});
