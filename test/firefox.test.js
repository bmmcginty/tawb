'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { MARIONETTE_TIMEOUT_MS } = require('../src/firefox');
const { verifyWebdriverFlag } = require('../src/driver_firefox');

test('Marionette operations allow a slow Firefox a full minute', () => {
  assert.equal(MARIONETTE_TIMEOUT_MS, 60000);
});

function webdriverProbe(answers) {
  let closed = false;
  let options = null;
  const page = {
    async evaluate() {
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer;
    },
    async close() { closed = true; },
  };
  return {
    context: {
      async newPage(given) { options = given; return page; },
    },
    closed: () => closed,
    options: () => options,
  };
}

test('the bot check uses a new post-clear page and waits for it to initialize', async () => {
  const probe = webdriverProbe([
    new Error('content process is not ready'),
    { readyState: 'loading', webdriver: false },
    { readyState: 'complete', webdriver: false },
  ]);

  assert.equal(await verifyWebdriverFlag(probe.context, {
    timeoutMs: 1000, pollMs: 0, sleep: async () => {},
  }), false);
  assert.deepEqual(probe.options(), { background: true });
  assert.equal(probe.closed(), true);
});

test('a true bot flag from the new page is a real failure result', async () => {
  const probe = webdriverProbe([{ readyState: 'complete', webdriver: true }]);
  assert.equal(await verifyWebdriverFlag(probe.context), true);
  assert.equal(probe.closed(), true);
});

test('a page that never becomes evaluable is reported as unfinished startup', async () => {
  let clock = 0;
  const probe = webdriverProbe([new Error('not ready'), new Error('still not ready')]);
  await assert.rejects(
    verifyWebdriverFlag(probe.context, {
      timeoutMs: 10,
      pollMs: 5,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    }),
    /did not finish initializing a page within 0\.01s.*still not ready/s,
  );
  assert.equal(probe.closed(), true);
});
