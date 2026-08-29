'use strict';

// Filing the page the reader is on.
//
// What each engine does to get a bookmark into the browser's own tree is
// browser work and is tested against a real browser in
// test/browser/library.test.js. Everything here is what happens either side of
// it: the name the reader is offered, what Escape means, what a page that was
// already filed says, and the one key that had to be shared with the editing
// keyboard to have Ctrl+D at all.

const test = require('node:test');
const assert = require('node:assert');

const { askForLine, bookmarkPage } = require('../src/index');
const { Keymap } = require('../src/keys');
const { editAction } = require('../src/edit');

// Keys arrive from the terminal; here they arrive from an array. The reader
// takes the keyboard for itself while a prompt is up, so claim and release
// have to exist even though nothing else is competing for it.
function keyboard(keys) {
  const queue = [...keys];
  return {
    claimed: 0,
    claim() { this.claimed += 1; return 'token'; },
    release() { this.claimed -= 1; },
    async next() {
      if (!queue.length) throw new Error('the prompt asked for a key nobody pressed');
      return queue.shift();
    },
  };
}

function readerAt({ keys, saveBookmark, title = 'Braille — Wikipedia' } = {}) {
  return {
    driver: { name: 'stub', saveBookmark },
    keys: new Keymap({ terminfo: {}, load: false }),
    keyReader: keyboard(keys || []),
    mode: 'browse',
    title,
    statusMsg: '',
    lines: [],
    cursor: 0,
    col: 0,
    scroll: 0,
    line: null,
    drawn: { title: null, address: null, hint: null },
    statusHeldUntil: 0,
    core: { markInput() {}, live: { refreshing: false } },
  };
}

const PAGE = { url: () => 'https://en.wikipedia.org/wiki/Braille' };

// Everything in the reader draws as it goes, and a test has no terminal.
async function quietly(run) {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try { return await run(); } finally { process.stdout.write = write; }
}

// ---------------------------------------------------------------------------
// Asking for one line
// ---------------------------------------------------------------------------

test('a prompt starts with what was suggested, and Enter accepts it', async () => {
  const state = readerAt({ keys: ['\r'] });
  const answer = await quietly(() => askForLine(state, { label: 'Bookmark', initial: 'Braille' }));
  assert.equal(answer, 'Braille');
  // The keyboard is given back, and the mode is what it was.
  assert.equal(state.keyReader.claimed, 0);
  assert.equal(state.mode, 'browse');
  assert.equal(state.line, null);
});

test('the suggestion can be edited before it is accepted', async () => {
  // Ctrl+U clears the line, the way it does in every other field here.
  const state = readerAt({ keys: ['\x15', 'D', 'o', 't', 's', '\r'] });
  assert.equal(await quietly(() => askForLine(state, { label: 'Bookmark', initial: 'Braille' })),
    'Dots');
});

test('Escape answers with nothing rather than with an empty line', async () => {
  const state = readerAt({ keys: ['\x1b'] });
  assert.equal(await quietly(() => askForLine(state, { label: 'Bookmark', initial: 'x' })), null);
});

// ---------------------------------------------------------------------------
// Filing it
// ---------------------------------------------------------------------------

test('the page\'s own title is what the reader is offered, and what gets filed', async () => {
  const filed = [];
  const state = readerAt({
    keys: ['\r'],
    saveBookmark: async (entry) => {
      filed.push(entry);
      return { existed: false, title: entry.title, folder: 'Other bookmarks' };
    },
  });
  await quietly(() => bookmarkPage(state, PAGE));
  assert.deepEqual(filed, [{
    url: 'https://en.wikipedia.org/wiki/Braille', title: 'Braille — Wikipedia',
  }]);
  assert.match(state.statusMsg, /Bookmarked "Braille — Wikipedia" in Other bookmarks\./);
});

// A page that never titled itself would otherwise be filed under nothing, and
// a bookmark with no name is one nobody finds again.
test('a page with no title is offered its address', async () => {
  const filed = [];
  const state = readerAt({
    keys: ['\r'],
    title: '',
    saveBookmark: async (entry) => {
      filed.push(entry);
      return { existed: false, title: entry.title, folder: 'Other bookmarks' };
    },
  });
  await quietly(() => bookmarkPage(state, PAGE));
  assert.equal(filed[0].title, 'https://en.wikipedia.org/wiki/Braille');
});

// Escape here means what it means on the browser's own dialogs: leave it
// alone. A graphical browser keeps the bookmark it already saved, but a reader
// who cannot reopen the bubble to undo it needs the key that backs out to
// actually back out.
test('Escape files nothing at all', async () => {
  let asked = false;
  const state = readerAt({ keys: ['\x1b'], saveBookmark: async () => { asked = true; } });
  await quietly(() => bookmarkPage(state, PAGE));
  assert.equal(asked, false);
  assert.equal(state.statusMsg, 'Not bookmarked.');
});

test('a page already filed is reported under the name it is filed as, not filed twice', async () => {
  const state = readerAt({
    keys: ['\r'],
    saveBookmark: async () => ({
      existed: true, title: 'Braille, read up on', folder: 'Bookmarks toolbar/Reading',
    }),
  });
  await quietly(() => bookmarkPage(state, PAGE));
  assert.match(state.statusMsg,
    /Already bookmarked as "Braille, read up on" in Bookmarks toolbar\/Reading — not filed again\./);
});

test('an engine that will not answer says why, and the reader keeps their page', async () => {
  const state = readerAt({
    keys: ['\r'],
    saveBookmark: async () => {
      throw new Error('this Firefox was already running when tawb attached to it');
    },
  });
  await quietly(() => bookmarkPage(state, PAGE));
  assert.match(state.statusMsg, /Could not bookmark it: this Firefox was already running/);
  assert.equal(state.mode, 'browse');
});

test('a blank tab is not a page to file', async () => {
  let asked = false;
  const state = readerAt({ keys: [], saveBookmark: async () => { asked = true; } });
  await quietly(() => bookmarkPage(state, { url: () => 'about:blank' }));
  assert.equal(asked, false);
  assert.match(state.statusMsg, /no page here to bookmark/);
});

// ---------------------------------------------------------------------------
// The key it had to share
// ---------------------------------------------------------------------------

// Ctrl+D files a bookmark in every browser and deletes forward in every
// readline, and both are right. One flat map of sequences to actions cannot
// hold both — whichever action was listed last would silently take the key —
// so the editing keyboard is asked separately from the browsing one.
test('Ctrl+D files a bookmark while browsing and deletes a character while typing', () => {
  const keys = new Keymap({ terminfo: {}, load: false });
  assert.equal(keys.actionFor('\x04'), 'add-bookmark');
  assert.equal(keys.editingActionFor('\x04'), 'edit-delete');
  assert.equal(editAction('\x04', keys), 'delete-forward');
  // Nothing else moved: the browse keys are still only browse keys.
  assert.equal(keys.editingActionFor('q'), null);
  assert.equal(keys.editingActionFor('\x0f'), null);
});
