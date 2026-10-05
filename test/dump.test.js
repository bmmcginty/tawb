'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const { resolveDumpTarget, formatAxBlocks, formatLynxBlocks, dumpAx } = require('../src/dump');

test('dump targets accept mailcap file paths and web addresses', () => {
  const cwd = path.join(path.sep, 'mail', 'tmp');
  const file = path.join(cwd, 'message with spaces.html');
  const exists = (candidate) => candidate === file;

  assert.equal(
    resolveDumpTarget('message with spaces.html', { cwd, exists }),
    pathToFileURL(file).href,
  );
  assert.equal(
    resolveDumpTarget('example.com', { cwd, exists }),
    'https://example.com',
  );
  assert.throws(() => resolveDumpTarget(null, { cwd, exists }),
    /--dump needs a URL or HTML file/);
});

test('AX blocks become an unadorned stdout stream', () => {
  const blocks = [{ text: 'A heading' }, { text: '{A link}' }];
  assert.equal(formatAxBlocks(blocks), 'A heading\n{A link}\n');
  assert.equal(formatAxBlocks([]), '');
  assert.equal(formatAxBlocks([{ text: 'café 😀' }], { escapeUnicode: true }),
    'caf\\u00E9 \\U0001F600\n');
});

test('the Lynx front end dumps the Lynx presentation, not the AX blocks', () => {
  const blocks = [
    { text: '# Heading', item: { role: 'heading', level: 1, name: 'Heading' } },
    { text: '{Docs}', item: { role: 'link', name: 'Docs', href: 'https://example.test/' } },
  ];

  // The ordinary front end prints each block as it reads.
  assert.equal(formatAxBlocks(blocks), '# Heading\n{Docs}\n');

  // The Lynx front end names the heading, numbers the link, and gives both
  // the document margin; the heading is centred for its level.
  const lines = formatLynxBlocks(blocks, { preferences: { numberLinks: true } }).split('\n');
  assert.equal(lines[0].trim(), 'Heading');
  assert.equal(lines[0].length, 36 + 'Heading'.length, 'H1 is not centred in the width');
  assert.equal(lines[1], '   [1]Docs');
});

test('dump mode asks for layout metadata only for the Lynx front end', async () => {
  const seen = [];
  const page = { async goto() {}, async close() {} };
  const driver = { context: { async newPage() { return page; } } };
  const snapshot = async (seenPage, view, options) => {
    seen.push(options.layout);
    return [{ text: 'Body' }];
  };

  await dumpAx({ driver, target: 'file:///x', frontEnd: 'lynx', snapshot, write: () => {} });
  await dumpAx({ driver, target: 'file:///x', frontEnd: 'default', snapshot, write: () => {} });
  assert.deepEqual(seen, [true, false]);
});

test('dump mode reads AX after DOM content and closes its temporary tab', async () => {
  const calls = [];
  const page = {
    async goto(target, options) { calls.push(['goto', target, options]); },
    async close() { calls.push(['close']); },
  };
  const driver = { context: { async newPage() { calls.push(['newPage']); return page; } } };
  let written = '';

  await dumpAx({
    driver,
    target: 'file:///tmp/message.html',
    write: (text) => { written += text; },
    snapshot: async (seenPage, view, options) => {
      calls.push(['snapshot', seenPage, view, options]);
      return [{ text: 'Mail body' }];
    },
  });

  assert.equal(written, 'Mail body\n');
  assert.deepEqual(calls, [
    ['newPage'],
    ['goto', 'file:///tmp/message.html', { waitUntil: 'domcontentloaded' }],
    ['snapshot', page, 'ax', { driver, layout: false }],
    ['close'],
  ]);
});

test('dump mode requires an input without writing terminal output', () => {
  const result = spawnSync(process.execPath, ['src/index.js', '--dump'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, XDG_CONFIG_HOME: path.join(__dirname, 'missing-config') },
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--dump needs a URL or HTML file/);
  assert.doesNotMatch(result.stderr, /\x1b/);
});

test('a front end refuses the reader flags it cannot use', () => {
  const run = (args) => spawnSync(process.execPath, ['src/index.js', ...args], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, XDG_CONFIG_HOME: path.join(__dirname, 'missing-config') },
    encoding: 'utf8',
  });

  const both = run(['--dump', '--keyboard']);
  assert.equal(both.status, 1);
  assert.match(both.stderr, /--keyboard cannot be combined with --dump/);

  // edbrowse has neither a keymap nor a reading buffer for these to act on.
  for (const flag of ['--keyboard', '--dump']) {
    const edb = run(['--front-end', 'edb', flag]);
    assert.equal(edb.status, 1);
    assert.match(edb.stderr, /--front-end edb cannot be combined/);
  }
});

test('dump mode closes its temporary tab when extraction fails', async () => {
  let closed = false;
  const page = {
    async goto() {},
    async close() { closed = true; },
  };
  const driver = { context: { async newPage() { return page; } } };

  await assert.rejects(
    dumpAx({ driver, target: 'https://example.com', snapshot: async () => { throw new Error('broken'); } }),
    /broken/,
  );
  assert.equal(closed, true);
});
