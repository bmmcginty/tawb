'use strict';

// The Lynx interface against a real browser.
//
//     TWEB_TEST_BROWSER=chromium node --test test/browser/lynx.test.js
//     TWEB_TEST_BROWSER=firefox  node --test test/browser/lynx.test.js
//
// The unit tests pin the rendering, numbering, prompts, and key translation.
// What only a browser can answer is whether the browser-backed paths those
// features hand off to — activation through a numbered link, rescanning for
// SOURCE — actually reach the page, and whether the default interface really
// is untouched on the same blocks.

const test = require('node:test');
const assert = require('node:assert');

const { tempDir, removeTempDir } = require('../tmpdir');
const { openDriver } = require('../../src/driver');
const { Core } = require('../../src/core');
const { Keymap } = require('../../src/keys');
const {
  handleBrowseKey, handleNumberKey, relayout, renderRow,
} = require('../../src/index');

const ANSI_REVERSE = '\x1b[7m';

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const profile = tempDir('tweb-lynx-');
let driver;

test.after(async () => {
  if (driver) await driver.close();
  removeTempDir(profile);
});

const PAGE = `
  <h1>Lynx page</h1>
  <p>Read the <a id="go" href="#" onclick="window.clicked = (window.clicked || 0) + 1; event.preventDefault()">Go</a> link.</p>
  <input aria-label="Query">
`;

async function openHtml(html) {
  driver = driver || await openDriver({ engine: ENGINE, profile, log: () => {} });
  const page = driver.context.pages()[0] || await driver.context.newPage();
  await page.goto('data:text/html,' + encodeURIComponent(html));
  return page;
}

function openPage() {
  return openHtml(PAGE);
}

function makeState(core, keys, options = {}) {
  return {
    interface: 'lynx',
    core,
    driver,
    keys,
    sources: ['ax', 'source'],
    lines: [],
    cursor: 0,
    col: 0,
    scroll: 0,
    mode: 'browse',
    typing: null,
    inputSeen: false,
    historyPlaces: new WeakMap(),
    statusMsg: '',
    statusHeldUntil: 0,
    title: '',
    library: null,
    dialog: null,
    linkAddress: false,
    drawn: { title: null, address: null, hint: null, status: null },
    ...options,
  };
}

function quietly(fn) {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  return Promise.resolve().then(fn).finally(() => { process.stdout.write = write; });
}

test('a numbered Lynx link activates the element it numbered', async () => {
  const page = await openPage();
  const core = new Core({ driver, page, source: 'ax' });
  await core.rescan();

  const keys = new Keymap({ terminfo: {}, profile: 'lynx', load: false });
  keys.preferences = { numberLinks: true, numberFields: false };
  const state = makeState(core, keys);
  relayout(state);

  const blockIndex = core.blocks.findIndex((block) => block.item
    && block.item.role === 'link' && block.item.name === 'Go');
  assert.ok(blockIndex >= 0, 'the link was not extracted');
  const line = state.lines.findIndex((entry) => entry.blockIndex === blockIndex);
  state.cursor = line;
  const number = state.lines[line].displayNumber;
  assert.ok(number >= 1, 'the link was not numbered');
  assert.equal(state.lines[line].text, 'Go', 'the Lynx copy carries no markers');

  await quietly(async () => {
    await handleBrowseKey(String(number), state, page);
    assert.equal(state.mode, 'number');
    await handleNumberKey('\r', state, page);
  });

  assert.equal(await page.evaluate(() => window.clicked), 1);
  assert.equal(state.mode, 'browse');
});

