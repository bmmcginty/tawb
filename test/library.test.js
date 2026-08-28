'use strict';

// The browser's own lists, once a browser has answered for them.
//
// What each engine does to get an answer is browser work and is tested against
// a real browser in test/browser/library.test.js. Everything here is what
// happens to the answer afterwards: how many entries are kept and in what
// order, how one is written on a line, what filtering means, and what the list
// on screen does to the reader's place.

const test = require('node:test');
const assert = require('node:assert');

const {
  entryLine, matches, relativeAge, sizeText, shortAddress, orderEntries,
} = require('../src/library');
const {
  openLibrary, closeLibrary, handleLibraryKey,
} = require('../src/index');
const { Keymap } = require('../src/keys');

const NOW = Date.UTC(2026, 0, 20, 12, 0, 0);
const HOUR = 3600000;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// What both engines' answers pass through
// ---------------------------------------------------------------------------

test('history and downloads are newest first; bookmarks keep the order they are filed in', () => {
  const visits = [
    { url: 'https://old.test/', when: NOW - 3 * DAY },
    { url: 'https://new.test/', when: NOW - HOUR },
  ];
  assert.deepEqual(orderEntries('history', visits).map((e) => e.url),
    ['https://new.test/', 'https://old.test/']);
  assert.deepEqual(orderEntries('downloads', visits).map((e) => e.url),
    ['https://new.test/', 'https://old.test/']);
  // A bookmark's place in its folder is something the reader chose.
  assert.deepEqual(orderEntries('bookmarks', visits).map((e) => e.url),
    ['https://old.test/', 'https://new.test/']);
});

test('an entry with nothing to go to and no file is not an entry', () => {
  const kept = orderEntries('history', [
    { url: 'https://real.test/', when: NOW },
    { url: '', when: NOW },
    null,
  ]);
  assert.deepEqual(kept.map((e) => e.url), ['https://real.test/']);
});

// A year of browsing is six figures of rows, and a list nobody can reach the
// bottom of is not more useful for being longer.
test('a list is capped, keeping the newest', () => {
  const many = Array.from({ length: 40 }, (_, index) => ({
    url: `https://example.test/${index}`, when: NOW - index * HOUR,
  }));
  const kept = orderEntries('history', many, { max: 5 });
  assert.equal(kept.length, 5);
  assert.equal(kept[0].url, 'https://example.test/0');
});

// ---------------------------------------------------------------------------
// What a line says
// ---------------------------------------------------------------------------

test('a line leads with the title, and is the address alone when there is no title', () => {
  const entry = { title: 'Braille', url: 'https://example.test/braille', when: NOW - HOUR };
  assert.equal(entryLine('history', entry, NOW),
    'Braille — https://example.test/braille — 1 hour ago');
  assert.equal(entryLine('history', { ...entry, title: '' }, NOW),
    'https://example.test/braille — 1 hour ago');
});

// A page whose title is its own address would otherwise print it twice.
test('a title that is only the address is not said a second time', () => {
  const entry = { title: 'https://example.test/', url: 'https://example.test/', when: NOW };
  assert.equal(entryLine('history', entry, NOW), 'https://example.test/ — just now');
});

test('a bookmark says which folder it is filed in', () => {
  assert.equal(
    entryLine('bookmarks', {
      title: 'Paper', url: 'https://paper.test/', folder: 'Bookmarks toolbar/News',
    }, NOW),
    'Paper — https://paper.test/ — in Bookmarks toolbar/News');
});

test('a download says how it went, how big it was, and where it came from', () => {
  assert.equal(
    entryLine('downloads', {
      title: 'manual.pdf',
      file: '/home/reader/Downloads/manual.pdf',
      url: 'https://cdn.example.test/manual.pdf',
      state: 'complete',
      bytes: 2 * 1024 * 1024,
      totalBytes: 2 * 1024 * 1024,
      when: NOW - HOUR,
    }, NOW),
    'manual.pdf — complete — 2.0MB — 1 hour ago — from https://cdn.example.test/manual.pdf');
});

// One entry of a real history filled twelve of a screen's twenty-two rows with
// the base64 payload of a tracking link, and buried the list under it.
test('a long address is cut back to the host and path it identifies', () => {
  const long = `https://ads.test/click?i=${'x'.repeat(400)}`;
  assert.equal(shortAddress(long), 'https://ads.test/click…');
  assert.equal(shortAddress('https://short.test/page'), 'https://short.test/page');
  // Nothing to take apart, and no host and path to fall back to.
  assert.equal(shortAddress(`data:text/html,${'y'.repeat(300)}`).length, 100);
});

