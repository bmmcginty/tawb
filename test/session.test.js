'use strict';

// Who is reading which tab, and in which browser, differenced between the
// JavaScript original and the Crystal port.
//
// Each check runs one scenario script. A step is something a session's
// callers do — claim a tab, release the browser, plant another reader's
// claim in the file, start from the empty file a final release leaves — and
// the observations are what the session then says about the port. The whole
// script runs in one process, because the claims are believed exactly as far
// as the processes that wrote them.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { tempDir } = require('./tmpdir');
const session = require('../src/session');
const { sessionImplementations } = require('./crystal_impl');

const state = tempDir('tweb-session-state-');
process.env.XDG_DATA_HOME = state;

const PORT = 45999;

test.after(() => { fs.rmSync(state, { recursive: true, force: true }); });

for (const implementation of sessionImplementations(session)) {
  const check = (name, fn) => test(`${implementation.name}: ${name}`, fn);

  check('a session that is alone in a browser knows it', async () => {
    const observations = await implementation.scenario({
      script: [
        { op: 'reset', port: PORT },
        { op: 'claim', port: PORT, target: 'tab-1' },
        { op: 'other_readers', port: PORT },
        { op: 'release', port: PORT },
      ],
    });
    assert.deepEqual(observations, [false], 'its own claim looked like somebody else');
  });

  check('a browser with another live reader in it is not ours to close', async () => {
    const observations = await implementation.scenario({
      script: [
        { op: 'reset', port: PORT },
        { op: 'claim', port: PORT, target: 'tab-1' },
        { op: 'inject', port: PORT, who: 'parent', target: 'tab-2' },
        { op: 'other_readers', port: PORT },
        { op: 'claimed', port: PORT },
        { op: 'release', port: PORT },
      ],
    });
    assert.deepEqual(observations, [true, ['tab-2']],
      "the other reader's tab looked free, or our own looked taken");
  });

  check('a claim from a reader that has died holds nothing', async () => {
    const observations = await implementation.scenario({
      script: [
        { op: 'reset', port: PORT },
        { op: 'inject', port: PORT, who: 'dead', target: 'tab-3' },
        { op: 'other_readers', port: PORT },
        { op: 'claimed', port: PORT },
      ],
    });
    assert.deepEqual(observations, [false, []],
      'a dead reader kept a browser or a tab alive');
  });

  check("a browser nothing was ever claimed in is nobody else's", async () => {
    const observations = await implementation.scenario({
      script: [
        { op: 'other_readers', port: 0 },
        { op: 'other_readers', port: 45123 },
      ],
    });
    assert.deepEqual(observations, [false, false]);
  });
}