test('a live update renumbers but cannot retarget an open number prompt', async () => {
  const page = await openPage();
  const core = new Core({ driver, page, source: 'ax' });
  await core.rescan();

  const keys = new Keymap({ terminfo: {}, profile: 'lynx', load: false });
  keys.preferences = { numberLinks: true, numberFields: false };
  const state = makeState(core, keys);
  relayout(state);

  const two = core.blocks.findIndex((block) => block.item
    && block.item.role === 'link' && block.item.name === 'Go');
  const twoLine = state.lines.findIndex((entry) => entry.blockIndex === two);
  const captured = state.lines[twoLine].displayNumber;
  assert.ok(captured >= 1);

  // The reader opens the prompt on that number. Then the page puts a link in
  // front of it, which is exactly what a live update on a busy page does.
  await quietly(async () => {
    await handleBrowseKey(String(captured), state, page);
    assert.equal(state.mode, 'number');

    await page.evaluate(() => {
      const early = document.createElement('a');
      early.href = '#';
      early.textContent = 'Inserted';
      early.addEventListener('click', (event) => {
        window.clicked = 'inserted';
        event.preventDefault();
      });
      document.body.insertBefore(early, document.body.firstChild);
    });
    // The accessibility tree picks the new link up on its own schedule.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await core.rescan();
      if (core.blocks.some((block) => block.item && block.item.name === 'Inserted')) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(core.blocks.some((block) => block.item && block.item.name === 'Inserted'),
      'the inserted link never appeared in the rebuilt view');
    relayout(state);

    await handleNumberKey('\r', state, page);
  });

  assert.equal(await page.evaluate(() => window.clicked), undefined,
    'the freshly inserted link was not activated by the old number');
  assert.equal(state.statusMsg, `No link ${captured} on this page.`);

  // The numbering itself did follow the new order: reading order, no gaps,
  // and the link that used to hold 1 now holds 2.
  const numbered = state.lines.filter((line) => line.displayNumber).map((line) => line.displayNumber);
  assert.deepEqual(numbered, [1, 2]);
  const goLine = state.lines.find((line) => state.core.blocks[line.blockIndex]
    && state.core.blocks[line.blockIndex].item
    && state.core.blocks[line.blockIndex].item.name === 'Go');
  assert.equal(goLine.displayNumber, 2);
});

test('the same blocks keep TAWB markers unless the Lynx interface is selected', async () => {
  const page = await openPage();
  const core = new Core({ driver, page, source: 'ax' });
  await core.rescan();

  const ordinary = makeState(core, new Keymap({ terminfo: {}, load: false }), {
    interface: 'default',
  });
  relayout(ordinary);
  const ordinaryLine = ordinary.lines.find((entry) => {
    const block = core.blocks[entry.blockIndex];
    return block && block.item && block.item.name === 'Go';
  });
  assert.equal(ordinaryLine.text, '{Go}', 'the default view is TAWB’s own vocabulary');
  assert.ok(!ordinaryLine.displayNumber);
  assert.ok(!ordinaryLine.displayPrefix);

  const lynx = makeState(core, new Keymap({ terminfo: {}, profile: 'lynx', load: false }));
  lynx.keys.preferences = { numberLinks: true, numberFields: false };
  relayout(lynx);
  const lynxLine = lynx.lines.find((entry) => {
    const block = core.blocks[entry.blockIndex];
    return block && block.item && block.item.name === 'Go';
  });
  assert.equal(lynxLine.text, 'Go');
  assert.equal(lynxLine.displayNumber, 1);
  assert.equal(lynxLine.displayPrefix, '[1]');
  assert.equal(core.blocks[core.blocks.indexOf(
    core.blocks.find((block) => block.item && block.item.name === 'Go'))].text,
  '{Go}', 'the core text never changed');
});

test('numbering stays in reading order, and wraps, in every view', async () => {
  const page = await openHtml(`
    <h1>Views</h1>
    <p><a href="#long">A link whose name is long enough that it cannot fit on one terminal row at eighty columns</a><a href="#two">Two</a></p>
    <input aria-label="Query">
  `);

  const sources = ['ax', 'render', 'inspect', 'source'].filter(
    (source) => source !== 'inspect' || driver.capabilities?.ax !== false);
  for (const source of sources) {
    const core = new Core({ driver, page, source, sources: [source] });
    await core.rescan();
    const keys = new Keymap({ terminfo: {}, profile: 'lynx', load: false });
    keys.preferences = { numberLinks: true, numberFields: true };
    const state = makeState(core, keys, { sources: [source] });
    relayout(state);

    // One number per block, in reading order and with no gaps. A wrapped
    // block repeats its number on each row for the marker's sake, so only the
    // row that starts it counts here.
    const numbered = new Map();
    for (const line of state.lines) {
      if (line.continuation || !line.displayNumber) continue;
      assert.ok(!numbered.has(line.blockIndex), `${source}: a block was numbered twice`);
      numbered.set(line.blockIndex, line.displayNumber);
    }
    assert.deepEqual([...numbered.values()],
      [...numbered.values()].map((unused, index) => index + 1),
      `${source}: numbers are contiguous`);
    for (const blockIndex of numbered.keys()) {
      const block = core.blocks[blockIndex];
      assert.ok(block && block.item, `${source}: a numbered line has an item`);
      assert.ok(['link', 'textbox'].includes(block.item.role),
        `${source}: ${block.item.role} was numbered`);
    }

    // The long link wraps. Its marker stays on the first row, its reverse
    // video covers every row it occupies, and no line text carries ANSI.
    const longBlock = core.blocks.findIndex((block) => block.item
      && block.item.role === 'link' && /long enough/.test(block.item.name));
    assert.ok(longBlock >= 0, `${source}: the long link was extracted`);
    const rows = state.lines.map((line, index) => ({ line, index }))
      .filter(({ line }) => line.blockIndex === longBlock);
    assert.ok(rows.length > 1, `${source}: the long link did not wrap`);
    assert.ok(rows[0].line.displayPrefix, `${source}: the first row carries the number`);
    for (const { line } of rows.slice(1)) {
      assert.ok(!line.displayPrefix, `${source}: a continuation row has no number`);
    }
    state.cursor = rows[0].index;
    for (const { line, index } of rows) {
      const rendered = renderRow(state, index);
      assert.ok(rendered.includes(ANSI_REVERSE), `${source}: row ${index} was not highlighted`);
      assert.ok(!line.text.includes('\x1b'), `${source}: ANSI entered searchable text`);
    }
  }
});

