'use strict';

// The core's buffer policy, differenced between the JavaScript original and
// the Crystal port: the same pages, the same moves, the same changes. Where
// the reader is put back after a rebuild, what counts as news, which patch is
// refused — every answer the reader's place depends on must come out the same
// on both runtimes.
//
// Several of these encode decisions that took real pages to discover, and
// they are the ones most likely to be undone by accident, because each looks
// like an arbitrary choice until the page that forced it turns up again.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const coreModule = require('../src/core');
const { acceptWebSocket } = require('../src/broker');
const { coreImplementations } = require('./crystal_impl');

const PAGE = ['head', 'a', 'b', 'CLOCK 10:00:00', 'c', 'd', 'tail'];

const LISTING = {
  multiple: false,
  selectedIndex: 1,
  options: [
    { text: 'Ukraine', selected: false, disabled: false },
    { text: 'United States', selected: true, disabled: false },
    { text: 'United States Minor Outlying Islands', selected: false, disabled: false },
  ],
};

// Each scenario runs step by step on both runtimes and answers one
// observation per step; the expectations below were read off the JavaScript
// original, which is the oracle.
const scripts = {
  'nothing changed leaves them exactly where they were': [
    { op: 'blocks', texts: PAGE, cursor: 3 },
    { op: 'anchor', id: 'a' },
    { op: 'texts', id: 'before' },
    { op: 'reanchor', anchor: 'a', previous: 'before' },
  ],

  'a clock rewriting itself does not move them off it': [
    { op: 'blocks', texts: PAGE, cursor: 3 },
    { op: 'anchor', id: 'a' },
    { op: 'texts', id: 'before' },
    { op: 'blocks', texts: ['head', 'a', 'b', 'CLOCK 10:00:01', 'c', 'd', 'tail'] },
    { op: 'reanchor', anchor: 'a', previous: 'before' },
  ],

  'content inserted above carries them down with it': [
    { op: 'blocks', texts: PAGE, cursor: 3 },
    { op: 'anchor', id: 'a' },
    { op: 'texts', id: 'before' },
    { op: 'blocks', texts: ['head', 'NEW', 'NEW2', 'a', 'b', 'CLOCK 10:00:00', 'c', 'd', 'tail'] },
    { op: 'reanchor', anchor: 'a', previous: 'before' },
  ],

  'content removed above carries them up with it': [
    { op: 'blocks', texts: PAGE, cursor: 3 },
    { op: 'anchor', id: 'a' },
    { op: 'texts', id: 'before' },
    { op: 'blocks', texts: ['a', 'b', 'CLOCK 10:00:00', 'c', 'd', 'tail'] },
    { op: 'reanchor', anchor: 'a', previous: 'before' },
  ],

  // Not the first from the top. Two buttons called "Open", a page of
  // <option value=30> — the first match can be the length of the document
  // away from where the reader was standing.
  'two blocks reading the same: the near one wins': [
    { op: 'blocks', texts: ['x', 'same', 'y', 'same', 'z', 'same', 'w'], cursor: 5 },
    { op: 'anchor', id: 'a' },
    { op: 'texts', id: 'before' },
    { op: 'blocks', texts: ['PRE', 'x', 'same', 'y', 'same', 'z', 'same', 'w'] },
    { op: 'reanchor', anchor: 'a', previous: 'before' },
  ],

  'finds the same block in a buffer of a different length': [
    { op: 'blocks', texts: PAGE, cursor: 3 },
    { op: 'anchor', id: 'a' },
    { op: 'blocks', texts: ['q', 'w', 'e', 'r', 'CLOCK 10:00:00', 't', 'y', 'u'] },
    { op: 'restore', anchor: 'a' },
  ],

  // This is the bug where pressing the second of two buttons called "Open"
  // left the reader standing on the first.
  'of two that read the same it chooses the one they were on': [
    { op: 'blocks', texts: ['a', '[*Open]', 'b', '[*Open]', 'c'], cursor: 3 },
    { op: 'anchor', id: 'a' },
    { op: 'blocks', texts: ['a', '[*Open]', 'b', '[*Open]', 'c'] },
    { op: 'restore', anchor: 'a' },
  ],

  'one thing changing does not erase another': [
    { op: 'blocks', texts: PAGE, cursor: 0 },
    { op: 'record_changes', regions: [{ start: 1, end: 1 }] },
    { op: 'record_changes', regions: [{ start: 5, end: 5 }] },
    { op: 'change_targets' },
  ],

  // A clock, a countdown, a view counter. It goes on being readable; it
  // just stops drowning out the thing that actually happened.
  'a place that keeps changing stops being news': [
    { op: 'blocks', texts: PAGE, cursor: 0 },
    { op: 'blocks', texts: ['head', 'a', 'b', 'CLOCK 10:00:00', 'c', 'd', 'tail'] },
    { op: 'record_changes', regions: [{ start: 3, end: 3 }] },
    { op: 'blocks', texts: ['head', 'a', 'b', 'CLOCK 10:00:01', 'c', 'd', 'tail'] },
    { op: 'record_changes', regions: [{ start: 3, end: 3 }] },
    { op: 'blocks', texts: ['head', 'a', 'b', 'CLOCK 10:00:02', 'c', 'd', 'tail'] },
    { op: 'record_changes', regions: [{ start: 3, end: 3 }] },
    { op: 'blocks', texts: ['head', 'a', 'b', 'CLOCK 10:00:03', 'c', 'd', 'tail'] },
    { op: 'record_changes', regions: [{ start: 3, end: 3 }] },
    { op: 'blocks', texts: ['head', 'a', 'b', 'CLOCK 10:00:04', 'c', 'd', 'tail'] },
    { op: 'record_changes', regions: [{ start: 3, end: 3 }] },
    { op: 'blocks', texts: ['head', 'a', 'b', 'CLOCK 10:00:05', 'c', 'd', 'tail'] },
    { op: 'record_changes', regions: [{ start: 3, end: 3 }] },
    { op: 'change_targets' },
  ],

  'a change whose text is gone is dropped, not followed blindly': [
    { op: 'blocks', texts: PAGE, cursor: 0 },
    { op: 'record_changes', regions: [{ start: 5, end: 5 }] },
    { op: 'blocks', texts: ['completely', 'different', 'page'] },
    { op: 'change_targets' },
  ],

  'changes are visited in document order': [
    { op: 'blocks', texts: PAGE, cursor: 0 },
    { op: 'record_changes', regions: [{ start: 5, end: 5 }] },
    { op: 'record_changes', regions: [{ start: 1, end: 1 }] },
    { op: 'change_targets' },
  ],

  'a replacement that names one block is applied': [
    { op: 'blocks', texts: PAGE, cursor: 0 },
    { op: 'patch', patches: [{ from: '10:00:00', to: '10:00:01' }] },
    { op: 'block_text', index: 3 },
  ],

  // Ambiguity is the whole risk: we cannot say which one the page rewrote.
  'text that names two blocks is refused': [
    { op: 'blocks', texts: ['a 12:04', 'b 12:04'], cursor: 0 },
    { op: 'patch', patches: [{ from: '12:04', to: '12:05' }] },
  ],

  'the block the reader is standing on is left alone': [
    { op: 'blocks', texts: PAGE, cursor: 3 },
    { op: 'patch', patches: [{ from: '10:00:00', to: '10:00:01' }] },
    { op: 'block_text', index: 3 },
  ],

  'undo returns the buffer exactly as it was': [
    { op: 'blocks', texts: PAGE, cursor: 0 },
    { op: 'patch', patches: [{ from: '10:00:00', to: '10:00:01' }], id: 'u' },
    { op: 'undo', id: 'u' },
    { op: 'texts' },
  ],

  'its entries are spliced in directly beneath it': [
    { op: 'blocks', texts: ['before', '[Country: United States]', 'after'], cursor: 1 },
    { op: 'open_chooser', block_index: 1, listing: LISTING },
    { op: 'block_text', index: 2 },
    { op: 'block_text', index: 3 },
    { op: 'block_text', index: 5 },
    { op: 'texts' },
  ],

  'typing narrows our own lines': [
    { op: 'blocks', texts: ['before', '[Country: United States]', 'after'], cursor: 1 },
    { op: 'open_chooser', block_index: 1, listing: LISTING },
    { op: 'show_chooser', filter: 'Ukr' },
    { op: 'show_chooser', filter: 'United States' },
    { op: 'show_chooser', filter: '' },
    { op: 'in_chooser', index: 1 },
    { op: 'in_chooser', index: 2 },
    { op: 'in_chooser', index: 4 },
    { op: 'in_chooser', index: 5 },
  ],

  'attached paths survive only while the browser reports their names': [
    { op: 'remember_files', key: 'id:plain', paths: ['/home/reader/private/report.txt'] },
    { op: 'blocks', blocks: [{
      text: '[*Upload]',
      item: { role: 'button', name: 'Upload', file: { key: 'id:plain', names: ['report.txt'] } },
    }] },
    { op: 'restore_files' },
    { op: 'item_value', index: 0 },
    { op: 'block_text', index: 0 },
    { op: 'blocks', blocks: [{
      text: '[*Upload]',
      item: { role: 'button', name: 'Upload', file: { key: 'id:plain', names: [] } },
    }] },
    { op: 'restore_files' },
    { op: 'blocks', blocks: [{
      text: '[*Upload]',
      item: { role: 'button', name: 'Upload', file: { key: 'id:plain', names: ['report.txt'] } },
    }] },
    { op: 'restore_files' },
    { op: 'item_value', index: 0 },
  ],

  'attached paths are isolated by frame and control': [
    { op: 'remember_files', frame: 'main', key: 'same', paths: ['/private/main.txt'] },
    { op: 'remember_files', frame: 'child', key: 'same', paths: ['/secret/child.txt'] },
    { op: 'blocks', blocks: [
      { text: '[*Main]', item: {
        role: 'button', name: 'Main', file: { key: 'same', names: ['main.txt'] },
      } },
      { text: '[*Child]', item: {
        role: 'button', name: 'Child', frame: 'child',
        file: { key: 'same', names: ['child.txt'] },
      } },
    ] },
    { op: 'restore_files' },
    { op: 'texts' },
  ],

  'closing puts the buffer back': [
    { op: 'blocks', texts: ['before', '[Country: United States]', 'after'], cursor: 1 },
    { op: 'open_chooser', block_index: 1, listing: LISTING },
    { op: 'close_chooser' },
    { op: 'texts' },
  ],

  // Frameworks render a menu into the end of <body> so nothing can clip it,
  // which in a line list puts it nowhere near the button that opened it.
  'a popup rendered at the end of the document is brought to its control': [
    { op: 'blocks', cursor: 0, blocks: [
      { text: 'top' },
      { text: '[*Account, expanded]', item: { name: 'Account', controls: 'account-menu' } },
      { text: 'lots' },
      { text: 'of' },
      { text: 'page' },
      { text: '[*Profile]', item: { name: 'Profile', popup: 'account-menu' } },
      { text: '[*Sign out]', item: { name: 'Sign out', popup: 'account-menu' } },
    ] },
    { op: 'follow_popup', controls: 'account-menu' },
    { op: 'relocate_popup' },
    { op: 'texts' },
    { op: 'popup_at' },
  ],

  'a popup the page has closed is forgotten': [
    { op: 'blocks', cursor: 0, blocks: [
      { text: '[*Account]', item: { name: 'Account', controls: 'account-menu', expanded: false } },
    ] },
    { op: 'follow_popup', controls: 'account-menu' },
    { op: 'relocate_popup' },
    { op: 'popup_at' },
  ],

  'asking for more is only tried once': [
    { op: 'blocks', texts: PAGE, cursor: 0 },
    { op: 'rendered_url', url: 'http://example.com/a' },
    { op: 'no_more_to_load' },
    { op: 'exhaust' },
    { op: 'no_more_to_load' },
    { op: 'rendered_url', url: 'http://example.com/b' },
    { op: 'no_more_to_load' },
    { op: 'rendered_url', url: 'http://example.com/a' },
    { op: 'no_more_to_load' },
    { op: 'blocks', texts: ['x', 'y'], cursor: 0 },
    { op: 'no_more_to_load' },
  ],

  'the nearest matching block is found outward from the start': [
    { op: 'blocks', texts: PAGE, cursor: 0 },
    { op: 'find_near', start: 3, text: 'b' },
    { op: 'find_near', start: 0, text: 'zzz' },
  ],

  'a rebuild reports what changed, without a snapshot': [
    { op: 'blocks', texts: PAGE, cursor: 3 },
    { op: 'texts', id: 'before' },
    { op: 'blocks', texts: ['head', 'a', 'b', 'CLOCK 10:00:01', 'c', 'd', 'tail'] },
    { op: 'note_changes', previous: 'before' },
  ],
};

