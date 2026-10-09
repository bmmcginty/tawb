'use strict';

const nodeTest = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const javascript = require('../src/dump');
const { formatLynxBlocks, dumpAx } = javascript;
const { dumpImplementations, readerCommands } = require('./crystal_impl');

for (const implementation of dumpImplementations(javascript)) {
  const { resolveDumpTarget, formatAxBlocks } = implementation;
  const test = (name, fn) => nodeTest(`${implementation.name}: ${name}`, fn);

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
}

nodeTest('the Lynx front end dumps the Lynx presentation, not the AX blocks', () => {
  const blocks = [
    { text: '# Heading', item: { role: 'heading', level: 1, name: 'Heading' } },
    { text: '{Docs}', item: { role: 'link', name: 'Docs', href: 'https://example.test/' } },
  ];

  assert.equal(javascript.formatAxBlocks(blocks), '# Heading\n{Docs}\n');

  const lines = formatLynxBlocks(blocks, { preferences: { numberLinks: true } }).split('\n');
  assert.equal(lines[0].trim(), 'Heading');
  assert.equal(lines[0].length, 36 + 'Heading'.length, 'H1 is not centred in the width');
  assert.equal(lines[1], '   [1]Docs');
});

nodeTest('dump mode asks for layout metadata only for the Lynx front end', async () => {
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

nodeTest('dump mode reads AX after DOM content and closes its temporary tab', async () => {
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

const ROOT = path.join(__dirname, '..');
for (const program of readerCommands(ROOT)) {
  const run = (args) => spawnSync(program.command, [...program.args, ...args], {
    cwd: program.cwd || ROOT,
    env: { ...process.env, XDG_CONFIG_HOME: path.join(__dirname, 'missing-config') },
    encoding: 'utf8',
  });

  nodeTest(`${program.name}: dump mode requires an input without writing terminal output`, () => {
    const result = run(['--dump']);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /--dump needs a URL or HTML file/);
    assert.doesNotMatch(result.stderr, /\x1b/);
  });

  nodeTest(`${program.name}: a front end refuses the reader flags it cannot use`, () => {
    const both = run(['--dump', '--keyboard']);
    assert.equal(both.status, 1);
    assert.match(both.stderr, /--keyboard cannot be combined with --dump/);

    for (const flag of ['--keyboard', '--dump']) {
      const edb = run(['--front-end', 'edb', flag]);
      assert.equal(edb.status, 1);
      assert.match(edb.stderr, /--front-end edb cannot be combined/);
    }
  });
}

nodeTest('dump mode closes its temporary tab when extraction fails', async () => {
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

// The settle is the dump's one wait, and it must be a short one: a child
// frame that commits ends it, a document that completes ends it, two
// seconds end it regardless, and a page without the frame surface is not
// held at all.
nodeTest('the dump settles only while an embedded document is pending', async () => {
  const { settleEmbeddedFrames } = javascript;

  // A child that commits on the third look: the wait ends there, not at the
  // deadline and not before the polls it owed.
  let looks = 0;
  const child = { url: () => (looks <= 2 ? 'about:blank' : 'http://localhost:1/') };
  const committing = {
    mainFrame: () => ({ childFrames: () => { looks += 1; return [child]; } }),
    evaluate: async () => 'loading',
  };
  const started = Date.now();
  await settleEmbeddedFrames(committing, { deadlineMs: 5000, stepMs: 20 });
  assert.ok(Date.now() - started >= 40, 'committed without waiting for the polls');
  assert.ok(looks >= 3, 'gave up on a child that was still pending');

  // A page whose children are all committed is not held at all.
  const settled = {
    mainFrame: () => ({ childFrames: () => [{ url: () => 'http://localhost:1/' }] }),
    evaluate: async () => 'loading',
  };
  const quick = Date.now();
  await settleEmbeddedFrames(settled, { deadlineMs: 5000, stepMs: 20 });
  assert.ok(Date.now() - quick < 100, 'held a page with nothing pending');

  // A document that completes ends the wait even with a placeholder below
  // it: nothing more is coming.
  const complete = {
    mainFrame: () => ({ childFrames: () => [{ url: () => 'about:blank' }] }),
    evaluate: async () => 'complete',
  };
  const done = Date.now();
  await settleEmbeddedFrames(complete, { deadlineMs: 5000, stepMs: 20 });
  assert.ok(Date.now() - done < 100, 'held a document that had completed');

  // A child that never commits and a document that never completes run out
  // the deadline, and then the dump proceeds with what is there.
  const hanging = {
    mainFrame: () => ({ childFrames: () => [{ url: () => 'about:blank' }] }),
    evaluate: async () => 'loading',
  };
  const deadline = Date.now();
  await settleEmbeddedFrames(hanging, { deadlineMs: 150, stepMs: 20 });
  const waited = Date.now() - deadline;
  assert.ok(waited >= 140 && waited < 1000, `ran out the deadline in ${waited}ms`);

  // A page without the frame surface — the fakes above, a driver yet to
  // grow one — is not held at all.
  const bare = Date.now();
  await settleEmbeddedFrames({ evaluate: async () => 'loading' }, { deadlineMs: 150 });
  assert.ok(Date.now() - bare < 100, 'held a page without the frame surface');
});

nodeTest('the dump gives an uncommitted child frame the chance to arrive', async () => {
  // The scenario behind the settle, at the surface dumpAx itself sees: the
  // page reports a placeholder child until the settle has polled, and the
  // snapshot must run only once the child has committed.
  let polls = 0;
  let settledAt = null;
  const page = {
    async goto() {},
    async close() {},
    mainFrame: () => ({
      childFrames: () => {
        polls += 1;
        return [{ url: () => (polls < 3 ? 'about:blank' : 'http://localhost:1/') }];
      },
    }),
    evaluate: async () => 'loading',
  };
  const driver = { context: { async newPage() { return page; } } };
  const snapshot = async () => {
    settledAt = polls;
    return [{ text: 'Body' }];
  };

  await dumpAx({ driver, target: 'https://example.com', snapshot, write: () => {} });
  assert.ok(polls >= 3, 'snapshotted while the child was still pending');
  assert.equal(settledAt, polls, 'the settle ran before the snapshot');
});
