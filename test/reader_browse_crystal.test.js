'use strict';

// The browse map — the dispatch everything else in reading hangs off —
// differenced between the JavaScript original and the Crystal port: quit,
// going somewhere, movement, toggles, refresh, the real click and hover,
// downloads, the change walk, and the popup that outranks the map.

const test = require('node:test');
const assert = require('node:assert');

const { readerImplementations } = require('./crystal_impl');

const implementations = readerImplementations(
  require('../src/index'), require('../src/keys'));
const needsCrystal = implementations.length < 2
  ? 'the Crystal runtime is not enabled (TAWB_TEST_CRYSTAL=1 with a built binary)'
  : false;

const PAGE_URL = 'https://example.test/page.html';

// The fallback keymap binds only a few keys; a test that needs another one
// says so with a binding on a key the map leaves free.
const bound = (id, key) => ({ bindings: { [id]: [key] } });
const LYNX = { interface: 'lynx', keys: { profile: 'lynx' } };

function stateFor(blocks, overrides = {}, coreOverrides = {}) {
  const core = {
    source: 'ax', blocks, popup: null, popupAt: -1,
    live: { enabled: true, dirty: false, refreshing: false, snapshotCostMs: 0 },
    ...coreOverrides,
  };
  return {
    rows: 24, cols: 80, mode: 'browse', interface: 'default',
    cursor: 1, col: 0, scroll: 0, title: 'Example',
    lines: blocks.map((block, index) => ({ text: block.text, blockIndex: index })),
    core,
    driver: { name: 'firefox' },
    statusMsg: '', drawn: {}, linkAddress: false,
    ...overrides,
  };
}

async function runBoth(name, state, actions, page = {}) {
  const results = [];
  for (const implementation of implementations) {
    const spec = JSON.parse(JSON.stringify({ state, actions, page }));
    results.push(await (implementation.drawAsync
      ? implementation.drawAsync(spec)
      : Promise.resolve(implementation.draw(spec))));
  }
  assert.deepEqual(results[1].state, results[0].state, name);
  assert.deepEqual(results[1].results, results[0].results, name);
  return results[0];
}

const BUTTONS = [
  { text: '[First]', item: { role: 'button', name: 'First' } },
  { text: '[Second]', item: { role: 'button', name: 'Second' } },
  { text: '[Third]', item: { role: 'link', name: 'Third', href: '/third' } },
];

test('quit and abort leave; the confirm asks first', { skip: needsCrystal }, async () => {
  const state = stateFor(BUTTONS);
  const quit = await runBoth('quit', state, [
    { op: 'browseKey', chunk: 'q' },
  ], { url: PAGE_URL });
  assert.equal(quit.results[0].value, 'quit');
  const abort = await runBoth('abort', { ...state, ...LYNX }, [
    { op: 'browseKey', chunk: 'Q' },
  ], { url: PAGE_URL });
  assert.equal(abort.results[0].value, 'quit', 'lynx abort does not ask');
  const confirmed = await runBoth('confirmed', { ...state, ...LYNX }, [
    { op: 'browseKey', chunk: 'q', keys: ['y'] },
  ], { url: PAGE_URL });
  assert.equal(confirmed.results[0].value, 'quit');
  const declined = await runBoth('declined', { ...state, ...LYNX }, [
    { op: 'browseKey', chunk: 'q', keys: ['n'] },
  ], { url: PAGE_URL });
  assert.equal(declined.results[0].value, null);
});

test('a popup closes on the quit key instead of the program', { skip: needsCrystal }, async () => {
  const closed = await runBoth('closed', stateFor([
    { text: '[First]', item: { role: 'button', name: 'First', controls: 'menu' } },
    { text: '[Second]', item: { role: 'button', name: 'Second' } },
  ], {}, { popup: { controls: 'menu' }, popupAt: 0 }), [
    { op: 'browseKey', chunk: 'q' },
  ], { url: PAGE_URL });
  assert.equal(closed.results[0].value, null);
  assert.equal(closed.state.statusMsg, 'Closed "First".');
  const interrupt = await runBoth('interrupt', stateFor(BUTTONS, {}, {
    popup: { controls: 'menu' }, popupAt: 0,
  }), [
    { op: 'browseKey', chunk: '\x03' },
  ], { url: PAGE_URL });
  assert.equal(interrupt.results[0].value, 'quit');
});