const implementations = coreImplementations(coreModule);

for (const implementation of implementations) {
  const check = (name, fn) => test(`${implementation.name}: ${name}`, fn);
  const run = (name) => implementation.scenario(scripts[name]);

  check('keeping the reader in place', () => {
    const settled = run('nothing changed leaves them exactly where they were');
    assert.deepEqual(settled[1], {
      text: 'CLOCK 10:00:00', name: 'CLOCK 10:00:00', identity: '#3', block: 3,
      context: PAGE,
    });
    assert.deepEqual(settled[3], { block: 3, exact: true });
  });

  check('keeping the reader in place: the clock', () => {
    // The line's own text is what changed, so matching on text can never
    // find it; the arithmetic can.
    const settled = run('a clock rewriting itself does not move them off it');
    assert.deepEqual(settled[4], { block: 3, exact: true });
  });

  check('keeping the reader in place: insertions and removals', () => {
    const inserted = run('content inserted above carries them down with it');
    assert.deepEqual(inserted[4], { block: 5, exact: true });
    const removed = run('content removed above carries them up with it');
    assert.deepEqual(removed[4], { block: 2, exact: true });
  });

  check('keeping the reader in place: repeated text', () => {
    const settled = run('two blocks reading the same: the near one wins');
    assert.deepEqual(settled[4], { block: 6, exact: true });
  });

  check('putting them back after a change they asked for', () => {
    const found = run('finds the same block in a buffer of a different length');
    assert.equal(found[3], 4);
    const chosen = run('of two that read the same it chooses the one they were on');
    assert.equal(chosen[3], 3);
  });

  check('what is worth being told about', () => {
    const both = run('one thing changing does not erase another');
    assert.deepEqual(both[1], [{ start: 1, end: 1, text: 'a' }]);
    assert.deepEqual(both[2], [{ start: 5, end: 5, text: 'd' }]);
    assert.deepEqual(both[3], [{ block: 1, size: 1 }, { block: 5, size: 1 }]);

    const clock = run('a place that keeps changing stops being news');
    assert.deepEqual(clock[2], [{ start: 3, end: 3, text: 'CLOCK 10:00:00' }]);
    assert.deepEqual(clock[4], [{ start: 3, end: 3, text: 'CLOCK 10:00:01' }]);
    assert.deepEqual(clock[6], [{ start: 3, end: 3, text: 'CLOCK 10:00:02' }]);
    assert.deepEqual(clock[8], [], 'the clock should have stopped counting as news');
    assert.deepEqual(clock[10], []);
    assert.deepEqual(clock[12], []);
    assert.deepEqual(clock[13], [], 'and should not have drowned the change memory either');

    const gone = run('a change whose text is gone is dropped, not followed blindly');
    assert.deepEqual(gone[3], []);

    const order = run('changes are visited in document order');
    assert.deepEqual(order[3], [{ block: 1, size: 1 }, { block: 5, size: 1 }]);
  });

  check('splicing text in without a snapshot', () => {
    const applied = run('a replacement that names one block is applied');
    assert.deepEqual(applied[1], { touched: [3], generation: 0 });
    assert.equal(applied[2], 'CLOCK 10:00:01');

    const refused = run('text that names two blocks is refused');
    assert.equal(refused[1], null);

    const protectedCase = run('the block the reader is standing on is left alone');
    assert.equal(protectedCase[1], null);
    assert.equal(protectedCase[2], 'CLOCK 10:00:00', 'and put back as it was');

    const undone = run('undo returns the buffer exactly as it was');
    assert.equal(undone[2], true);
    assert.deepEqual(undone[3], PAGE);
  });

  check('a dropdown becomes lines under its control', () => {
    const spliced = run('its entries are spliced in directly beneath it');
    assert.equal(spliced[2], '    ( ) Ukraine');
    assert.equal(spliced[3], '    (*) United States', 'the chosen one is marked');
    assert.equal(spliced[4], 'after', 'and what followed is still after them');
    assert.deepEqual(spliced[5], [
      'before',
      '[Country: United States]',
      '    ( ) Ukraine',
      '    (*) United States',
      '    ( ) United States Minor Outlying Islands',
      'after',
    ]);

    const narrowing = run('typing narrows our own lines');
    assert.equal(narrowing[2], 1);
    assert.equal(narrowing[3], 2, 'a prefix matches both, as it must');
    assert.equal(narrowing[4], 3);
    assert.deepEqual(narrowing.slice(5), [false, true, true, false]);

    const closed = run('closing puts the buffer back');
    assert.deepEqual(closed[3], ['before', '[Country: United States]', 'after']);
  });

  check('file paths survive only while the browser reports their names', () => {
    const restored = run('attached paths survive only while the browser reports their names');
    assert.equal(restored[3], '/home/reader/private/report.txt');
    assert.equal(restored[4], '[*Upload: /home/reader/private/report.txt]');
    assert.equal(restored.at(-1), null, 'a cleared selection also cleared the private path');
  });

  check('file paths are isolated by frame and control', () => {
    const restored = run('attached paths are isolated by frame and control');
    assert.deepEqual(restored.at(-1), [
      '[*Main: /private/main.txt]',
      '[*Child: /secret/child.txt]',
    ]);
  });

  check('a popup is brought to its control', () => {
    const moved = run('a popup rendered at the end of the document is brought to its control');
    assert.equal(moved[2], 2);
    assert.deepEqual(moved[3], [
      'top', '[*Account, expanded]', '[*Profile]', '[*Sign out]', 'lots', 'of', 'page',
    ]);
    assert.equal(moved[4], 2);

    const forgotten = run('a popup the page has closed is forgotten');
    assert.equal(forgotten[2], 0);
    assert.equal(forgotten[3], -1);
  });

  check('asking for more is only tried once', () => {
    const tried = run('asking for more is only tried once');
    assert.deepEqual(
      [tried[2], tried[4], tried[6], tried[8], tried[10]],
      [false, true, false, true, false],
    );
  });

  check('finding the nearest matching block', () => {
    const found = run('the nearest matching block is found outward from the start');
    assert.deepEqual(found.slice(1), [2, -1]);
  });

  check('a rebuild reports what changed, without a snapshot', () => {
    const news = run('a rebuild reports what changed, without a snapshot');
    assert.deepEqual(news[3], [{ start: 3, end: 3, text: 'CLOCK 10:00:01' }]);
  });

  check('slider keys map onto an advertised ARIA range', () => {
    const state = { value: '50', min: '0', max: '100', step: '2' };
    assert.equal(implementation.sliderTarget(state, 'ArrowUp'), 52);
    assert.equal(implementation.sliderTarget(state, 'ArrowLeft'), 48);
    assert.equal(implementation.sliderTarget(state, 'PageDown'), 40);
    assert.equal(implementation.sliderTarget(state, 'Home'), 0);
    assert.equal(implementation.sliderTarget(state, 'End'), 100);
    assert.equal(implementation.sliderTarget({ value: '50' }, 'ArrowUp'), 55, 'the default fifth of the range');
    assert.equal(implementation.sliderTarget(state, 'Q'), null);
    assert.equal(implementation.sliderTarget({ value: 'x', min: 0, max: 100 }, 'ArrowUp'), null);
  });

  check('an arithmetic remap crosses a rewritten region', () => {
    const old = ['head', 'a', 'b', 'CLOCK', 'c', 'd', 'tail'];
    assert.deepEqual(implementation.remapIndex(old, old, 3), { index: 3, exact: true });
    assert.deepEqual(
      implementation.remapIndex(old, ['head', 'NEW', 'a', 'b', 'CLOCK', 'c', 'd', 'tail'], 3),
      { index: 4, exact: true },
    );
    assert.deepEqual(
      implementation.remapIndex(old, ['a', 'b', 'NEWCLOCK', 'c', 'd', 'tail'], 3),
      { index: 2, exact: false },
    );
    assert.deepEqual(implementation.remapIndex([], ['a'], 0), { index: 0, exact: false });
  });

  check('a diff collapses consecutive rewrites into one region', () => {
    assert.deepEqual(implementation.diffBlocks(['a', 'b', 'c'], ['a', 'x', 'c']), [{ start: 1, end: 1 }]);
    assert.deepEqual(implementation.diffBlocks(['a', 'b', 'c'], ['x', 'y', 'z']), [{ start: 0, end: 2 }]);
    assert.deepEqual(implementation.diffBlocks(['a'], ['a']), []);
    assert.deepEqual(implementation.diffBlocks([], ['a']), [{ start: 0, end: 0 }]);
  });

  check('a needle naming two blocks is ambiguous', () => {
    assert.equal(implementation.soleBlockContaining(['a 12:04', 'b 12:04'], '12:04'), -1);
    assert.equal(implementation.soleBlockContaining(['a 12:04', 'b'], '12:04'), 0);
    assert.equal(implementation.soleBlockContaining(['x', 'twice twice'], 'twice'), -1);
    assert.equal(implementation.soleBlockContaining(['nothing', 'has it'], 'it'), 1);
  });

  check('a block is found by content in both directions', () => {
    assert.equal(implementation.findBlockWithText(['alpha', 'beta gamma'], 'beta'), 1);
    assert.equal(implementation.findBlockWithText(['alpha', 'beta gamma'], '  beta  '), 1);
    assert.equal(implementation.findBlockWithText(['long enough text here'], 'xx long enough text here yy'), 0);
    assert.equal(implementation.findBlockWithText(['alpha'], ''), -1);
  });

  check('a fragment is the same document at another place', () => {
    assert.equal(implementation.sameDocumentFragment('http://x/a#f1', 'http://x/a#f2'), true);
    assert.equal(implementation.sameDocumentFragment('http://x/a', 'http://x/a#f'), true);
    assert.equal(implementation.sameDocumentFragment('http://x/a#f', 'http://x/a'), false);
    assert.equal(implementation.sameDocumentFragment('http://x/a#f', 'http://x/b#f'), false);
    assert.equal(implementation.sameDocumentFragment('nope', 'nope#f'), false);
  });

  check('identity comes from the element the view numbered', () => {
    assert.equal(implementation.identityOf({ text: 'x', item: { domIndex: 5 } }), '#5');
    assert.equal(implementation.identityOf({ text: 'x', item: { domIndex: 0 } }), '#0');
    assert.equal(implementation.identityOf({ text: 'x', item: { renderIndex: 7 } }), '#7');
    assert.equal(implementation.identityOf({ text: 'x', item: {} }), null);
    assert.equal(implementation.identityOf({ text: 'x' }), null);
  });
}

