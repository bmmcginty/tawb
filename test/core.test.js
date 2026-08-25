'use strict';

// The rules the core keeps about a reader's place, and about what is worth
// telling them. None of this needs a browser: it is all decided over a list
// of blocks, which is the point of the buffer being blocks.
//
// Several of these encode decisions that took real pages to discover, and
// they are the ones most likely to be undone by accident, because each looks
// like an arbitrary choice until the page that forced it turns up again.

const test = require('node:test');
const assert = require('node:assert');

const { Core } = require('../src/core');

const blocksOf = (texts) => texts.map((text, i) => ({ text, item: { name: text, domIndex: i } }));

function coreWith(texts, cursorBlock = 0) {
  const core = new Core({ driver: {}, page: {}, source: 'html', sources: ['html'] });
  core.blocks = blocksOf(texts);
  core.at(cursorBlock);
  return core;
}

const PAGE = ['head', 'a', 'b', 'CLOCK 10:00:00', 'c', 'd', 'tail'];

test('keeping the reader in place', async (t) => {
  await t.test('nothing changed leaves them exactly where they were', () => {
    const core = coreWith(PAGE, 3);
    const anchor = core.anchor();
    const before = core.texts();
    assert.deepEqual(core.reanchor(anchor, before), { block: 3, exact: true });
  });

  await t.test('a clock rewriting itself does not move them off it', () => {
    // The line's own text is what changed, so matching on text can never
    // find it; the arithmetic can.
    const core = coreWith(PAGE, 3);
    const anchor = core.anchor();
    const before = core.texts();
    core.blocks = blocksOf(['head', 'a', 'b', 'CLOCK 10:00:01', 'c', 'd', 'tail']);
    const settled = core.reanchor(anchor, before);
    assert.equal(core.blockText(settled.block), 'CLOCK 10:00:01');
  });

  await t.test('content inserted above carries them down with it', () => {
    const core = coreWith(PAGE, 3);
    const anchor = core.anchor();
    const before = core.texts();
    core.blocks = blocksOf(['head', 'NEW', 'NEW2', 'a', 'b', 'CLOCK 10:00:00', 'c', 'd', 'tail']);
    const settled = core.reanchor(anchor, before);
    assert.equal(core.blockText(settled.block), 'CLOCK 10:00:00');
  });

  await t.test('content removed above carries them up with it', () => {
    const core = coreWith(PAGE, 3);
    const anchor = core.anchor();
    const before = core.texts();
    core.blocks = blocksOf(['a', 'b', 'CLOCK 10:00:00', 'c', 'd', 'tail']);
    const settled = core.reanchor(anchor, before);
    assert.equal(core.blockText(settled.block), 'CLOCK 10:00:00');
  });

  await t.test('two blocks reading the same: the near one wins', () => {
    // Not the first from the top. Two buttons called "Open", a page of
    // <option value=30> — the first match can be the length of the document
    // away from where the reader was standing.
    const repeated = ['x', 'same', 'y', 'same', 'z', 'same', 'w'];
    const core = coreWith(repeated, 5);
    const anchor = core.anchor();
    const before = core.texts();
    core.blocks = blocksOf(['PRE', ...repeated]);
    assert.equal(core.reanchor(anchor, before).block, 6);
  });
});

test('putting them back after a change they asked for', async (t) => {
  await t.test('finds the same block in a buffer of a different length', () => {
    const core = coreWith(PAGE, 3);
    const anchor = core.anchor();
    core.blocks = blocksOf(['q', 'w', 'e', 'r', 'CLOCK 10:00:00', 't', 'y', 'u']);
    assert.equal(core.restore(anchor), 4);
  });

  await t.test('of two that read the same it chooses the one they were on', () => {
    // This is the bug where pressing the second of two buttons called "Open"
    // left the reader standing on the first.
    const core = coreWith(['a', '[*Open]', 'b', '[*Open]', 'c'], 3);
    const anchor = core.anchor();
    core.blocks = blocksOf(['a', '[*Open]', 'b', '[*Open]', 'c']);
    assert.equal(core.restore(anchor), 3);
  });
});

test('what is worth being told about', async (t) => {
  await t.test('one thing changing does not erase another', () => {
    const core = coreWith(PAGE, 0);
    core.recordChanges([{ start: 1, end: 1 }]);
    core.recordChanges([{ start: 5, end: 5 }]);
    assert.equal(core.changeTargets().length, 2);
  });

  await t.test('a place that keeps changing stops being news', () => {
    // A clock, a countdown, a view counter. It goes on being readable; it
    // just stops drowning out the thing that actually happened.
    const core = coreWith(PAGE, 0);
    for (let tick = 0; tick < 6; tick += 1) {
      core.blocks[3].text = `CLOCK 10:00:0${tick}`;
      core.recordChanges([{ start: 3, end: 3 }]);
    }
    const clockEntries = core.changeTargets().filter((c) => c.block === 3);
    assert.equal(clockEntries.length, 0, 'the clock should have stopped counting as news');
  });

  await t.test('a change whose text is gone is dropped, not followed blindly', () => {
    const core = coreWith(PAGE, 0);
    core.recordChanges([{ start: 5, end: 5 }]);
    core.blocks = blocksOf(['completely', 'different', 'page']);
    assert.equal(core.changeTargets().length, 0);
  });

  await t.test('changes are visited in document order', () => {
    const core = coreWith(PAGE, 0);
    core.recordChanges([{ start: 5, end: 5 }]);
    core.recordChanges([{ start: 1, end: 1 }]);
    const order = core.changeTargets().map((c) => c.block);
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
  });
});

