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
  handleBrowseKey, handleNumberKey, itemUnderCursor, relayout, renderRow,
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

function displayPartsForBlock(state, blockIndex) {
  const found = [];
  state.lines.forEach((line, lineIndex) => {
    if (line.spans) {
      for (const span of line.spans) {
        if (span.blockIndex === blockIndex) found.push({ line, lineIndex, span });
      }
    } else if (line.blockIndex === blockIndex) {
      found.push({ line, lineIndex, span: null });
    }
  });
  return found;
}

function numberedTargets(state) {
  const found = new Map();
  for (const line of state.lines) {
    if (line.spans) {
      for (const span of line.spans) {
        if (span.displayNumber && !found.has(span.blockIndex)) found.set(span.blockIndex, span.displayNumber);
      }
    } else if (!line.continuation && line.displayNumber) {
      found.set(line.blockIndex, line.displayNumber);
    }
  }
  return found;
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
  const [{ line, lineIndex, span }] = displayPartsForBlock(state, blockIndex);
  state.cursor = lineIndex;
  state.col = span ? span.start : 0;
  const number = span ? span.displayNumber : line.displayNumber;
  assert.ok(number >= 1, 'the link was not numbered');
  assert.equal(span ? line.text.slice(span.start, span.end) : line.text, 'Go',
    'the Lynx copy carries the link text without its marker');

  await quietly(async () => {
    await handleBrowseKey(String(number), state, page);
    assert.equal(state.mode, 'number');
    await handleNumberKey('\r', state, page);
  });

  assert.equal(await page.evaluate(() => window.clicked), 1);
  assert.equal(state.mode, 'browse');
});

test('inline prose reflows while each link stays reachable in every view', async () => {
  const page = await openHtml(`
    <p>Before <a href="#" onclick="window.clicked = 'one'; event.preventDefault()">one</a>
      middle <a href="#" onclick="window.clicked = 'two'; event.preventDefault()">two</a> after.</p>
  `);

  for (const source of ['ax', 'render']) {
    await page.evaluate(() => { window.clicked = null; });
    const core = new Core({ driver, page, source, sources: [source, 'source'] });
    await core.rescan();
    const keys = new Keymap({ terminfo: {}, profile: 'lynx', load: false });
    keys.preferences = { numberLinks: true, numberFields: false };
    const state = makeState(core, keys, { sources: [source, 'source'] });
    relayout(state);

    const oneIndex = core.blocks.findIndex((block) => block.item && block.item.name === 'one');
    const twoIndex = core.blocks.findIndex((block) => block.item && block.item.name === 'two');
    const [one] = displayPartsForBlock(state, oneIndex);
    const [two] = displayPartsForBlock(state, twoIndex);
    assert.equal(one.lineIndex, two.lineIndex, `${source}: both links share the prose line`);
    assert.equal(one.line.text, 'Before [1]one middle [2]two after.');
    assert.equal(one.line.text.slice(one.span.start, one.span.end), 'one');
    assert.equal(two.line.text.slice(two.span.start, two.span.end), 'two');

    state.cursor = two.lineIndex;
    state.col = two.span.start;
    assert.match(renderRow(state, two.lineIndex), /middle \[2\]\x1b\[7mtwo\x1b\[0m after/,
      `${source}: only the second link is highlighted`);

    await quietly(async () => {
      await handleBrowseKey('\\', state, page);
      await handleBrowseKey('\\', state, page);
    });
    assert.equal(core.source, source, `${source}: returned from SOURCE`);
    assert.equal(itemUnderCursor(state).name, 'two', `${source}: retained the exact inline link`);

    await quietly(async () => {
      await handleBrowseKey('2', state, page);
      await handleNumberKey('\r', state, page);
    });
    assert.equal(await page.evaluate(() => window.clicked), 'two', `${source}: the second element ran`);
  }
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
  const [{ line: twoLine, span: twoSpan }] = displayPartsForBlock(state, two);
  const captured = twoSpan ? twoSpan.displayNumber : twoLine.displayNumber;
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
  const numbered = numberedTargets(state);
  assert.deepEqual([...numbered.values()], [1, 2]);
  const goIndex = state.core.blocks.findIndex((block) => block.item && block.item.name === 'Go');
  assert.equal(numbered.get(goIndex), 2);
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
  const goIndex = core.blocks.findIndex((block) => block.item && block.item.name === 'Go');
  const [{ line: lynxLine, span: lynxSpan }] = displayPartsForBlock(lynx, goIndex);
  assert.equal(lynxLine.text.slice(lynxSpan.start, lynxSpan.end), 'Go');
  assert.equal(lynxSpan.displayNumber, 1);
  assert.equal(lynxLine.text.slice(lynxSpan.start - 3, lynxSpan.start), '[1]');
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
    const numbered = numberedTargets(state);
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
    const rows = displayPartsForBlock(state, longBlock)
      .map(({ line, lineIndex, span }) => ({ line, index: lineIndex, span }));
    assert.ok(rows.length > 1, `${source}: the long link did not wrap`);
    const firstNumber = rows[0].span ? rows[0].span.displayNumber : rows[0].line.displayNumber;
    assert.ok(firstNumber, `${source}: the first row carries the number`);
    state.cursor = rows[0].index;
    state.col = rows[0].span ? rows[0].span.start : 0;
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