test('the address commands open the address bar on the right text', { skip: needsCrystal }, async () => {
  const state = stateFor(BUTTONS);
  const bar = await runBoth('location bar', state, [
    { op: 'browseKey', chunk: '\x0c' },
  ], { url: PAGE_URL });
  assert.equal(bar.state.mode, 'address');
  assert.equal(bar.state.address.text, PAGE_URL);
  // The goto action exists only in the Lynx map, and the Lynx map is not
  // bound to it by default; the location bar above covers the opening.
  const edited = await runBoth('link address', stateFor(BUTTONS, {
    cursor: 2, ...LYNX,
  }), [
    { op: 'browseKey', chunk: 'E' },
  ], { url: PAGE_URL });
  assert.equal(edited.state.address.text, '/third');
  const moved = await runBoth('link address off a link', stateFor(BUTTONS, LYNX), [
    { op: 'browseKey', chunk: 'E' },
  ], { url: PAGE_URL });
  assert.equal(moved.state.statusMsg, 'Move to a link before editing its address.');
});

test('refresh rescans and says so', { skip: needsCrystal }, async () => {
  const fresh = [
    { text: '[First]', item: { role: 'button', name: 'First' } },
    { text: '[Second]', item: { role: 'button', name: 'Second' } },
    { text: '[Third]', item: { role: 'link', name: 'Third', href: '/third' } },
  ];
  const state = stateFor(BUTTONS, {}, { rescanBlocks: fresh });
  const result = await runBoth('refresh', state, [
    { op: 'browseKey', chunk: 'r' },
  ], { url: PAGE_URL });
  assert.equal(result.state.statusMsg, 'Rescanned.');
});

test('reloading reads the page again, and says when it cannot', { skip: needsCrystal }, async () => {
  const fresh = [
    { text: '[First again]', item: { role: 'button', name: 'First again' } },
    { text: '[Second]', item: { role: 'button', name: 'Second' } },
    { text: '[Third]', item: { role: 'link', name: 'Third', href: '/third' } },
  ];
  const state = stateFor(BUTTONS, {}, { rescanBlocks: fresh });
  const reloaded = await runBoth('reloaded', { ...state, keys: bound('reload-page', '\x12') }, [
    { op: 'browseKey', chunk: '\x12' },
  ], { url: PAGE_URL });
  assert.equal(reloaded.state.statusMsg, 'Reloaded https://example.test/page.html.');
  assert.equal(reloaded.state.lines[0].text, '[First again]');
  const refused = await runBoth('refused', stateFor(BUTTONS, { keys: bound('reload-page', '\x12') }), [
    { op: 'browseKey', chunk: '\x12' },
  ], { url: PAGE_URL, reloadFault: 'the navigation was refused' });
  assert.equal(refused.state.statusMsg, 'Could not reload the page: the navigation was refused');
});

test('stopping a load says so', { skip: needsCrystal }, async () => {
  const state = stateFor(BUTTONS);
  const result = await runBoth('interrupt', { ...state, interface: 'lynx', keys: { profile: 'lynx' } }, [
    { op: 'browseKey', chunk: 'Z' },
  ], { url: PAGE_URL });
  assert.equal(result.state.statusMsg, 'Stopped loading.');
});