if (implementations.length > 1) {
  const [javascript, crystal] = implementations;
  for (const [name, script] of Object.entries(scripts)) {
    test(`both runtimes agree: ${name}`, () => {
      assert.deepEqual(crystal.scenario(script), javascript.scenario(script));
    });
  }

  test('Crystal rescans and rebuilds a native page as one core operation', async () => {
    const server = http.createServer();
    const sockets = new Set();
    let snapshots = 0;
    const remote = (value) => {
      if (value === undefined) return { type: 'undefined' };
      if (value === null) return { type: 'null' };
      if (typeof value === 'boolean') return { type: 'boolean', value };
      if (typeof value === 'number') return { type: 'number', value };
      if (typeof value === 'string') return { type: 'string', value };
      if (Array.isArray(value)) return { type: 'array', value: value.map(remote) };
      return { type: 'object', value: Object.entries(value).map(([key, item]) => [key, remote(item)]) };
    };
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.on('upgrade', (request, socket, head) => {
      let peer;
      peer = acceptWebSocket(request, socket, (text) => {
        const message = JSON.parse(text);
        let result = {};
        if (message.method === 'browsingContext.getTree') {
          result = { contexts: [{ context: 'main', url: 'https://example.test/', children: [] }] };
        } else if (message.method === 'script.callFunction') {
          if (message.params.functionDeclaration.includes("Symbol.for('tweb.ax')")) {
            snapshots += 1;
            const names = snapshots === 1
              ? ['alpha', 'clock old', 'omega']
              : ['inserted', 'alpha', 'clock new', 'omega'];
            result = { result: remote(names.map((name, axIndex) => ({
              role: 'heading', level: 1, name, axIndex,
            }))) };
          } else {
            result = { result: remote(undefined) };
          }
        }
        peer.send(JSON.stringify({ id: message.id, type: 'success', result }));
      }, () => {});
      if (head.length) peer.consume(head);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const observed = await crystal.snapshotScenario(`ws://127.0.0.1:${port}/session`, 1);
      assert.deepEqual(observed.first, ['# alpha', '# clock old', '# omega']);
      assert.deepEqual(observed.second, ['# inserted', '# alpha', '# clock new', '# omega']);
      assert.equal(observed.generation, 2);
      assert.equal(observed.settled.block, -1);
      assert.deepEqual(observed.regions.map(({ start, end }) => ({ start, end })), [
        { start: 0, end: 0 }, { start: 2, end: 2 },
      ]);
      assert.ok(observed.cost >= 0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('Crystal asks a lazy feed for more and puts a barren scroll back', async () => {
    const server = http.createServer();
    const sockets = new Set();
    const calls = new Map();
    const remote = (value) => {
      if (value === undefined) return { type: 'undefined' };
      if (value === null) return { type: 'null' };
      if (typeof value === 'boolean') return { type: 'boolean', value };
      if (typeof value === 'number') return { type: 'number', value };
      if (typeof value === 'string') return { type: 'string', value };
      if (Array.isArray(value)) return { type: 'array', value: value.map(remote) };
      return { type: 'object', value: Object.entries(value).map(([key, item]) => [key, remote(item)]) };
    };
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.on('upgrade', (request, socket, head) => {
      const mode = request.url.startsWith('/grow') ? 'grow'
        : request.url.startsWith('/stuck') ? 'stuck' : 'static';
      const tally = { counts: 0, restores: 0 };
      calls.set(mode, tally);
      let peer;
      peer = acceptWebSocket(request, socket, (text) => {
        const message = JSON.parse(text);
        let result = {};
        if (message.method === 'script.callFunction') {
          const declaration = message.params.functionDeclaration;
          if (declaration.includes('scrollingElement')) {
            result = { result: remote(mode === 'static'
              ? { elements: 5, scrollable: false, moved: false, target: 'nothing' }
              : { elements: 10, scrollable: true, moved: mode === 'grow', target: 'document' }) };
          } else if (declaration.includes('getElementsByTagName')) {
            tally.counts += 1;
            result = { result: remote(tally.counts > 1 && mode === 'grow' ? 12 : 10) };
          } else if (declaration.includes('undo')) {
            tally.restores += 1;
            result = { result: remote(true) };
          }
        }
        peer.send(JSON.stringify({ id: message.id, type: 'success', result }));
      }, () => {});
      if (head.length) peer.consume(head);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const grown = await crystal.moreScenario(`ws://127.0.0.1:${port}/grow`);
      assert.deepEqual(grown, {
        grew: true, scrollable: true, moved: true, target: 'document', exhausted: false,
      });
      const stuck = await crystal.moreScenario(`ws://127.0.0.1:${port}/stuck`);
      assert.deepEqual(stuck, {
        grew: false, scrollable: true, moved: false, target: 'document', exhausted: true,
      });
      const still = await crystal.moreScenario(`ws://127.0.0.1:${port}/static`);
      assert.deepEqual(still, {
        grew: false, scrollable: false, moved: false, target: 'nothing', exhausted: true,
      });
      assert.equal(calls.get('grow').restores, 0);
      assert.ok(calls.get('grow').counts >= 2);
      assert.equal(calls.get('stuck').restores, 1);
      assert.ok(calls.get('stuck').counts >= 2);
      assert.equal(calls.get('static').restores, 1);
      assert.equal(calls.get('static').counts, 0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('Crystal downloads a link and follows a fragment to its block', async () => {
    const server = http.createServer();
    const sockets = new Set();
    const wire = { performActions: 0, releaseActions: 0, altKey: false };
    const remote = (value) => {
      if (value === undefined) return { type: 'undefined' };
      if (value === null) return { type: 'null' };
      if (typeof value === 'boolean') return { type: 'boolean', value };
      if (typeof value === 'number') return { type: 'number', value };
      if (typeof value === 'string') return { type: 'string', value };
      if (Array.isArray(value)) return { type: 'array', value: value.map(remote) };
      return { type: 'object', value: Object.entries(value).map(([key, item]) => [key, remote(item)]) };
    };
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.on('upgrade', (request, socket, head) => {
      let peer;
      peer = acceptWebSocket(request, socket, (text) => {
        const message = JSON.parse(text);
        let result = {};
        if (message.method === 'browsingContext.getTree') {
          result = { contexts: [{ context: 'main', url: 'https://example.test/', children: [] }] };
        } else if (message.method === 'script.callFunction') {
          const declaration = message.params.functionDeclaration;
          if (declaration.includes("Symbol.for('tweb.ax')")) {
            result = { result: { type: 'node', handle: 'h-1', sharedId: 's-1' } };
          } else if (declaration.includes('scrollIntoView')) {
            result = { result: remote({ ok: true, x: 10, y: 20, fromX: 10, fromY: 10 }) };
          } else if (declaration.includes("getAttribute('href')")) {
            result = { result: remote('#main-content') };
          } else if (declaration.includes('getElementById')) {
            const hash = message.params.arguments[0]?.value;
            result = { result: hash === 'main-content' ? remote('Annual report') : { type: 'null' } };
          } else if (declaration.includes('__tweb_wire')) {
            result = { result: remote(wire) };
          }
        } else if (message.method === 'input.performActions') {
          wire.performActions += 1;
          for (const source of message.params.actions) {
            if (source.type !== 'key') continue;
            for (const action of source.actions) {
              if (action.type === 'keyDown' && action.value === '\uE00A') wire.altKey = true;
            }
          }
        } else if (message.method === 'input.releaseActions') {
          wire.releaseActions += 1;
        }
        peer.send(JSON.stringify({ id: message.id, type: 'success', result }));
      }, () => {});
      if (head.length) peer.consume(head);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const observed = await crystal.fragmentScenario(`ws://127.0.0.1:${port}/session`);
      assert.deepEqual(observed.notLink, {
        ok: false, reason: 'this line is not a link',
      });
      assert.deepEqual(observed.download, { ok: true });
      assert.equal(observed.fragment, 'main-content');
      assert.equal(observed.block, 1);
      assert.equal(observed.missing, -1);
      assert.deepEqual(observed.wire, { performActions: 1, releaseActions: 1, altKey: true });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('Crystal follows navigation and load state across a scripted page', async () => {
    const server = http.createServer();
    const sockets = new Set();
    let entries = 0;
    const remote = (value) => {
      if (value === undefined) return { type: 'undefined' };
      if (value === null) return { type: 'null' };
      if (typeof value === 'boolean') return { type: 'boolean', value };
      if (typeof value === 'number') return { type: 'number', value };
      if (typeof value === 'string') return { type: 'string', value };
      if (Array.isArray(value)) return { type: 'array', value: value.map(remote) };
      return { type: 'object', value: Object.entries(value).map(([key, item]) => [key, remote(item)]) };
    };
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.on('upgrade', (request, socket, head) => {
      let peer;
      const event = (method, params) => peer.send(JSON.stringify({ type: 'event', method, params }));
      peer = acceptWebSocket(request, socket, (text) => {
        const message = JSON.parse(text);
        let result = {};
        if (message.method === 'browsingContext.navigate') {
          result = { navigation: 'nav-1', url: 'https://next.test/deep' };
          event('browsingContext.navigationStarted', { context: 'main', url: 'https://next.test/deep' });
          event('browsingContext.load', { context: 'main', url: 'https://next.test/deep' });
        } else if (message.method === 'script.callFunction') {
          const declaration = message.params.functionDeclaration;
          if (declaration.includes('currentEntry')) {
            entries += 1;
            result = { result: remote(entries === 1 ? 'entry-1' : 'entry-2') };
          } else if (declaration.includes('history.go')) {
            result = { result: { type: 'undefined' } };
          } else if (declaration.includes('readyState')) {
            result = { result: remote('complete') };
          } else if (declaration.includes('location.href')) {
            result = { result: remote('https://next.test/deeper') };
          }
        }
        peer.send(JSON.stringify({ id: message.id, type: 'success', result }));
      }, () => {});
      if (head.length) peer.consume(head);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const observed = await crystal.navigationScenario(`ws://127.0.0.1:${port}/session`);
      assert.deepEqual(observed, {
        goto: 'https://next.test/deep',
        waited: true,
        moved: true,
        history: 'https://next.test/deeper',
        fragment: true,
        navigated: true,
        same: true,
      });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('Crystal runs a live cycle: patch, guard, and re-anchored refresh', async () => {
    const server = http.createServer();
    const sockets = new Set();
    let snapshots = 0;
    const remote = (value) => {
      if (value === undefined) return { type: 'undefined' };
      if (value === null) return { type: 'null' };
      if (typeof value === 'boolean') return { type: 'boolean', value };
      if (typeof value === 'number') return { type: 'number', value };
      if (typeof value === 'string') return { type: 'string', value };
      if (Array.isArray(value)) return { type: 'array', value: value.map(remote) };
      return { type: 'object', value: Object.entries(value).map(([key, item]) => [key, remote(item)]) };
    };
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.on('upgrade', (request, socket, head) => {
      let peer;
      peer = acceptWebSocket(request, socket, (text) => {
        const message = JSON.parse(text);
        let result = {};
        if (message.method === 'browsingContext.getTree') {
          result = { contexts: [{ context: 'main', url: 'https://example.test/', children: [] }] };
        } else if (message.method === 'script.callFunction') {
          if (message.params.functionDeclaration.includes("Symbol.for('tweb.ax')")) {
            snapshots += 1;
            const names = snapshots === 1
              ? ['alpha', 'clock old', 'omega']
              : snapshots === 2 ? ['alpha', 'clock new', 'omega'] : ['alpha', 'clock final', 'omega'];
            result = { result: remote(names.map((name, axIndex) => ({
              role: 'heading', level: 1, name, axIndex,
            }))) };
          } else {
            result = { result: remote(undefined) };
          }
        }
        peer.send(JSON.stringify({ id: message.id, type: 'success', result }));
      }, () => {});
      if (head.length) peer.consume(head);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const observed = await crystal.liveCycleScenario(`ws://127.0.0.1:${port}/session`);
      assert.deepEqual(observed.patched, [1]);
      assert.deepEqual(observed.settled, { block: 1, exact: true });
      assert.deepEqual(observed.regions.map(({ start, end }) => ({ start, end })), [{ start: 1, end: 1 }]);
      assert.equal(observed.announced, 1);
      assert.equal(observed.dirtyAfter, false);
      assert.equal(observed.undone, true);
      assert.equal(observed.kept, -1);
      assert.equal(observed.refreshes, 2);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}
