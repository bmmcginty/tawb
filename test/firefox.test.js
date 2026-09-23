'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  MARIONETTE_TIMEOUT_MS, libraryParentScript, firefoxRuntimeInfo,
} = require('../src/firefox');
const {
  readAutomationState, clearWebdriverAfterSession, verifyWebdriverFlag,
} = require('../src/driver_firefox');

test('Marionette operations allow a slow Firefox a full minute', () => {
  assert.equal(MARIONETTE_TIMEOUT_MS, 60000);
});

test('the parent agent can clear automation keys after the BiDi session starts', async () => {
  const calls = [];
  const events = [];
  const result = await clearWebdriverAfterSession(4321, {
    ask: async (port, request) => {
      calls.push({ port, request });
      return {
        before: { 'RemoteAgent:Active': true, 'Marionette:Active': false },
        after: { 'RemoteAgent:Active': false, 'Marionette:Active': false },
      };
    },
    log: (event, detail) => events.push({ event, detail }),
  });

  assert.deepEqual(calls, [{ port: 4321, request: { kind: 'clearAutomation' } }]);
  assert.deepEqual(result, {
    before: { 'RemoteAgent:Active': true, 'Marionette:Active': false },
    after: { 'RemoteAgent:Active': false, 'Marionette:Active': false },
  });
  assert.equal(events[0].event, 'firefox.automation.session-cleared');

  const parentScript = libraryParentScript();
  assert.match(parentScript, /const automationState = async function/);
  assert.match(parentScript, /const clearAutomation = async function/);
  assert.match(parentScript, /\["RemoteAgent:Active","Marionette:Active"\]/);
  assert.equal(parentScript.includes('__ACTIVE_KEYS__'), false);
});

test('automation keys can be observed without changing them', async () => {
  const events = [];
  const state = { 'RemoteAgent:Active': false, 'Marionette:Active': true };
  assert.deepEqual(await readAutomationState(4321, 'after-session-new', {
    ask: async (port, request) => {
      assert.equal(port, 4321);
      assert.deepEqual(request, { kind: 'automationState' });
      return state;
    },
    log: (event, detail) => events.push({ event, detail }),
  }), state);
  assert.deepEqual(events, [{
    event: 'firefox.automation.state',
    detail: { phase: 'after-session-new', state },
  }]);
});

test('Firefox runtime diagnostics identify the executable and container build', () => {
  const info = firefoxRuntimeInfo('/path/that/does/not/exist/firefox', {
    TAWB_IMAGE_REVISION: 'image-42',
  });
  assert.equal(info.executable, '/path/that/does/not/exist/firefox');
  assert.equal(info.resolvedExecutable, info.executable);
  assert.equal(info.node, process.version);
  assert.equal(info.platform, process.platform);
  assert.equal(info.arch, process.arch);
  assert.equal(info.imageRevision, 'image-42');
});

test('failure to repeat the clear is logged for the authoritative page check', async () => {
  const events = [];
  assert.equal(await clearWebdriverAfterSession(4321, {
    ask: async () => { throw new Error('agent unavailable'); },
    log: (event, detail) => events.push({ event, detail }),
  }), null);
  assert.deepEqual(events, [{
    event: 'firefox.automation.session-clear-error',
    detail: { error: 'agent unavailable' },
  }]);
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