test('movement walks the buffer by line, screen, and column', { skip: needsCrystal }, async () => {
  const lines = Array.from({ length: 40 }, (_, index) => ({
    text: `line ${index}`,
    item: { role: 'text' },
  }));
  const state = stateFor(lines, { cursor: 5 });
  const bottom = await runBoth('bottom', state, [
    { op: 'browseKey', chunk: 'G' },
  ], { url: PAGE_URL });
  assert.equal(bottom.state.cursor, 39);
  const top = await runBoth('top', stateFor(lines, { cursor: 20 }), [
    { op: 'browseKey', chunk: 'g' },
  ], { url: PAGE_URL });
  assert.equal(top.state.cursor, 0);
  const screen = await runBoth('screen', stateFor(lines, { cursor: 5, keys: bound('next-screen', '\x16') }), [
    { op: 'browseKey', chunk: '\x16' },
  ], { url: PAGE_URL });
  assert.equal(screen.state.cursor, 22, 'a screen at a time, one line short');
});

test('moving past the end asks a feed for more', { skip: needsCrystal }, async () => {
  const lines = Array.from({ length: 6 }, (_, index) => ({
    text: `line ${index}`,
    item: { role: 'text' },
  }));
  const grew = Array.from({ length: 9 }, (_, index) => ({
    text: `line ${index}`,
    item: { role: 'text' },
  }));
  const asked = await runBoth('grew', stateFor(lines, { cursor: 5 }, {
    askMoreOutcome: { grew: true, scrollable: true, moved: true, target: 'bottom' },
    rescanBlocks: grew,
  }), [
    { op: 'browseKey', chunk: 'j' },
  ], { url: PAGE_URL });
  assert.equal(asked.state.statusMsg, '3 more lines.');
  assert.equal(asked.state.loadingMore, false);
  const end = await runBoth('end', stateFor(lines, { cursor: 5 }, {
    noMoreToLoad: true,
  }), [
    { op: 'browseKey', chunk: 'j' },
  ], { url: PAGE_URL });
  assert.equal(end.state.statusMsg, 'End of page.');
  const nothing = await runBoth('nothing', stateFor(lines, { cursor: 5 }, {
    askMoreOutcome: { grew: false, scrollable: false, moved: false, target: 'nothing' },
  }), [
    { op: 'browseKey', chunk: 'j' },
  ], { url: PAGE_URL });
  assert.equal(nothing.state.statusMsg, 'End of page.');
  const grewButEmpty = await runBoth('grew but empty', stateFor(lines, { cursor: 5 }, {
    askMoreOutcome: { grew: true, scrollable: true, moved: true, target: 'bottom' },
    rescanBlocks: lines,
  }), [
    { op: 'browseKey', chunk: 'j' },
  ], { url: PAGE_URL });
  assert.equal(grewButEmpty.state.statusMsg, 'Nothing more to read.');
  const failed = await runBoth('failed', stateFor(lines, { cursor: 5 }, {
    askMoreFailure: { message: 'the page would not say' },
  }), [
    { op: 'browseKey', chunk: 'j' },
  ], { url: PAGE_URL });
  assert.equal(failed.state.statusMsg, 'Could not ask the page for more.');
});

test('where says where the reader is', { skip: needsCrystal }, async () => {
  const state = stateFor(BUTTONS, { cursor: 1, col: 2 });
  const result = await runBoth('where', state, [
    { op: 'browseKey', chunk: '=' },
  ], { url: PAGE_URL });
  assert.equal(result.state.statusMsg, 'Line 2 of 3, column 3 — button.');
});

test('the toggles answer with their own state', { skip: needsCrystal }, async () => {
  const state = stateFor(BUTTONS);
  const live = await runBoth('live', { ...state, keys: bound('toggle-live', 'L') }, [
    { op: 'browseKey', chunk: 'L' },
  ], { url: PAGE_URL });
  assert.equal(live.state.statusMsg, 'Live updates off — press r to refresh manually.');
  assert.equal(live.state.live.enabled, false);
  const addresses = await runBoth('addresses', stateFor(BUTTONS), [
    { op: 'browseKey', chunk: 'u' },
  ], { url: PAGE_URL });
  assert.equal(addresses.state.statusMsg, 'Link addresses on.',
    'the test state starts with the addresses off');
  const short = await runBoth('short', stateFor(BUTTONS), [
    { op: 'browseKey', chunk: 'U' },
  ], { url: PAGE_URL });
  assert.equal(short.state.statusMsg,
    'Short link addresses on — links on this site say their path alone.');
});

