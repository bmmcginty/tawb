'use strict';

// Where a link goes, said while the reader is standing on it.
//
// A sighted person gets this for free: arrow onto a link in a graphical
// browser and its target appears in the corner of the window, unasked for and
// without moving off the link to go and look. It appears in the *status bar*,
// not the address bar — the address bar goes on saying where you are — and
// the reader here gets the same two answers in the same two places.

const test = require('node:test');
const assert = require('node:assert');

const {
  linkTarget, drawStatus, drawAddress, moveSelection, handleBrowseKey,
} = require('../src/index');

const PAGE = { url: () => 'https://example.test/index.html' };
const LINK = { role: 'link', name: 'About', href: 'https://example.test/about' };

function pageOf(...items) {
  return {
    mode: 'browse',
    lines: items.map((_, i) => ({ text: `line ${i}`, blockIndex: i })),
    cursor: 0,
    scroll: 0,
    col: 0,
    statusMsg: '',
    drawn: {},
    linkAddress: true,
    core: { at() {}, source: 'ax', blocks: items.map((item) => ({ item })) },
  };
}

function capturingTerminal(fn) {
  const write = process.stdout.write;
  const chunks = [];
  process.stdout.write = (text) => { chunks.push(String(text)); return true; };
  try { fn(); } finally { process.stdout.write = write; }
  return chunks.join('');
}

async function capturingTerminalAsync(fn) {
  const write = process.stdout.write;
  const chunks = [];
  process.stdout.write = (text) => { chunks.push(String(text)); return true; };
  try { await fn(() => chunks.join('')); } finally { process.stdout.write = write; }
}

test('standing on a link is standing somewhere that goes somewhere', () => {
  assert.equal(linkTarget(pageOf(LINK)), 'https://example.test/about');
});

test('anything else goes nowhere', () => {
  // Prose, a heading and a button are not somewhere to go, so the status row
  // goes on saying whatever it was saying.
  for (const item of [{ role: 'text', name: 'some prose' },
    { role: 'heading', name: 'Contents', level: '2' },
    { role: 'button', name: 'Play' }]) {
    assert.equal(linkTarget(pageOf(item)), null);
  }
  // role="link" on a div is a link to the reader and has no target at all.
  assert.equal(linkTarget(pageOf({ role: 'link', name: 'Menu' })), null);
});

test('one of the browser\'s own lists is not the page talking', () => {
  // The lines on screen are bookmarks, not links on the page.
  const state = pageOf({ role: 'text', name: 'unused' });
  state.library = { blocks: [{ item: { role: 'link', name: 'A bookmark', href: 'https://saved.test/' } }] };
  assert.equal(linkTarget(state), null);
});

test('arrowing onto a link says where it goes, and off it gives the message back', () => {
  const state = pageOf({ role: 'text', name: 'some prose' }, LINK);
  state.statusMsg = 'Loaded https://example.test/index.html';
  state.drawn.status = state.statusMsg;

  const onto = capturingTerminal(() => moveSelection(state, 1, PAGE));
  assert.ok(onto.includes('https://example.test/about'), onto);
  // The cursor does not stay on the status row: the reader is still reading
  // their own line, and a screen reader follows the terminal cursor there.
  assert.ok(onto.endsWith('\x1b[6;1H'), JSON.stringify(onto.slice(-12)));

  const off = capturingTerminal(() => moveSelection(state, 0, PAGE));
  assert.ok(off.includes('Loaded https://example.test/index.html'), off);
});

test('a row that already says it is not written again', () => {
  // A repainted row is re-read by a screen reader and re-flashed by a braille
  // display whether or not it now says anything different, so moving within
  // the same answer must cost nothing at all.
  const state = pageOf(LINK, { ...LINK, name: 'About again' });
  state.drawn.status = 'https://example.test/about';
  assert.equal(capturingTerminal(() => drawStatus(state)), '');

  state.cursor = 1;
  assert.equal(capturingTerminal(() => drawStatus(state)), '');
});

test('a prompt owns the status row while it is up', () => {
  // The find prompt, the sign-in prompt and the path prompt are all drawn
  // here; a link target must not be painted over one of them.
  const state = pageOf(LINK);
  state.mode = 'find';
  assert.equal(capturingTerminal(() => drawStatus(state)), '');
});

test('the address row goes on saying where the reader is', () => {
  const state = pageOf(LINK);
  const drawn = capturingTerminal(() => drawAddress(state, PAGE));
  assert.ok(drawn.includes('[AX] https://example.test/index.html'), drawn);
  assert.ok(!drawn.includes('/about'), drawn);
});

test('a reader who does not want the row to speak can switch it off', () => {
  // Most of the lines on some pages are links, and a sentence spoken on every
  // one of them is a great deal of speech to sit through.
  const state = pageOf(LINK);
  state.linkAddress = false;
  assert.equal(linkTarget(state), null);

  state.statusMsg = 'Loaded https://example.test/index.html';
  state.drawn.status = state.statusMsg;
  assert.equal(capturingTerminal(() => drawStatus(state)), '');
});

test('the switch says which way it went, and takes effect at once', async () => {
  const state = pageOf(LINK);
  state.linkAddress = true;
  state.keys = { actionFor: () => 'toggle-link-address' };
  state.core.markInput = () => {};

  let off = '';
  await capturingTerminalAsync(async (seen) => {
    await handleBrowseKey('u', state, PAGE);
    off = seen();
  });
  assert.equal(state.linkAddress, false);
  assert.ok(off.includes('Link addresses off.'), off);
  assert.equal(linkTarget(state), null);

  let on = '';
  await capturingTerminalAsync(async (seen) => {
    await handleBrowseKey('u', state, PAGE);
    on = seen();
  });
  assert.equal(state.linkAddress, true);
  assert.ok(on.includes('Link addresses on.'), on);
  assert.equal(linkTarget(state), 'https://example.test/about');
});