test('every word of the filter must appear, in any order, in any case', () => {
  const line = 'Braille — https://en.wikipedia.org/wiki/Braille — 2 days ago';
  assert.equal(matches(line, 'braille'), true);
  assert.equal(matches(line, 'wiki braille'), true);
  assert.equal(matches(line, 'braille wiki'), true);
  assert.equal(matches(line, 'braille dots'), false);
  assert.equal(matches(line, '   '), true);
});

test('an age is said the way a reader remembers it, and a date once it is old', () => {
  assert.equal(relativeAge(NOW - 30000, NOW), 'just now');
  assert.equal(relativeAge(NOW - 5 * 60000, NOW), '5 min ago');
  assert.equal(relativeAge(NOW - HOUR, NOW), '1 hour ago');
  assert.equal(relativeAge(NOW - 5 * HOUR, NOW), '5 hours ago');
  assert.equal(relativeAge(NOW - DAY, NOW), '1 day ago');
  assert.equal(relativeAge(NOW - 200 * DAY, NOW), '2025-07-04');
  assert.equal(relativeAge(null, NOW), '');
});

test('a size is said in the largest unit that leaves a number worth hearing', () => {
  assert.equal(sizeText(0, 900), '900B');
  assert.equal(sizeText(0, 3 * 1024), '3.0KB');
  assert.equal(sizeText(0, 40 * 1024 * 1024), '40MB');
  assert.equal(sizeText(0, 0), '');
});

// ---------------------------------------------------------------------------
// The list on screen
// ---------------------------------------------------------------------------

const HISTORY = [
  { title: 'Braille', url: 'https://en.wikipedia.org/wiki/Braille', when: NOW - HOUR },
  { title: 'Politics today', url: 'https://news.test/politics', when: NOW - 2 * HOUR },
  { title: 'Louis Braille', url: 'https://en.wikipedia.org/wiki/Louis_Braille', when: NOW - 3 * HOUR },
];

// The reader, mid-page, with a browser that answers for its own lists.
function readerAt(answer) {
  return {
    driver: {
      name: 'stub',
      readLibrary: typeof answer === 'function' ? answer : async () => answer,
    },
    keys: new Keymap({ terminfo: {}, load: false }),
    mode: 'browse',
    library: null,
    lines: [],
    cursor: 3,
    col: 2,
    scroll: 1,
    title: 'The page they were reading',
    statusMsg: '',
    drawn: { title: null, address: null, hint: null },
    credentials: null,
    keyReader: null,
    historyPlaces: new WeakMap(),
    core: {
      source: 'ax',
      at() {},
      markInput() {},
      async rescan() {},
      live: { refreshing: false },
      blocks: Array.from({ length: 60 }, (_, index) => ({ text: `page line ${index}`, item: null })),
    },
  };
}

const PAGE = { url: () => 'https://example.test/page' };

// Everything in the reader draws as it goes, and a test has no terminal. The
// terminal is put back only once whatever was asked for has finished — an
// await inside would otherwise carry on writing after it was restored, and the
// escape sequences land in the middle of the test report.
async function quietly(run) {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try { return await run(); } finally { process.stdout.write = write; }
}

function typeInto(state, text) {
  return quietly(async () => {
    for (const character of text) await handleLibraryKey(character, state, PAGE);
  });
}

test('opening a list replaces the buffer with what the browser answered', async () => {
  const asked = [];
  const state = readerAt(async (kind) => { asked.push(kind); return HISTORY; });
  await quietly(() => openLibrary(state, PAGE, 'history'));

  assert.deepEqual(asked, ['history']);
  assert.equal(state.mode, 'library');
  assert.equal(state.library.rows.length, 3);
  assert.equal(state.cursor, 0);
  assert.match(state.lines[0].text, /^Braille — https:\/\/en\.wikipedia\.org\/wiki\/Braille/);
});