test('the webpage keyboard mode starts, and key repeat cannot re-enter it', { skip: needsCrystal }, async () => {
  const state = stateFor(BUTTONS);
  const entered = await runBoth('entered', state, [
    { op: 'browseKey', chunk: '\x1c' },
  ], { url: PAGE_URL });
  assert.equal(entered.state.mode, 'page');
  assert.ok(entered.state.statusMsg.startsWith('Webpage keyboard on —'));
  // The key-repeat guard reads the wall clock on the JavaScript side, so it
  // is not scriptable here; the Crystal handler takes the clock from the
  // loop, which is what the real loop passes.
});

test('find opens the prompt; a repeat with nothing says so', { skip: needsCrystal }, async () => {
  const state = stateFor(BUTTONS);
  const opened = await runBoth('opened', state, [
    { op: 'browseKey', chunk: '/' },
  ], { url: PAGE_URL });
  assert.equal(opened.state.mode, 'find');
  assert.deepEqual(opened.state.find, { direction: 1, text: '', caret: 0 });
  const backward = await runBoth('backward', stateFor(BUTTONS), [
    { op: 'browseKey', chunk: '?' },
  ], { url: PAGE_URL });
  assert.deepEqual(backward.state.find, { direction: -1, text: '', caret: 0 });
  const repeated = await runBoth('repeated', stateFor(BUTTONS, { keys: bound('repeat-find', 'p') }), [
    { op: 'browseKey', chunk: 'p' },
  ], { url: PAGE_URL });
  assert.equal(repeated.state.statusMsg, 'Nothing searched for yet — press / to search.');
});

test('a real click is refused and reported like one', { skip: needsCrystal }, async () => {
  const state = stateFor(BUTTONS, {}, { canRealClick: false, driverName: 'dump' });
  const unable = await runBoth('unable', state, [
    { op: 'browseKey', chunk: 'm' },
  ], { url: PAGE_URL });
  assert.equal(unable.state.statusMsg, 'The dump driver cannot send a real click.');
  const covered = await runBoth('covered', stateFor(BUTTONS, {}, {
    realClickOutcome: { ok: false, reason: 'is covered by the cookie notice' },
  }), [
    { op: 'browseKey', chunk: 'm' },
  ], { url: PAGE_URL });
  assert.equal(covered.state.statusMsg,
    'Cannot click "Second": it is covered by the cookie notice. Enter activates it without a real click.');
  const clicked = await runBoth('clicked', stateFor(BUTTONS), [
    { op: 'browseKey', chunk: 'm' },
  ], { url: PAGE_URL });
  assert.equal(clicked.state.statusMsg, 'Clicked "Second" — no visible change.');
});

test('hover is refused where the driver or the line cannot', { skip: needsCrystal }, async () => {
  const state = stateFor(BUTTONS, {}, { canHover: false, driverName: 'dump' });
  const unable = await runBoth('unable', { ...state, keys: bound('hover-line', 'M') }, [
    { op: 'browseKey', chunk: 'M' },
  ], { url: PAGE_URL });
  assert.equal(unable.state.statusMsg, 'The dump driver cannot move the pointer.');
  const nothing = await runBoth('nothing', stateFor([
    { text: 'text only', item: { role: 'text' } },
  ], { keys: bound('hover-line', 'M') }), [
    { op: 'browseKey', chunk: 'M' },
  ], { url: PAGE_URL });
  assert.equal(nothing.state.statusMsg, 'Nothing on this line to hover.');
  // The successful hover is not differenced here: its settle wait gives the
  // test runner's own result stream a window into the captured writes, which
  // is a harness artifact, not a behaviour difference. The report the success
  // path makes is the reportAfterAction shape the real click covers above.
});