test('splicing text in without a snapshot', async (t) => {
  await t.test('a replacement that names one block is applied', () => {
    const core = coreWith(PAGE, 0);
    const patched = core.patchText([{ from: '10:00:00', to: '10:00:01' }]);
    assert.ok(patched);
    assert.deepEqual(patched.touched, [3]);
    assert.equal(core.blockText(3), 'CLOCK 10:00:01');
  });

  await t.test('text that names two blocks is refused', () => {
    // Ambiguity is the whole risk: we cannot say which one the page rewrote.
    const core = coreWith(['a 12:04', 'b 12:04'], 0);
    assert.equal(core.patchText([{ from: '12:04', to: '12:05' }]), null);
  });

  await t.test('the block the reader is standing on is left alone', () => {
    const core = coreWith(PAGE, 3);
    assert.equal(core.patchText([{ from: '10:00:00', to: '10:00:01' }], { protect: true }), null);
    assert.equal(core.blockText(3), 'CLOCK 10:00:00', 'and put back as it was');
  });

  await t.test('undo returns the buffer exactly as it was', () => {
    const core = coreWith(PAGE, 0);
    const patched = core.patchText([{ from: '10:00:00', to: '10:00:01' }]);
    patched.undo();
    assert.deepEqual(core.texts(), PAGE);
  });
});

test('a dropdown becomes lines under its control', async (t) => {
  const listing = {
    multiple: false,
    selectedIndex: 1,
    options: [
      { text: 'Ukraine', selected: false, disabled: false },
      { text: 'United States', selected: true, disabled: false },
      { text: 'United States Minor Outlying Islands', selected: false, disabled: false },
    ],
  };

  await t.test('its entries are spliced in directly beneath it', () => {
    const core = coreWith(['before', '[Country: United States]', 'after'], 1);
    core.openChooser(1, listing);
    assert.equal(core.blocks.length, 3 + 3);
    assert.match(core.blockText(2), /Ukraine/);
    assert.match(core.blockText(3), /\(\*\) United States$/, 'the chosen one is marked');
    assert.equal(core.blockText(5), 'after', 'and what followed is still after them');
  });

  await t.test('typing narrows our own lines', () => {
    const core = coreWith(['before', '[Country: United States]', 'after'], 1);
    core.openChooser(1, listing);
    assert.equal(core.showChooser('Ukr'), 1);
    assert.equal(core.showChooser('United States'), 2, 'a prefix matches both, as it must');
    assert.equal(core.showChooser(''), 3);
  });

  await t.test('closing puts the buffer back', () => {
    const core = coreWith(['before', '[Country: United States]', 'after'], 1);
    core.openChooser(1, listing);
    core.closeChooser();
    assert.deepEqual(core.texts(), ['before', '[Country: United States]', 'after']);
  });
});

test('a privileged native media control can receive the real-click command', async () => {
  let received = null;
  const page = {};
  const driver = {
    activateNativeControl: async (scope, item) => { received = { scope, item }; return true; },
  };
  const core = new Core({ driver, page, source: 'ax', sources: ['ax'] });
  const item = { role: 'menuitemradio', name: '1.5', nativeControl: { media: 0, index: 7 } };
  assert.deepEqual(await core.realClick(item), { ok: true, reason: null });
  assert.deepEqual(received, { scope: page, item });
});

test('a popup rendered at the end of the document is brought to its control', () => {
  // Frameworks render a menu into the end of <body> so nothing can clip it,
  // which in a line list puts it nowhere near the button that opened it.
  const core = new Core({ driver: {}, page: {}, source: 'ax', sources: ['ax'] });
  core.blocks = [
    { text: 'top', item: { name: 'top' } },
    { text: '[*Account, expanded]', item: { name: 'Account', controls: 'account-menu' } },
    { text: 'lots', item: { name: 'lots' } },
    { text: 'of', item: { name: 'of' } },
    { text: 'page', item: { name: 'page' } },
    { text: '[*Profile]', item: { name: 'Profile', popup: 'account-menu' } },
    { text: '[*Sign out]', item: { name: 'Sign out', popup: 'account-menu' } },
  ];
  core.followPopup('account-menu');
  assert.equal(core.relocatePopup(), 2);
  assert.deepEqual(core.texts().slice(1, 4), ['[*Account, expanded]', '[*Profile]', '[*Sign out]']);
  assert.equal(core.popupAt(), 2);
});
