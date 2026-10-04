'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const { resolveDumpTarget, formatAxBlocks, dumpAx } = require('../src/dump');

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
    ['snapshot', page, 'ax', { driver }],
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