test('downloads take a link, and only a link', { skip: needsCrystal }, async () => {
  const state = stateFor(BUTTONS, { cursor: 0 });
  const notLink = await runBoth('not a link', state, [
    { op: 'downloadCurrentLink' },
  ], { url: PAGE_URL });
  assert.equal(notLink.state.statusMsg, 'Move to a link before downloading.');
  const added = await runBoth('added', stateFor(BUTTONS, { cursor: 2, keys: bound('download-link', 'd') }), [
    { op: 'browseKey', chunk: 'd' },
  ], { url: PAGE_URL });
  assert.equal(added.state.statusMsg, 'Added "Third" to downloads.');
  const refused = await runBoth('refused', stateFor(BUTTONS, { cursor: 2, keys: bound('download-link', 'd') }, {
    downloadOutcome: { ok: false, reason: 'has no address' },
  }), [
    { op: 'browseKey', chunk: 'd' },
  ], { url: PAGE_URL });
  assert.equal(refused.state.statusMsg, 'Could not download "Third": has no address.');
});

test('the change walk moves through what changed, in document order', { skip: needsCrystal }, async () => {
  const first = await runBoth('first', stateFor(BUTTONS, {}, {
    changeTargets: [{ block: 0, size: 2 }, { block: 2, size: 1 }],
  }), [
    { op: 'browseKey', chunk: 'c' },
  ], { url: PAGE_URL });
  assert.equal(first.state.statusMsg, 'Change 1 of 2 (2 lines).');
  assert.equal(first.state.cursor, 0);
  const second = await runBoth('second', stateFor(BUTTONS, {}, {
    changeTargets: [{ block: 0, size: 2 }, { block: 2, size: 1 }],
    changeIndex: 0,
  }), [
    { op: 'browseKey', chunk: 'c' },
  ], { url: PAGE_URL });
  assert.equal(second.state.statusMsg, 'Change 2 of 2 (1 line).');
  assert.equal(second.state.cursor, 2);
  const none = await runBoth('none', stateFor(BUTTONS), [
    { op: 'jumpToChange', direction: 1 },
  ], { url: PAGE_URL });
  assert.equal(none.state.statusMsg, 'No recorded changes.');
});

test('a lynx digit opens the number prompt', { skip: needsCrystal }, async () => {
  const state = stateFor(BUTTONS, {
    interface: 'lynx',
    keys: { profile: 'lynx', preferences: { numberLinks: true } },
  });
  const result = await runBoth('digit', state, [
    { op: 'browseKey', chunk: '2' },
  ], { url: PAGE_URL });
  assert.equal(result.state.mode, 'number');
  assert.equal(result.state.linkNumber.text, '2');
});



test('the ordinary quick navs jump and say what they found', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'heading', item: { role: 'heading', name: 'heading' } },
    { text: '[First]', item: { role: 'button', name: 'First' } },
    { text: '[Second]', item: { role: 'button', name: 'Second' } },
  ];
  const state = stateFor(blocks, { cursor: 0, keys: bound('next-button', 'o') });
  const result = await runBoth('next button', state, [
    { op: 'browseKey', chunk: 'o' },
  ], { url: PAGE_URL });
  assert.equal(result.state.statusMsg, '', 'a quick nav lands without a word');
  assert.equal(result.state.cursor, 1);
  const nothing = await runBoth('nothing', stateFor([
    { text: 'text only', item: { role: 'text' } },
  ], { keys: bound('next-button', 'o') }), [
    { op: 'browseKey', chunk: 'o' },
  ], { url: PAGE_URL });
  assert.equal(nothing.state.statusMsg, 'No next button.');
});

test('enter activates what the cursor stands on', { skip: needsCrystal }, async () => {
  const state = stateFor(BUTTONS);
  const result = await runBoth('activate', state, [
    { op: 'browseKey', chunk: '\r' },
  ], { url: PAGE_URL });
  assert.equal(result.state.statusMsg, 'Activated: Second — no visible change.');
  assert.deepEqual(result.state.activated, [{ role: 'button', name: 'Second' }]);
});
