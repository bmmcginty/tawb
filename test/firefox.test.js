'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  MARIONETTE_TIMEOUT_MS, libraryParentScript, firefoxRuntimeInfo, CLEAR_SCRIPT,
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

// The probe page answers each scripted reading in turn and then repeats the
// last one, because the check re-asks the same page rather than asking once.
function webdriverProbe(answers) {
  let closed = false;
  let options = null;
  let asked = 0;
  const page = {
    async evaluate() {
      const answer = answers[Math.min(asked, answers.length - 1)];
      asked += 1;
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
    asked: () => asked,
  };
}

// A clock the check drives itself, so no test waits out a real window.
function testClock() {
  let clock = 0;
  return { now: () => clock, sleep: async (ms) => { clock += Math.max(ms, 1); } };
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

test('a bot flag still true after the confirmation window is a real failure', async () => {
  const events = [];
  const probe = webdriverProbe([{ readyState: 'complete', webdriver: true }]);
  assert.equal(await verifyWebdriverFlag(probe.context, {
    confirmMs: 1000, pollMs: 200, ...testClock(), log: (event, detail) => events.push({ event, detail }),
  }), true);
  assert.equal(probe.closed(), true);

  // The page was re-asked rather than believed once.
  assert.ok(probe.asked() > 1, `expected more than one reading, got ${probe.asked()}`);
  const phases = events.filter((e) => e.event === 'firefox.automation.page')
    .map((e) => e.detail.phase);
  assert.equal(phases[0], 'new-after-session-clear');
  assert.equal(phases[1], 'new-after-session-clear-recheck');
  assert.equal(phases[phases.length - 1], 'new-after-session-clear-confirmed');
});

test('a bot flag that turns false during the confirmation window is not a failure', async () => {
  const events = [];
  // Shared data is flushed from the parent process to each content process, so
  // the page can answer with the value from before the clear and then with the
  // value after it.
  const probe = webdriverProbe([
    { readyState: 'complete', webdriver: true },
    { readyState: 'complete', webdriver: true },
    { readyState: 'complete', webdriver: false },
  ]);

  assert.equal(await verifyWebdriverFlag(probe.context, {
    confirmMs: 1000, pollMs: 200, ...testClock(), log: (event, detail) => events.push({ event, detail }),
  }), false);
  assert.equal(probe.asked(), 3);
  assert.equal(probe.closed(), true);

  const readings = events.filter((e) => e.event === 'firefox.automation.page')
    .map((e) => e.detail.state.webdriver);
  assert.deepEqual(readings, [true, true, false]);
});

test('a false bot flag is taken as final without waiting out the window', async () => {
  const probe = webdriverProbe([{ readyState: 'complete', webdriver: false }]);
  assert.equal(await verifyWebdriverFlag(probe.context, {
    confirmMs: 1000, pollMs: 200, ...testClock(),
  }), false);
  assert.equal(probe.asked(), 1);
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

// A stand-in for the parent process the clear script and the parent agent
// both run in. Only the pieces the automation report reads are present, so a
// report that starts reading something else fails here rather than in a
// container nobody can attach a debugger to.
function chromeStub({
  shared = {}, marionetteRunning = false, remoteAgentRunning = false,
  appinfo = {}, childCount = 4, interfaces = ['nsIMarionette', 'nsIRemoteAgent'],
} = {}) {
  const map = new Map(Object.entries(shared));
  const Services = {
    ppmm: {
      childCount,
      sharedData: {
        get: (name) => map.get(name),
        set: (name, value) => map.set(name, value),
        flush: () => {},
        keys: () => map.keys(),
      },
    },
    appinfo: {
      browserTabsRemoteAutostart: true,
      fissionAutostart: true,
      maxWebProcessCount: 8,
      ...appinfo,
    },
  };
  const services = {
    '@mozilla.org/remote/marionette;1': { running: marionetteRunning },
    '@mozilla.org/remote/agent;1': { running: remoteAgentRunning },
  };
  const Ci = Object.fromEntries(interfaces.map((name) => [name, { name }]));
  const Cc = new Proxy({}, {
    get: (_target, contract) => ({ getService: () => services[contract] || null }),
  });
  return { Services, Cc, Ci, map };
}

function runClearScript(stub) {
  return new Function('Services', 'Cc', 'Ci', CLEAR_SCRIPT)(stub.Services, stub.Cc, stub.Ci);
}

test('the startup clear reports every shared-data key, not only the two it targets', () => {
  const stub = chromeStub({
    shared: {
      'RemoteAgent:Active': true,
      'Marionette:Active': true,
      'SomeBuild:WebDriverActive': true,
      'Unrelated:Setting': false,
      'Unrelated:Text': 'x'.repeat(400),
    },
  });
  const result = runClearScript(stub);

  assert.deepEqual(result.before, {
    'RemoteAgent:Active': true, 'Marionette:Active': true,
  });
  assert.deepEqual(result.after, {
    'RemoteAgent:Active': false, 'Marionette:Active': false,
  });

  // The key this build publishes under a name ACTIVE_KEYS does not carry is
  // the one that survives the clear, and the report names it.
  assert.equal(result.report.shared.count, 5);
  assert.deepEqual(result.report.shared.names, [
    'Marionette:Active', 'RemoteAgent:Active', 'SomeBuild:WebDriverActive',
    'Unrelated:Setting', 'Unrelated:Text',
  ]);
  assert.deepEqual(result.report.shared.active, {
    'SomeBuild:WebDriverActive': true,
    'Unrelated:Text': 'x'.repeat(200),
  });
});

test('the report reads the two services navigator.webdriver actually consults', () => {
  const stub = chromeStub({
    shared: { 'RemoteAgent:Active': true, 'Marionette:Active': true },
    marionetteRunning: true,
    remoteAgentRunning: false,
  });
  const result = runClearScript(stub);

  // Both targeted keys are false and Marionette still reports itself running.
  // Only a reading of nsIMarionette distinguishes that from a stale document.
  assert.deepEqual(result.after, {
    'RemoteAgent:Active': false, 'Marionette:Active': false,
  });
  assert.deepEqual(result.report.services, { marionette: true, remoteAgent: false });
});

test('a build without the WebDriver interfaces reports their absence rather than failing', () => {
  const result = runClearScript(chromeStub({ interfaces: [] }));
  assert.deepEqual(result.report.services, {
    marionette: 'no such interface', remoteAgent: 'no such interface',
  });
  // The clear writes both targeted keys, so an empty map still holds them.
  assert.deepEqual(result.report.shared.names, [
    'Marionette:Active', 'RemoteAgent:Active',
  ]);
  assert.deepEqual(result.report.shared.active, {});
});

test('the report records the process topology the clear depends on', () => {
  const remote = runClearScript(chromeStub({}));
  assert.deepEqual(remote.report.processes, {
    remoteTabs: true, fission: true, maxWebProcesses: 8, children: 4,
  });

  // With no content process the read document runs in the parent process,
  // where the services report their real state and shared data is never
  // consulted, so clearing the keys cannot work at all.
  const parentOnly = runClearScript(chromeStub({
    appinfo: { browserTabsRemoteAutostart: false, fissionAutostart: false },
    childCount: 0,
  }));
  assert.deepEqual(parentOnly.report.processes, {
    remoteTabs: false, fission: false, maxWebProcesses: 8, children: 0,
  });
});

test('an unreadable shared-data map does not cost the rest of the report', () => {
  const stub = chromeStub({ shared: { 'Marionette:Active': true } });
  stub.Services.ppmm.sharedData.keys = () => { throw new Error('no iterator here'); };
  const result = runClearScript(stub);

  assert.deepEqual(result.report.shared, { error: 'no iterator here' });
  assert.deepEqual(result.report.keys, {
    'RemoteAgent:Active': false, 'Marionette:Active': false,
  });
  assert.equal(result.report.processes.children, 4);
});

test('the parent agent reports automation state exactly as the startup clear does', () => {
  const parentScript = libraryParentScript();
  assert.match(parentScript, /const automationReport = \(\) =>/);
  assert.match(parentScript, /return automationReport\(\);/);
  assert.match(parentScript, /report: automationReport\(\)/);
  assert.equal(parentScript.includes('__ACTIVE_KEYS__'), false);
});

test('a reading taken at a failure names its own phase', async () => {
  const events = [];
  const report = {
    keys: { 'RemoteAgent:Active': false, 'Marionette:Active': false },
    shared: { count: 2, names: ['Marionette:Active', 'RemoteAgent:Active'], active: {} },
    services: { marionette: true, remoteAgent: false },
    processes: { remoteTabs: true, fission: true, maxWebProcesses: 8, children: 3 },
  };

  assert.deepEqual(await readAutomationState(4321, 'after-bot-check-failure', {
    ask: async () => report,
    log: (event, detail) => events.push({ event, detail }),
  }), report);
  assert.deepEqual(events, [{
    event: 'firefox.automation.state',
    detail: { phase: 'after-bot-check-failure', state: report },
  }]);
});