// A browser that cannot answer — an older Firefox, or one this session only
// attached to — must say so on the status line and leave the reader where they
// were, not drop them into an empty list.
test('a browser that cannot answer says why and leaves the page alone', async () => {
  const state = readerAt(async () => { throw new Error('this Firefox was already running'); });
  await quietly(() => openLibrary(state, PAGE, 'bookmarks'));

  assert.equal(state.mode, 'browse');
  assert.equal(state.library, null);
  assert.match(state.statusMsg, /Could not read bookmarks: this Firefox was already running/);
});

// A rebuild would replace the block list with the page's, and the page is not
// what is on screen — the same reason the dropdown holds them.
test('live rebuilds are held while a list is open and resume when it closes', async () => {
  const state = readerAt(HISTORY);
  await quietly(() => openLibrary(state, PAGE, 'history'));
  assert.equal(state.core.live.refreshing, true);

  await quietly(() => closeLibrary(state, PAGE, null));
  assert.equal(state.core.live.refreshing, false);
});

test('typing filters the list, and backspace puts back what it removed', async () => {
  const state = readerAt(HISTORY);
  await quietly(() => openLibrary(state, PAGE, 'history'));

  await typeInto(state, 'louis');
  assert.deepEqual(state.lines.map((line) => line.text.split(' — ')[0]), ['Louis Braille']);

  await quietly(() => handleLibraryKey('\x7f', state, PAGE));
  assert.equal(state.library.filter, 'loui');
  assert.equal(state.lines.length, 1);
});

test('a filter that matches nothing says so instead of showing an empty screen', async () => {
  const state = readerAt(HISTORY);
  await quietly(() => openLibrary(state, PAGE, 'history'));
  await typeInto(state, 'zzz');

  assert.equal(state.lines.length, 1);
  assert.match(state.lines[0].text, /Nothing matching "zzz"/);
});

// Closing is not a navigation, so it must not read as one: the reader is put
// back on the line, column and screen they left.
test('closing a list puts the reader back exactly where they were reading', async () => {
  const state = readerAt(HISTORY);
  await quietly(() => openLibrary(state, PAGE, 'history'));
  await typeInto(state, 'braille');
  await quietly(() => handleLibraryKey('\x1b', state, PAGE));

  assert.equal(state.mode, 'browse');
  assert.equal(state.library, null);
  assert.equal(state.title, 'The page they were reading');
  assert.deepEqual(
    { cursor: state.cursor, col: state.col, scroll: state.scroll },
    { cursor: 3, col: 2, scroll: 1 },
  );
  assert.equal(state.lines[0].text, 'page line 0');
});

test('Enter closes the list and goes to the entry the reader is standing on', async () => {
  const state = readerAt(HISTORY);
  await quietly(() => openLibrary(state, PAGE, 'history'));
  await typeInto(state, 'politics');

  const went = [];
  const page = {
    url: () => 'https://example.test/page',
    evaluate: async () => 'entry:page',
    title: async () => 'Politics today',
    goto: async (url) => { went.push(url); },
  };
  await quietly(() => handleLibraryKey('\r', state, page));

  assert.equal(state.mode, 'browse');
  assert.equal(state.library, null);
  assert.deepEqual(went, ['https://news.test/politics']);
});

test('the address Enter goes to is the one the browser gave, not the short one', async () => {
  const long = `https://ads.test/click?i=${'x'.repeat(400)}`;
  const state = readerAt([{ title: 'An advert', url: long, when: NOW }]);
  await quietly(() => openLibrary(state, PAGE, 'history'));
  assert.match(state.lines[0].text, /An advert — https:\/\/ads\.test\/click…/);

  const went = [];
  const page = {
    url: () => 'https://example.test/page',
    evaluate: async () => 'entry:page',
    title: async () => 'An advert',
    goto: async (url) => { went.push(url); },
  };
  await quietly(() => handleLibraryKey('\r', state, page));
  assert.deepEqual(went, [long]);
});

// A download the browser no longer has a source for: the file is on the line,
// there is simply nowhere to go.
test('an entry with no address says so rather than going nowhere quietly', async () => {
  const state = readerAt([{ title: 'gone.bin', file: '/tmp/gone.bin', url: '', state: 'complete' }]);
  await quietly(() => openLibrary(state, PAGE, 'downloads'));
  await quietly(() => handleLibraryKey('\r', state, PAGE));

  assert.equal(state.mode, 'library');
  assert.match(state.statusMsg, /"gone\.bin" has no address recorded/);
});