test('Lynx SOURCE shows the markup and returns to the presentation view', async () => {
  const page = await openPage();
  const core = new Core({ driver, page, source: 'ax', sources: ['ax', 'source'] });
  await core.rescan();

  const state = makeState(core, new Keymap({ terminfo: {}, profile: 'lynx', load: false }));
  relayout(state);

  await quietly(() => handleBrowseKey('\\', state, page));
  assert.equal(core.source, 'source');
  assert.ok(state.lines.some((line) => line.text.includes('<a')),
    'the source view did not show markup');

  await quietly(() => handleBrowseKey('\\', state, page));
  assert.equal(core.source, 'ax', 'the reader returns to the view they were reading');
  assert.ok(!state.lines.some((line) => line.text.includes('<a')),
    'the presentation view came back');
});

test('a table row is one line, and its cells stay reachable in every view', async () => {
  const page = await openHtml(`
    <table>
      <tr><th>Name</th><th>Detail</th></tr>
      <tr><td><a href="#" onclick="window.clicked = 'yes'; event.preventDefault()">Go</a></td><td>Plain</td></tr>
      <tr><td><input aria-label="Cell field"></td><td>Other</td></tr>
    </table>
  `);

  for (const source of ['ax', 'render']) {
    const core = new Core({ driver, page, source, sources: [source] });
    await core.rescan();
    await page.evaluate(() => { window.clicked = null; });

    const keys = new Keymap({ terminfo: {}, profile: 'lynx', load: false });
    keys.preferences = { numberLinks: true, numberFields: true, textfieldsNeedActivation: true };
    const state = makeState(core, keys, { sources: [source, 'source'] });
    relayout(state);

    const rowWith = (name) => state.lines.find((line) => (line.spans || [])
      .some((span) => core.blocks[span.blockIndex].item.name === name));
    const spanNamed = (line, name) => line.spans
      .find((span) => core.blocks[span.blockIndex].item.name === name);

    const header = rowWith('Name');
    const data = rowWith('Go');
    assert.ok(header && header.spans.length === 2, `${source}: the header row is one line`);
    assert.equal(spanNamed(header, 'Detail').start, spanNamed(data, 'Plain').start,
      `${source}: the second column lines up`);

    // The number precedes the cell text and is not part of the span.
    const go = spanNamed(data, 'Go');
    assert.equal(data.text.slice(go.start, go.end), 'Go');
    assert.match(data.text.slice(0, go.start), /\[\d+\]$/);

    // Following the number activates the real element in the cell rather than
    // merely moving to the row.
    await quietly(async () => {
      await handleBrowseKey('1', state, page);
      await handleNumberKey('\r', state, page);
    });
    assert.equal(await page.evaluate(() => window.clicked), 'yes', `${source}: the cell link ran`);

    // A field's number moves without submitting, and lands in its own cell.
    await quietly(async () => {
      await handleBrowseKey('2', state, page);
      await handleNumberKey('g', state, page);
    });
    // Activation may have rebuilt the block list, so find the field in the
    // current one rather than holding the object from before.
    const field = core.blocks.find((block) => block.item
      && block.item.role === 'textbox' && block.item.name === 'Cell field');
    const current = state.lines[state.cursor];
    const span = current.spans && current.spans
      .find((one) => core.blocks[one.blockIndex] === field);
    assert.ok(span, `${source}: the number moved to the field's row`);
    assert.equal(state.col, span.start, `${source}: and to the field's own cell`);

    // SOURCE and back: a place captured on a merged row still comes back to
    // the table rather than to a line number that no longer means anything.
    await quietly(async () => { await handleBrowseKey('\\', state, page); });
    assert.equal(core.source, 'source', `${source}: reached SOURCE`);
    await quietly(async () => { await handleBrowseKey('\\', state, page); });
    assert.equal(core.source, source, `${source}: returned from SOURCE`);
    assert.ok(state.lines.some((line) => line.spans), `${source}: the table is a row again`);
  }
});
