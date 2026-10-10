'use strict';

// The live observer, against a real Firefox, on both runtimes.
//
//     TAWB_TEST_CRYSTAL_BROWSER=1 TAWB_TEST_CRYSTAL=1 node --test test/browser/live_crystal.test.js
//     xvfb-run -a env TAWB_TEST_CRYSTAL_BROWSER=1 ...   # with no display of your own
//
// The scripted-BiDi tests say what the watcher asks for; only a browser can
// say whether the preload script really arrives before the document does,
// whether a parse on a real page is seen, and whether both runtimes leave
// the page holding the same answer. Each side launches its own Firefox and
// runs the same scenario against the same page, and the mutation phase —
// two character-data replacements, one of them in a live region — must come
// back as the very same batch from both.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { tempDir, removeTempDir } = require('../tmpdir');
const { liveRealImplementations } = require('../crystal_impl');
const live = require('../../src/live');
const { openDriver } = require('../../src/driver');

const enabled = process.env.TAWB_TEST_CRYSTAL_BROWSER === '1';
const implementations = liveRealImplementations(live, { openDriver });

// A page with enough in it that parsing produces mutations to catch, and one
// live region that announces while it loads.
const PAGE = `<!doctype html><meta charset="utf-8"><title>live</title>
<div role="status">Three results</div>
${Array.from({ length: 200 }, (_, i) => `<p>row ${i}</p>`).join('\n')}`;

// Both replacements are character-data edits on existing text nodes, so the
// observer owes exactly two patches, no structural doubt, and one fresh
// announcement from the live region. A real function, not a string: the
// drivers compile bare strings as expressions, and the Crystal side is sent
// this function's own source text.
const MUTATION = () => {
  const status = document.querySelector('[role="status"]');
  status.firstChild.data = 'Five results';
  const p = document.querySelectorAll('p')[7];
  p.firstChild.data = 'row 7, updated';
};

for (const implementation of implementations) {
  test(`${implementation.name}: the observer arms at document-start, reads a parse, and patches a mutation on a real Firefox`, { skip: !enabled }, async () => {
    const profile = tempDir('tawb-live-real-');
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;

    try {
      const result = await implementation.runScenario({
        profile, url, url2: `${url}?second`, mutation: MUTATION, timeoutMs: 60000,
      });

      // The observer was armed on the first document this side touched,
      // before any navigation, and the tab has one frame to drain.
      assert.equal(result.install.boundNow, true);
      assert.equal(result.install.armed, 1);
      assert.equal(result.install.frames, 1);

      // The parse was seen: structure arrived, so the batches are not
      // pure text replacements, and something was announced — the live
      // region was parsed too.
      assert.ok(result.parseBatches.length > 0, 'the parse left no batches');
      assert.ok(result.parseBatches.reduce((sum, b) => sum + b.mutations, 0) > 0,
        'parsing the page was not seen');
      assert.ok(result.parseBatches.every((b) => b.pureText === false),
        'structural parse records must not look like pure text');

      // The mutation phase is the differential: the same page, the same two
      // character-data edits, the same batch expected from each runtime.
      assert.deepEqual(result.mutationBatches, [{
        announcements: [{ politeness: 'polite', text: 'Five results' }],
        mutations: 2,
        patches: [
          { from: 'Three results', to: 'Five results' },
          { from: 'row 7', to: 'row 7, updated' },
        ],
        pureText: true,
      }]);

      // The first pulse is a baseline; the second, after a navigation, is a
      // changed page on the way to being a different one.
      assert.deepEqual(result.pulses, [
        { changed: false, navigated: false, rearmed: false },
        { changed: true, navigated: true, rearmed: false },
      ]);
    } finally {
      server.close();
      removeTempDir(profile);
    }
  });
}
