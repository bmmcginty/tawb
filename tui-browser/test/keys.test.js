'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { Keymap, readTerminfo } = require('../src/keys');

test('terminfo key sequences are added to the portable fallbacks', () => {
  const calls = [];
  const terminfo = readTerminfo({
    env: { TERM: 'friend-terminal' },
    run: (_command, [capability]) => {
      calls.push(capability);
      return capability === 'knp'
        ? { status: 0, stdout: Buffer.from('\x1b[999~') }
        : { status: 1, stdout: Buffer.alloc(0) };
    },
  });
  const keys = new Keymap({ terminfo });
  assert.ok(calls.includes('knp'));
  assert.equal(keys.actionFor('\x1b[999~'), 'next-screen');
  assert.equal(keys.actionFor('\x1b[6~'), 'next-screen');
  assert.equal(keys.sequenceNames.get('\x1b[999~'), 'PageDown');
});
